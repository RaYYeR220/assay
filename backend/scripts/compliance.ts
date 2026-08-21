/**
 * compliance.ts — how reliably does each candidate model emit EXACTLY
 * `ASSAY1|nav_usd_e6=<int>|confidence_bps=<int>` and nothing else?
 *
 *   node --experimental-strip-types scripts/compliance.ts [--samples 5] [--asset <id>] [--all-tee]
 *
 * `response_format` is deliberately NOT used: it is absent from the on-chain schema, so
 * sending it would change the request bytes and break every signature. Compliance is
 * therefore a pure prompt-adherence property, and it must be MEASURED, not assumed.
 *
 * Non-compliance is a feature — it becomes a visible on-chain rejection rather than a bad
 * price. But a model that fails often is a wasted committee slot, so we need the numbers
 * before seating anyone. Temperature is pinned at 0 by the schema, so the residual variance
 * is the model's own nondeterminism (MoE routing, batching), which is exactly what we want
 * to quantify.
 *
 * Writes data/compliance.json.
 */

import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatRaw, getSignature, getAttestation, listModels } from '../src/redpill.ts';
import {
  buildRequestString, sha256Hex, parseResponseOnChain, verifyReceipt,
  type RejectReason,
} from '../src/canonical.ts';
import { buildEvidence, loadAsset, listAssets } from '../src/evidence.ts';
import { committeeSlots } from '../src/appraise.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

function loadApiKey(): string {
  if (process.env.REDPILL_API_KEY) return process.env.REDPILL_API_KEY;
  for (const p of [join(HERE, '..', '..', '..', 'internal', '.env'), join(HERE, '..', '.env')]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^REDPILL_API_KEY=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  throw new Error('REDPILL_API_KEY not set (env or internal/.env)');
}

const argv = process.argv.slice(2);
const numOpt = (n: string, d: number) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const strOpt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? d : d; };

interface Sample {
  i: number;
  httpStatus: number;
  latencyMs: number;
  /** The assistant text, extracted loosely for diagnosis (NOT the on-chain path). */
  content: string | null;
  accepted: boolean;
  reason: RejectReason;
  detail: string | null;
  navE6: string | null;
  confBps: number | null;
  signatureOk: boolean | null;
  /**
   * Bytes of trailing whitespace the contract had to skip. 0 = byte-perfect.
   * Non-zero is still ACCEPTED — separated only so we can see who needs the tolerance.
   */
  trailingWhitespaceBytes: number | null;
  /** How the model failed, bucketed for the report. Null when accepted. */
  failureMode: string | null;
}

/** Loose extraction for diagnosis only — tells us HOW a model misbehaved. */
function looseContent(body: string): string | null {
  try {
    const j = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? null;
  } catch { return null; }
}

