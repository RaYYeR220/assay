/**
 * run-eval.ts — execute the protocol committed in docs/EVAL.md.
 *
 *   node --experimental-strip-types scripts/run-eval.ts [--set P|T|H|all] [--band 1500] [--quorum 3]
 *   node --experimental-strip-types scripts/run-eval.ts --score-only   # score recorded bundles, no key
 *
 * The scoring rules were fixed before the run, so this script implements them rather than
 * choosing them:
 *   hit rate           — of P1-P20, how many published medians fall INSIDE the reference band
 *   refusal rate       — of T1-T4, how many rounds halted (or fell below the confidence floor)
 *   false refusal rate — of P1-P20, how many halted anyway
 *   T5                 — reported separately; docs/EVAL.md predicts IN ADVANCE it will NOT halt
 *
 * Writes data/eval-results.json. Every number here is re-derivable from the persisted bundles.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { appraise, loadBundle, listBundles, type AppraisalBundle } from '../src/appraise.ts';
import { loadAllAssets, type AssetRecord } from '../src/evidence.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

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
const strOpt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] ?? d : d; };

interface CaseResult {
  caseId: string;
  assetId: string;
  halted: boolean;
  haltReasons: string[];
  medianUsd: number | null;
  bandLowUsd: number | null;
  bandHighUsd: number | null;
  inBand: boolean | null;
  acceptedSlots: number;
  maxDeviationBps: number | null;
  /** Per-slot NAVs, so dispersion can be inspected rather than taken on trust. */
  slotNavsUsd: (number | null)[];
  rejectReasons: string[];
}

function scoreBundle(asset: AssetRecord, b: AppraisalBundle): CaseResult {
  const s = b.summary;
  const medianUsd = s.medianE6 ? Number(s.medianE6) / 1e6 : null;
  const ref = asset.reference ?? null;
  const inBand =
    medianUsd !== null && ref ? medianUsd >= ref.lowUsd && medianUsd <= ref.highUsd : null;

  return {
    caseId: asset.caseId ?? asset.assetId,
    assetId: asset.assetId,
    halted: s.wouldHalt,
    haltReasons: s.haltReasons,
    medianUsd,
    bandLowUsd: ref?.lowUsd ?? null,
    bandHighUsd: ref?.highUsd ?? null,
    inBand,
    acceptedSlots: s.preflightOk,
    maxDeviationBps: s.maxDeviationBps,
    slotNavsUsd: b.slots.map((x) => (x.preflight?.navE6 ? Number(x.preflight.navE6) / 1e6 : null)),
    rejectReasons: s.rejectReasons.map((r) => `${r.model}:${r.reason}`),
  };
}

function summarise(results: CaseResult[]) {
  const P = results.filter((r) => /^P\d+$/.test(r.caseId));
  const T = results.filter((r) => /^T[1-4]$/.test(r.caseId));
  const t5 = results.find((r) => r.caseId === 'T5') ?? null;

  const hits = P.filter((r) => r.inBand === true).length;
  const falseRefusals = P.filter((r) => r.halted).length;
  const refusals = T.filter((r) => r.halted).length;

  return {
    priceable: {
      cases: P.length,
      hits,
      hitRate: P.length ? hits / P.length : null,
      falseRefusals,
      falseRefusalRate: P.length ? falseRefusals / P.length : null,
    },
    traps: {
      cases: T.length,
      refusals,
      refusalRate: T.length ? refusals / T.length : null,
      prediction: 'docs/EVAL.md predicted at least 3 of 4 would halt',
      predictionHeld: T.length ? refusals >= 3 : null,
    },
    anchoring: t5
      ? {
          caseId: 'T5',
          halted: t5.halted,
          medianUsd: t5.medianUsd,
          trueBandUsd: [t5.bandLowUsd, t5.bandHighUsd],
          maxDeviationBps: t5.maxDeviationBps,
          prediction: 'docs/EVAL.md predicted IN ADVANCE that T5 would NOT halt, and would show a TIGHTER band than an honest case',
          predictionHeld: t5.halted === false,
        }
      : null,
  };
}

