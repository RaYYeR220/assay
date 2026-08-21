/**
 * discover-committee.ts — enumerate TEE models, pull each attestation report, and write
 * backend/data/committee.json.
 *
 * Answers the load-bearing question: are the TEE signing addresses DISTINCT per model,
 * or shared? (Spoiler, and the reason this script exists: shared. See data/committee.json
 * `signerAnalysis`.)
 *
 *   node --experimental-strip-types scripts/discover-committee.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModels, getAttestation, type ModelEntry, type AttestationReport } from '../src/redpill.ts';
import { deployCommittee } from '../src/slots.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

interface Row {
  id: string;
  name: string;
  providers: string[];
  contextLength: number;
  pricing: { promptUsdPerToken: string | null; completionUsdPerToken: string | null };
  supportsResponseFormat: boolean;
  supportsStructuredOutputs: boolean;
  supportsJsonMode: boolean;
  supportsSeed: boolean;
  supportsTemperature: boolean;
  /** Emits chain-of-thought. Excluded from the committee — see tokenBudgetRisk. */
  isReasoningModel: boolean;
  /** true iff the report carries an ECDSA signing_address — i.e. receipts are signable */
  receiptSignable: boolean;
  signingAddress: string | null;
  signingAlgo: string | null;
  teeType: string | null;
  serving: string | null;
  intelQuoteLength: number;
  reportData: string | null;
  /** report_data[0:20] must equal signing_address for the chain of trust to close */
  reportDataBindsSigner: boolean | null;
  gpuTee: boolean;
  gpuArch: string | null;
  gpuEvidenceCount: number;
  keysetNotAfter: number | null;
  repoUrl: string | null;
  repoCommit: string | null;
  attestationShape: string;
  error: string | null;
}

async function pooled<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

function analyse(m: ModelEntry, rep: AttestationReport): Row {
  const params = new Set(m.supported_parameters ?? []);
  const feats = new Set(m.supported_features ?? []);
  let nv: { arch?: string; evidence_list?: unknown[] } = {};
  try { nv = JSON.parse(rep.nvidia_payload ?? '{}'); } catch { /* not JSON */ }
  const evList = Array.isArray(nv.evidence_list) ? nv.evidence_list : [];
  const signer = rep.signing_address ?? null;
  const reportData = rep.attestation?.report_data ?? null;

  return {
    id: m.id,
    name: m.name,
    providers: m.providers ?? [],
    contextLength: m.context_length,
    pricing: {
      promptUsdPerToken: m.pricing?.prompt ?? null,
      completionUsdPerToken: m.pricing?.completion ?? null,
    },
    supportsResponseFormat: params.has('response_format'),
    supportsStructuredOutputs: params.has('structured_outputs') || feats.has('structured_outputs'),
    supportsJsonMode: feats.has('json_mode'),
    supportsSeed: params.has('seed'),
    supportsTemperature: params.has('temperature'),
    isReasoningModel: feats.has('reasoning') || params.has('reasoning'),
    receiptSignable: Boolean(signer),
    signingAddress: signer,
    signingAlgo: rep.signing_algo ?? null,
    teeType: rep.attestation?.tee_type ?? null,
    serving: rep.service_capabilities?.serving ?? null,
    intelQuoteLength: (rep.intel_quote ?? '').length,
    reportData,
    reportDataBindsSigner:
      signer && reportData
        ? reportData.slice(0, 40).toLowerCase() === signer.replace(/^0x/, '').toLowerCase()
        : null,
    gpuTee: evList.length > 0,
    gpuArch: nv.arch ?? null,
    gpuEvidenceCount: evList.length,
    keysetNotAfter: rep.attestation?.workload_keyset?.not_after ?? null,
    repoUrl: rep.attestation?.source_provenance?.repo_url ?? null,
    repoCommit: rep.attestation?.source_provenance?.repo_commit ?? null,
    attestationShape: rep.signing_address ? 'aci/1-aggregator' : rep.attestation_type ?? 'unknown',
    error: rep.error?.message ?? null,
  };
}

/**
 * Committee selection.
 *
 * Constraints, in order of severity:
 *  1. receipt-signable (has an ECDSA signing_address) — otherwise it cannot be verified at all
 *  2. NOT a reasoning model. The schema now pins `max_tokens: 512`, which makes a reasoning
 *     model SURVIVABLE but not PREDICTABLE. We still cannot send `reasoning: false` — any
 *     extra field changes the request bytes and breaks every signature — so a model that
 *     inlines its thinking into `content` emits prose before the ASSAY1 line and is rejected
 *     as Malformed every single round. That is a permanent dead slot, not a noisy one, and a
 *     slot that never contributes is worse than one that occasionally disagrees.
 *  3. distinct model families — the whole point of a committee is independent priors
 *  4. GPU-TEE, then cheap
 */
