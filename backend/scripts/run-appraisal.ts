/**
 * run-appraisal.ts — run a full 5-slot committee round and persist a submittable bundle.
 *
 *   node --experimental-strip-types scripts/run-appraisal.ts <assetId> [--band 1500] [--quorum 3]
 *   node --experimental-strip-types scripts/run-appraisal.ts --all
 *   node --experimental-strip-types scripts/run-appraisal.ts --replay [bundle.json]   # zero-key
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appraise, loadBundle, listBundles, reverifyBundle } from '../src/appraise.ts';
import { listAssets } from '../src/evidence.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

function apiKey(): string {
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
const usd = (e6: string | null) => (e6 ? '$' + (Number(e6) / 1e6).toFixed(2) : '—');

async function replay(name: string) {
  const b = loadBundle(name);
  const r = await reverifyBundle(b);
  console.log(`\nreplay ${name}   asset=${r.assetId}`);
  console.log(`  schemaId=${r.schemaId}`);
  console.log(`  request bytes reproduced from schema: ${r.requestBytesReproduced}`);
  for (const s of r.slots) {
    console.log(
      `  slot ${s.slot} ${s.model.padEnd(32)} ${s.ok ? 'ACCEPT' : 'REJECT'.padEnd(6)} ${String(s.reason).padEnd(14)} ` +
        `nav=${usd(s.navE6).padStart(9)} signer=${s.recovered ?? '-'}${s.ok ? '' : `  (${s.failedCheck}: ${s.detail ?? ''})`}`,
    );
  }
  console.log(`  accepted ${r.acceptedCount}/${r.slots.length}   median=${usd(b.summary.medianE6)} maxDev=${b.summary.maxDeviationBps}bps  wouldHalt=${b.summary.wouldHalt}`);
  if (b.summary.haltReasons.length) console.log(`  halt: ${b.summary.haltReasons.join(' | ')}`);
}

async function run(assetId: string) {
  const b = await appraise(assetId, {
    apiKey: apiKey(),
    quorum: numOpt('--quorum', 3),
    bandBps: numOpt('--band', 1500),
    minConfidenceBps: numOpt('--min-confidence', 0),
    maxAgeSec: numOpt('--max-age', 3600),
  });
  console.log(`\n=== ${assetId} ===`);
  console.log(`evidence ${b.evidence.byteLength} bytes  sha256=${b.evidence.sha256}`);
  for (const s of b.slots) {
    const pf = s.preflight;
    console.log(
      `  slot ${s.slot} ${s.model.padEnd(32)} ${String(s.latencyMs).padStart(6)}ms ` +
        `${pf?.ok ? 'ACCEPT' : 'REJECT'} ${String(pf?.reason ?? '-').padEnd(13)} ` +
        `nav=${usd(pf?.navE6 ?? null).padStart(9)} conf=${pf?.confBps ?? '—'} ` +
        `${s.failure ?? ''}`,
    );
  }
  const s = b.summary;
  console.log(`  accepted ${s.preflightOk}/${s.slots}  median=${usd(s.medianE6)}  maxDev=${s.maxDeviationBps}bps`);

  // A round blocker is not a halt: postAppraisal reverts before any verdict is read, so
  // report it as its own outcome rather than burying it in the halt reasons.
  const c = b.chain;
  if (c.evidenceCommitted === false) {
    console.log(`  WILL REVERT: EvidenceNotCommitted(0x${b.evidence.sha256})`);
    console.log('    the issuer must first call:');
    console.log(`    AssetRegistry.commitEvidence(${b.assetIdHex}, 0x${b.evidence.sha256}, "", true)`);
  } else if (c.evidenceCommitted === null) {
    console.log(`  EVIDENCE COMMITMENT UNKNOWN — ${c.error ?? 'not checked'}`);
    console.log(`    set ASSAY_RPC_URL + ASSAY_ASSET_REGISTRY to verify before posting`);
  } else {
    console.log('  evidence commitment: OK');
  }
  if (c.observationWatermark !== null) console.log(`  observationWatermark: ${c.observationWatermark}`);
  console.log(`  WOULD ${s.wouldHalt ? 'HALT' : 'ACCEPT'}${s.haltReasons.length ? ': ' + s.haltReasons.join(' | ') : ''}`);
  console.log(`  submission: ${b.submission.verdicts.length} verdicts (all slots, dead ones included)`);
}

async function main() {
  const ri = argv.indexOf('--replay');
  if (ri >= 0) {
    const name = argv[ri + 1];
    if (name && !name.startsWith('--')) return replay(name);
    const latest = listBundles().filter((f) => f.endsWith('-latest.json'));
    if (latest.length === 0) { console.error('no bundles recorded yet'); process.exit(1); }
    for (const b of latest) await replay(b);
    return;
  }
  const targets = argv.includes('--all') ? listAssets() : ([argv[0]].filter((x) => x && !x.startsWith('--')) as string[]);
  if (targets.length === 0) {
    console.error(`usage: run-appraisal.ts <assetId|--all|--replay [bundle]>\nassets: ${listAssets().join(', ')}`);
    process.exit(1);
  }
  for (const t of targets) await run(t);
}

main().catch((e) => { console.error(e); process.exit(1); });