function classify(content: string | null, reason: RejectReason, detail: string | null): string {
  if (content === null) return 'no-content (API error or unparseable body)';
  const c = content;
  if (reason === 'Truncated') return 'truncated (finish_reason != stop)';
  if (/^```/.test(c.trim())) return 'markdown code fence';
  if (/^\s+ASSAY1/.test(c)) return 'leading whitespace';
  if (/ASSAY1\|nav_usd_e6=\d+\|confidence_bps=\d+\s*\S/.test(c)) return 'trailing commentary after the line';
  if (/^[^A]/.test(c.trim()) && c.includes('ASSAY1')) return 'prose preamble before the line';
  if (!c.includes('ASSAY1')) return 'ignored the format entirely (prose or JSON)';
  if (/nav_usd_e6=\d+\.\d/.test(c)) return 'decimal nav (must be an integer)';
  if (/<think>|<\|/.test(c)) return 'reasoning trace leaked into content';
  if (reason === 'OutOfRange') return `out of range (${detail ?? ''})`;
  return `other malformed: ${detail ?? ''}`;
}

async function sampleModel(model: string, evidence: string, n: number, apiKey: string): Promise<Sample[]> {
  const requestBody = buildRequestString(model, evidence);
  const requestSha = sha256Hex(requestBody);
  const att = await getAttestation(model).catch(() => ({}) as Awaited<ReturnType<typeof getAttestation>>);
  const attestedSigner = att.signing_address ?? null;
  const out: Sample[] = [];

  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    try {
      const res = await chatRaw(requestBody, apiKey);
      const latencyMs = Date.now() - t0;
      const content = looseContent(res.responseBody);
      const p = parseResponseOnChain(res.responseBody);

      let signatureOk: boolean | null = null;
      if (res.receiptId && attestedSigner) {
        // Fetch immediately: 1h in-memory TTL, owned by sha256(bearer).
        for (let a = 0; a < 3 && signatureOk === null; a++) {
          try {
            const sr = await getSignature(res.receiptId, 'ecdsa', apiKey);
            if (sr.signature && /^0x[0-9a-fA-F]{130}$/.test(sr.signature)) {
              const v = await verifyReceipt(
                { requestBody, responseBody: res.responseBody, signature: sr.signature as `0x${string}` },
                attestedSigner,
              );
              signatureOk = v.ok;
            }
          } catch { /* retry */ }
          if (signatureOk === null) await new Promise((r) => setTimeout(r, 1000));
        }
      }

      out.push({
        i,
        httpStatus: res.status,
        latencyMs,
        content,
        accepted: p.ok,
        reason: p.reason,
        detail: p.detail ?? null,
        navE6: p.parsed?.navE6.toString() ?? null,
        confBps: p.parsed?.confBps ?? null,
        signatureOk,
        trailingWhitespaceBytes: p.parsed?.trailingWhitespaceBytes ?? null,
        failureMode: p.ok ? null : classify(content, p.reason, p.detail ?? null),
      });
    } catch (e) {
      out.push({
        i, httpStatus: 0, latencyMs: Date.now() - t0, content: null, accepted: false,
        reason: 'Malformed', detail: (e as Error).message, navE6: null, confBps: null,
        signatureOk: null, trailingWhitespaceBytes: null,
        failureMode: `transport: ${(e as Error).message}`,
      });
    }
  }
  void requestSha;
  return out;
}

async function main() {
  const apiKey = loadApiKey();
  const samples = numOpt('--samples', 5);
  const assetId = strOpt('--asset', listAssets()[0] ?? '');
  const ev = buildEvidence(loadAsset(assetId));

  let models = committeeSlots();
  if (argv.includes('--all-tee')) {
    const all = await listModels();
    const signable: string[] = [];
    for (const m of all.filter((x) => x.is_tee)) {
      const a = await getAttestation(m.id).catch(() => ({}) as Awaited<ReturnType<typeof getAttestation>>);
      if (a.signing_address) signable.push(m.id);
    }
    models = signable;
  }

  console.log(`asset ${assetId}, ${samples} samples x ${models.length} models, temperature pinned at 0 by the schema\n`);

  const results = [];
  for (const model of models) {
    const s = await sampleModel(model, ev.line, samples, apiKey);
    const ok = s.filter((x) => x.accepted).length;
    // The contract accepts up to 8 items of trailing whitespace, so both of these are
    // PASSES. Split only to show which models emit a byte-perfect line unaided and which
    // rely on the tolerance — that is a robustness signal, not a failure.
    const exact = s.filter((x) => x.accepted && x.trailingWhitespaceBytes === 0).length;
    const withWs = ok - exact;
    const navs = s.filter((x) => x.navE6).map((x) => BigInt(x.navE6!));
    const distinctNavs = new Set(navs.map(String)).size;
    const sigOk = s.filter((x) => x.signatureOk === true).length;
    const modes = [...new Set(s.map((x) => x.failureMode).filter(Boolean))] as string[];
    const avgMs = Math.round(s.reduce((a, b) => a + b.latencyMs, 0) / s.length);

    results.push({
      model,
      samples: s.length,
      acceptedOnChain: ok,
      complianceRate: ok / s.length,
      exactFormat: exact,
      exactFormatRate: exact / s.length,
      acceptedWithTrailingWhitespace: withWs,
      signaturesVerified: sigOk,
      avgLatencyMs: avgMs,
      distinctNavs,
      /** temperature 0 does NOT guarantee determinism on MoE/batched inference. */
      deterministic: distinctNavs <= 1,
      navsE6: navs.map(String),
      failureModes: modes,
      raw: s,
    });

    console.log(
      `${model.padEnd(34)} ${ok}/${s.length} accepted (${exact} exact` +
        `${withWs ? `, ${withWs} +trailing-ws` : ''})  sig ${sigOk}/${s.length}  ` +
        `${String(avgMs).padStart(6)}ms  distinctNavs=${distinctNavs}` +
        `${modes.length ? '  ' + modes.join(' | ') : ''}`,
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    assetId,
    samplesPerModel: samples,
    note:
      'response_format is NOT sent — it is absent from the on-chain schema and would break every ' +
      'signature. temperature=0 and max_tokens=512 are pinned inside the schema. ' +
      'acceptedOnChain counts every verdict the contract accepts; exactFormat is the subset that ' +
      'needed no trailing-whitespace tolerance. Both are passes.',
    results,
  };
  writeFileSync(join(DATA, 'compliance.json'), JSON.stringify(out, null, 2) + '\n');

  console.log('\nRECOMMENDED COMMITTEE (compliance desc, then latency asc):');
  for (const r of [...results].sort((a, b) => b.complianceRate - a.complianceRate || a.avgLatencyMs - b.avgLatencyMs).slice(0, 8)) {
    console.log(`  ${(r.complianceRate * 100).toFixed(0).padStart(3)}%  ${r.model}`);
  }
  console.log(`\nwrote ${join(DATA, 'compliance.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