function familyOf(id: string): string {
  const vendor = id.split('/')[0]!;
  if (vendor === 'phala') return id.includes('gemma') ? 'google' : id.includes('qwen') ? 'qwen' : 'phala';
  if (vendor === 'meta-llama' || vendor === 'meta') return 'meta';
  return vendor;
}

/**
 * Base-model lineage, e.g. `deepseek-v4-flash-0731` and `deepseek-v4-flash` collapse to
 * `deepseek:deepseek-v4-flash`. Two checkpoints of one base model share their training
 * data, their biases and their failure modes — seating both buys no independence, which is
 * the ONE thing a committee is for. Lineage duplicates are hard-excluded.
 */
function lineageOf(id: string): string {
  const slug = (id.split('/')[1] ?? id)
    .replace(/-\d{4}$/, '')            // date/checkpoint suffix: -0731
    .replace(/-(instruct|it|chat|uncensored)$/, '')
    .replace(/-a\d+b$/, '')            // active-param suffix: -a3b, -a17b
    .replace(/-\d+b$/, '');            // size suffix: -27b, -70b
  return `${familyOf(id)}:${slug}`;
}

function selectCommittee(rows: Row[], n: number): string[] {
  const eligible = rows.filter((r) => r.receiptSignable && !r.error);
  const score = (r: Row) =>
    (r.gpuTee ? 1000 : 0) +
    Math.min(r.contextLength / 10_000, 50) -
    Number(r.pricing.completionUsdPerToken ?? 0) * 1e7;

  const picked: Row[] = [];
  const usedFamilies = new Set<string>();
  const usedLineages = new Set<string>();

  const familyCount = (f: string) => picked.filter((p) => familyOf(p.id) === f).length;

  const take = (pool: Row[], requireNewFamily: boolean) => {
    while (picked.length < n) {
      // Re-rank every iteration: once a family is taken, its siblings sink. A duplicate
      // LINEAGE is never acceptable, so it is filtered out rather than merely penalised.
      const next = pool
        .filter((r) => !picked.includes(r))
        .filter((r) => !usedLineages.has(lineageOf(r.id)))
        .filter((r) => !requireNewFamily || !usedFamilies.has(familyOf(r.id)))
        .sort((a, b) => familyCount(familyOf(a.id)) - familyCount(familyOf(b.id)) || score(b) - score(a))[0];
      if (!next) return;
      usedFamilies.add(familyOf(next.id));
      usedLineages.add(lineageOf(next.id));
      picked.push(next);
    }
  };

  // A duplicated family is a much smaller loss than a slot that truncates every round, so
  // the whole non-reasoning pool is exhausted — diversity first, then duplicates — before a
  // reasoning model is considered at all.
  const safe = eligible.filter((r) => !r.isReasoningModel);
  const risky = eligible.filter((r) => r.isReasoningModel);
  take(safe, true);
  take(safe, false);
  take(risky, true);
  take(risky, false);
  return picked.map((r) => r.id);
}

