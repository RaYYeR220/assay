/**
 * probe-live.ts — the live byte-exactness experiment. Run the moment REDPILL_API_KEY exists.
 *
 *   node --experimental-strip-types scripts/probe-live.ts [--model <id>] [--asset <id>]
 *
 * Gateway source (Dstack-TEE/private-ai-gateway @ 30296dd) says the signed request bytes are
 * our RAW WIRE BYTES, verbatim. This script PROVES it rather than assuming it: it brute-forces
 * a candidate set on each side and reports which candidate makes ecrecover land on the attested
 * signer. Whatever wins IS the ground truth.
 *
 * It also cross-checks the gateway's own `text` field against our locally computed
 * `sha256hex(req):sha256hex(resp)` — a mismatch there localises the problem instantly.
 *
 * Writes data/fixtures/receipt-*.json (replayed by the test suite) and data/byte-exactness.json.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';

import { chatRaw, getSignature, getAttestation } from '../src/redpill.ts';
import {
  buildRequestString, sha256Hex, verifyReceipt, parseResponseOnChain,
  findVerdictOffsets, preflightVerdict, SCHEMA_ID,
} from '../src/canonical.ts';
import { buildEvidence, loadAsset, listAssets } from '../src/evidence.ts';
import { committeeSlots } from '../src/appraise.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const FIXTURES = join(DATA, 'fixtures');

function loadApiKey(): string {
  if (process.env.REDPILL_API_KEY) return process.env.REDPILL_API_KEY;
  for (const p of [join(HERE, '..', '..', '..', 'internal', '.env'), join(HERE, '..', '.env')]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^REDPILL_API_KEY=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  throw new Error('REDPILL_API_KEY not set (env or internal/.env)');
}

/** BigInt is not JSON-serialisable; the parsed nav is a bigint. */
function jsonSafe(o: unknown): string {
  return JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + String.fromCharCode(10);
}

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? d : d; };

/** Candidate request byte strings the gateway might have hashed. */
function requestCandidates(wire: string): { label: string; bytes: string }[] {
  const obj = JSON.parse(wire) as Record<string, unknown>;
  const drop = (k: string) => { const o = { ...obj }; delete o[k]; return JSON.stringify(o); };
  const c = [
    { label: 'RAW_WIRE_BYTES (exactly what we POSTed)', bytes: wire },
    { label: 're-serialised, same key order', bytes: JSON.stringify(obj) },
    { label: 'pretty 2-space', bytes: JSON.stringify(obj, null, 2) },
    { label: 'sorted keys', bytes: JSON.stringify(Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]))) },
    { label: 're-serialised + "stream":false', bytes: JSON.stringify({ ...obj, stream: false }) },
    { label: 're-serialised + "n":1', bytes: JSON.stringify({ ...obj, n: 1 }) },
    { label: 'wire + trailing \\n', bytes: wire + '\n' },
  ];
  for (const k of ['temperature', 'max_tokens']) c.push({ label: `re-serialised WITHOUT "${k}"`, bytes: drop(k) });
  return c;
}

/** Candidate response byte strings. */
function responseCandidates(wire: string): { label: string; bytes: string }[] {
  const c = [{ label: 'RAW_WIRE_BYTES (verbatim res.text())', bytes: wire }];
  try {
    const obj = JSON.parse(wire) as Record<string, unknown>;
    c.push({ label: 're-serialised', bytes: JSON.stringify(obj) });
    c.push({ label: 'pretty 2-space', bytes: JSON.stringify(obj, null, 2) });
    const drop = (k: string) => { const o = { ...obj }; delete o[k]; return JSON.stringify(o); };
    for (const k of ['usage', 'system_fingerprint', 'service_tier', 'created', 'id', 'object']) {
      if (k in obj) c.push({ label: `re-serialised WITHOUT "${k}"`, bytes: drop(k) });
    }
  } catch { /* not JSON */ }
  c.push({ label: 'wire + trailing \\n', bytes: wire + '\n' });
  c.push({ label: 'wire trimmed', bytes: wire.trim() });
  return c;
}