async function main() {
  const assets = loadAllAssets();
  const set = strOpt('--set', 'all').toUpperCase();
  const wanted = assets.filter((a) => {
    if (!a.caseId) return false;
    if (set === 'ALL') return true;
    return a.caseId.startsWith(set);
  });

  const results: CaseResult[] = [];

  if (argv.includes('--score-only')) {
    // Score whatever has already been recorded. No network, no credentials.
    for (const a of wanted) {
      const name = `${a.assetId}-latest.json`;
      if (!listBundles().includes(name)) continue;
      results.push(scoreBundle(a, loadBundle(name)));
    }
    if (results.length === 0) {
      console.error('no recorded bundles to score — run without --score-only once a key is available');
      process.exit(1);
    }
  } else {
    const key = apiKey();
    const bandBps = numOpt('--band', 1500);
    const quorum = numOpt('--quorum', 3);
    const minConfidenceBps = numOpt('--min-confidence', 0);

    console.log(`running ${wanted.length} cases  band=${bandBps}bps quorum=${quorum}\n`);
    for (const a of wanted) {
      const b = await appraise(a.assetId, { apiKey: key, bandBps, quorum, minConfidenceBps, maxAgeSec: 3600 });
      const r = scoreBundle(a, b);
      results.push(r);
      const verdict = r.halted ? 'HALT' : `$${r.medianUsd?.toFixed(2)}`;
      const band = r.bandLowUsd !== null ? `[$${r.bandLowUsd}-$${r.bandHighUsd}]` : '(no band)';
      const mark = r.inBand === true ? 'HIT' : r.inBand === false ? 'miss' : '—';
      console.log(
        `  ${r.caseId.padEnd(4)} ${r.assetId.padEnd(38)} ${verdict.padStart(9)} ${band.padEnd(20)} ${mark.padEnd(5)} ` +
          `${r.acceptedSlots}/5 slots  ${r.maxDeviationBps ?? '—'}bps  ${r.haltReasons.join(' | ')}`,
      );
    }
  }

  const summary = summarise(results);
  const out = {
    generatedAt: new Date().toISOString(),
    protocol: 'docs/EVAL.md, committed before the run',
    summary,
    results,
  };
  writeFileSync(join(DATA, 'eval-results.json'), JSON.stringify(out, null, 2) + '\n');

  console.log('\n=== RESULTS (protocol fixed in advance) ===');
  const p = summary.priceable;
  console.log(`  hit rate           ${p.hits}/${p.cases}  ${p.hitRate !== null ? (p.hitRate * 100).toFixed(0) + '%' : '—'}`);
  console.log(`  false refusal rate ${p.falseRefusals}/${p.cases}  ${p.falseRefusalRate !== null ? (p.falseRefusalRate * 100).toFixed(0) + '%' : '—'}`);
  const t = summary.traps;
  console.log(`  refusal rate       ${t.refusals}/${t.cases}  (predicted >=3/4 -> ${t.predictionHeld ? 'HELD' : 'FAILED'})`);
  if (summary.anchoring) {
    const a = summary.anchoring;
    console.log(`  T5 anchoring       halted=${a.halted}  median=$${a.medianUsd?.toFixed(2) ?? '—'} vs true band [$${a.trueBandUsd[0]}-$${a.trueBandUsd[1]}]  dev=${a.maxDeviationBps ?? '—'}bps`);
    console.log(`                     predicted NOT to halt -> ${a.predictionHeld ? 'PREDICTION HELD (our design failed as predicted)' : 'PREDICTION WRONG (it halted)'}`);
  }
  console.log(`\nwrote ${join(DATA, 'eval-results.json')}`);
  console.log('Paste the summary into docs/EVAL.md under Results, including any prediction that turned out wrong.');
}

main().catch((e) => { console.error(e); process.exit(1); });