async function main() {
  console.error('fetching /v1/models ...');
  const models = await listModels();
  const tee = models.filter((m) => m.is_tee);
  console.error(`  ${tee.length} TEE models of ${models.length} total`);

  console.error('fetching attestation reports (concurrency 6) ...');
  const reports = await pooled(tee, 6, async (m) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await getAttestation(m.id);
      } catch (e) {
        if (attempt === 2) return { error: { message: (e as Error).message } } as AttestationReport;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return {} as AttestationReport;
  });

  const rows = tee.map((m, i) => analyse(m, reports[i]!));

  const signable = rows.filter((r) => r.receiptSignable);
  const distinctSigners = [...new Set(signable.map((r) => r.signingAddress!))];

  const committee = selectCommittee(rows, 5);
  const reasoningFree = rows.filter((r) => r.receiptSignable && !r.error && !r.isReasoningModel);

  const out = {
    generatedAt: new Date().toISOString(),
    source: {
      models: 'GET https://api.redpill.ai/v1/models  (no API key)',
      attestation: 'GET https://api.redpill.ai/v1/attestation/report?model=<id>  (no API key)',
    },
    counts: {
      totalModels: models.length,
      teeModels: tee.length,
      receiptSignable: signable.length,
      notSignable: rows.length - signable.length,
    },
    signerAnalysis: {
      question: 'Are signing_address values DISTINCT per model, or shared across models?',
      answer: distinctSigners.length === 1 ? 'SHARED' : 'DISTINCT',
      distinctSigningAddresses: distinctSigners,
      distinctCount: distinctSigners.length,
      explanation:
        distinctSigners.length === 1
          ? 'One dstack "aggregator" TEE (serving="aggregator") fronts every Phala-served model and ' +
            'signs every receipt with a single secp256k1 key. Model independence therefore CANNOT ' +
            'come from distinct signer addresses. It comes from the model id being inside the ' +
            'request bytes the contract reconstructs: the contract builds N different request ' +
            'bodies pinning N different model ids, so a signature over reqHash:respHash is a ' +
            'commitment by the attested gateway that THAT model produced THAT response.'
          : 'Signers differ per model.',
      chainOfTrust:
        'TDX quote report_data = signingAddress(20 bytes) || 12 zero bytes || nvidiaNonce(32 bytes). ' +
        'Verifying the quote on-chain therefore pins the ECDSA signer address, and the nvidia ' +
        'nonce ties the GPU (H100/HOPPER) evidence to the same quote.',
    },
    tokenBudgetRisk: {
      note:
        'The on-chain schema pins max_tokens=512 and cannot be changed per-request: any extra ' +
        'field (including reasoning:false) changes the request bytes and breaks every signature. ' +
        '512 tokens is enough headroom that a reasoning model will usually not hit ' +
        'finish_reason="length" — but a model that inlines chain-of-thought into content emits ' +
        'prose before the ASSAY1 line, which the strict parser rejects as Malformed every round. ' +
        'That is a permanent halt rather than a useful signal, so reasoning models stay excluded.',
      reasoningModels: rows.filter((r) => r.isReasoningModel).map((r) => r.id),
      reasoningFreeSignable: reasoningFree.map((r) => r.id),
      mustBeConfirmedBy: 'scripts/compliance.ts (5 samples per model against a real asset)',
    },
    selectedCommittee: committee,
    deployedCommittee: deployCommittee(),
    slotOrderNote:
      'script/Deploy.s.sol is the source of truth for slot order: AssayOracle checks the ' +
      'recovered signer against modelAt(assetId, slot), so appraising in a different order ' +
      'invalidates every verdict. selectedCommittee is only a suggestion from this script.',
    models: rows,
  };

  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'committee.json'), JSON.stringify(out, null, 2) + '\n');

  console.error('');
  console.error(`receipt-signable: ${signable.length}/${tee.length}`);
  console.error(`DISTINCT SIGNING ADDRESSES: ${distinctSigners.length} -> ${distinctSigners.join(', ')}`);
  console.error(`ANSWER: signing addresses are ${out.signerAnalysis.answer}`);
  console.error('');
  console.error('selected committee:');
  for (const id of committee) {
    const r = rows.find((x) => x.id === id)!;
    console.error(
      `  slot ${committee.indexOf(id)} ${id.padEnd(34)} gpuTee=${String(r.gpuTee).padEnd(5)} ` +
        `reasoning=${String(r.isReasoningModel).padEnd(5)} ctx=${String(r.contextLength).padEnd(8)} ` +
        `in=$${r.pricing.promptUsdPerToken}/tok`,
    );
  }
  const deployed = deployCommittee();
  if (deployed) {
    const sameSet = deployed.length === committee.length && deployed.every((m) => committee.includes(m));
    const sameOrder = JSON.stringify(deployed) === JSON.stringify(committee);
    console.error('');
    console.error(`DEPLOYED slot order (script/Deploy.s.sol) — this is what the contract enforces:`);
    deployed.forEach((m, i) => console.error(`  slot ${i} ${m}`));
    if (!sameSet) console.error('  !! MEMBERSHIP DRIFT: discovery suggests a different set than will be deployed');
    else if (!sameOrder) console.error('  note: same members, different order. The DEPLOYED order wins.');
    else console.error('  matches discovery exactly.');
  }
  console.error('');
  console.error(`reasoning models EXCLUDED (inlined chain-of-thought = permanent Malformed): ${rows.filter((r) => r.isReasoningModel).length}`);
  console.error(`reasoning-free signable pool: ${reasoningFree.length}`);
  console.error('');
  console.error(`wrote ${join(DATA, 'committee.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