async function main() {
  const apiKey = loadApiKey();
  const model = opt('--model', committeeSlots()[0]!);
  const assetId = opt('--asset', listAssets()[0] ?? '');
  const ev = buildEvidence(loadAsset(assetId));

  console.log(`schemaId: ${SCHEMA_ID}`);
  console.log(`model:    ${model}`);
  console.log(`asset:    ${assetId}`);
  console.log(`evidence: ${ev.byteLength} bytes  sha256=${ev.evidenceSha256}`);
  console.log('');

  const att = await getAttestation(model);
  const attestedSigner = att.signing_address;
  console.log(`attested signing_address: ${attestedSigner ?? '(NONE — model is not receipt-signable)'}`);
  if (!attestedSigner) throw new Error(`${model} has no signing_address; pick an aggregator-served model`);

  const requestBody = buildRequestString(model, ev.line);
  const requestSha = sha256Hex(requestBody);
  console.log(`request: ${Buffer.byteLength(requestBody)} bytes  sha256=${requestSha}`);
  console.log('\n--- REQUEST BODY (byte-for-byte) ---');
  console.log(requestBody);
  console.log('--- END ---\n');

  const t0 = Date.now();
  const res = await chatRaw(requestBody, apiKey);
  const ms = Date.now() - t0;
  const responseSha = sha256Hex(res.responseBody);
  console.log(`HTTP ${res.status} in ${ms}ms   x-receipt-id: ${res.receiptId ?? '(ABSENT)'}`);
  console.log(`response: ${Buffer.byteLength(res.responseBody)} bytes  sha256=${responseSha}`);
  console.log('\n--- RESPONSE BODY (byte-for-byte) ---');
  console.log(res.responseBody);
  console.log('--- END ---\n');
  console.log('headers:', JSON.stringify(res.headers, null, 1));

  if (res.status !== 200 || !res.receiptId) {
    console.error('\nFAILED before the signature stage.');
    process.exit(1);
  }

  // --- grammar compliance -------------------------------------------------
  const parse = parseResponseOnChain(res.responseBody);
  console.log(`\nON-CHAIN PARSE: ${parse.ok ? 'ACCEPT' : `REJECT(${parse.reason})`}  ${parse.detail ?? ''}`);
  if (parse.ok) console.log(`  nav_usd_e6=${parse.parsed!.navE6}  confidence_bps=${parse.parsed!.confBps}  created=${parse.parsed!.createdAt}`);
  try { console.log('  offsets:', JSON.stringify(findVerdictOffsets(res.responseBody))); } catch (e) { console.log('  offsets:', (e as Error).message); }

  // --- signature (SAME bearer token, immediately — 1h in-memory TTL) ------
  let sigResp: Awaited<ReturnType<typeof getSignature>> | null = null;
  let signature: Hex | null = null;
  for (let i = 0; i < 6 && !signature; i++) {
    try {
      sigResp = await getSignature(res.receiptId, 'ecdsa', apiKey);
      if (sigResp.signature && /^0x[0-9a-fA-F]{130}$/.test(sigResp.signature)) signature = sigResp.signature as Hex;
      else console.log(`  not ready (${i + 1}): ${JSON.stringify(sigResp).slice(0, 200)}`);
    } catch (e) { console.log(`  fetch error (${i + 1}): ${(e as Error).message}`); }
    if (!signature) await new Promise((r) => setTimeout(r, 1500));
  }

  const ourText = `${requestSha}:${responseSha}`;
  console.log(`\ngateway signing_address: ${sigResp?.signing_address ?? '-'}`);
  console.log(`gateway text: ${sigResp?.text ?? '-'}`);
  console.log(`our text:     ${ourText}`);
  console.log(`TEXT MATCHES: ${sigResp?.text === ourText}`);

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    schemaId: SCHEMA_ID,
    model,
    assetId,
    evidence: ev.line,
    attestedSigner,
    receiptId: res.receiptId,
    latencyMs: ms,
    requestBody,
    requestSha256: requestSha,
    responseBody: res.responseBody,
    responseSha256: responseSha,
    responseHeaders: res.headers,
    gatewayText: sigResp?.text ?? null,
    gatewayTextMatchesOurs: sigResp?.text === ourText,
    signature,
    onChainParse: parse,
    signingAddress: attestedSigner,
  };

  if (!signature) {
    console.error('\n*** NO ECDSA SIGNATURE. Check: same bearer token? receipt within 1h TTL? gateway restarted? ***');
    report.byteExactness = { resolved: false, reason: 'no signature returned' };
  } else {
    console.log('\n=== BYTE-EXACTNESS BRUTE FORCE ===');
    const reqC = requestCandidates(requestBody);
    const respC = responseCandidates(res.responseBody);
    let solved = false;
    outer: for (const rq of reqC) {
      for (const rp of respC) {
        const v = await verifyReceipt({ requestBody: rq.bytes, responseBody: rp.bytes, signature }, attestedSigner);
        if (v.ok) {
          console.log(`  SOLVED request  = ${rq.label}`);
          console.log(`  SOLVED response = ${rp.label}`);
          report.byteExactness = {
            resolved: true,
            requestBytesAre: rq.label,
            responseBytesAre: rp.label,
            requestIsRawWire: rq.bytes === requestBody,
            responseIsRawWire: rp.bytes === res.responseBody,
            recovered: v.recovered,
          };
          report.requestBody = rq.bytes;
          report.responseBody = rp.bytes;
          solved = true;
          break outer;
        }
      }
    }
    if (!solved) {
      const v = await verifyReceipt({ requestBody, responseBody: res.responseBody, signature });
      console.log(`  UNSOLVED after ${reqC.length * respC.length} combos. raw/raw recovers ${v.recovered}, attested ${attestedSigner}`);
      report.byteExactness = { resolved: false, rawRawRecovered: v.recovered, combosTried: reqC.length * respC.length };
    }

    const pf = await preflightVerdict({
      slot: 0, modelId: model, evidence: ev.line,
      responseBody: res.responseBody, signature, attestedSigner, maxAgeSec: 3600,
    });
    console.log(`\nFULL PREFLIGHT: ${pf.ok ? 'WOULD BE ACCEPTED ON-CHAIN' : `WOULD BE REJECTED: ${pf.reason} at ${pf.failedCheck} — ${pf.detail}`}`);
    report.preflight = pf;
  }

  mkdirSync(FIXTURES, { recursive: true });
  const name = `receipt-${model.replace(/\//g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(join(FIXTURES, name), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(DATA, 'byte-exactness.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`\nwrote data/fixtures/${name}`);
  console.log('wrote data/byte-exactness.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
