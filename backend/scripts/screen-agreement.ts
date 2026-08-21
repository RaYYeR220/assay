/**
 * screen-agreement.ts — which asset does the committee actually AGREE on?
 *
 *   node --experimental-strip-types scripts/screen-agreement.ts <assetId...> [--models a,b,c,d,e]
 *
 * Publishing depends on inter-model agreement (maxDev <= bandBps), NOT on accuracy against
 * the reference band. A committee can be uniformly wrong and still publish; it can contain
 * the correct answer and still halt. So the right way to pick the demo asset is to measure
 * dispersion empirically rather than reason about which asset "should" be easy.
 *
 * Runs the committee WITHOUT posting and reports dispersion per asset.
 */

import { appraise } from '../src/appraise.ts';
import { loadAsset } from '../src/evidence.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function apiKey(): string {
  if (process.env.REDPILL_API_KEY) return process.env.REDPILL_API_KEY;
  for (const p of [join(HERE, '..', '..', '..', 'internal', '.env'), join(HERE, '..', '.env')]) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^REDPILL_API_KEY=(.+)$/m);
    if (m?.[1]?.trim()) return m[1].trim();
  }
  throw new Error('REDPILL_API_KEY not set');
}

const argv = process.argv.slice(2);
const mi = argv.indexOf('--models');
const models = mi >= 0 ? argv[mi + 1]!.split(',') : undefined;
const assets = argv.filter((a) => !a.startsWith('--') && a !== argv[mi + 1]);

// Match the on-chain policy exactly, or the screen measures the wrong thing.
const BAND = Number(process.env.SCREEN_BAND ?? 1500);
const QUORUM = 3;
const MIN_CONF = 5000;

const usd = (e6: string | null) => (e6 ? `$${(Number(e6) / 1e6).toFixed(4)}` : '—');

const results = [];
for (const id of assets) {
  const a = loadAsset(id);
  const b = await appraise(id, {
    apiKey: apiKey(), models, quorum: QUORUM, bandBps: BAND,
    minConfidenceBps: MIN_CONF, maxAgeSec: 3600, persist: false,
  });
  const ref = a.reference;
  const navs = b.slots.map((s) => (s.preflight?.ok ? Number(s.preflight.navE6) / 1e6 : null));
  results.push({
    id, caseId: a.caseId,
    band: ref ? `$${ref.lowUsd}-$${ref.highUsd}` : '—',
    accepted: b.summary.preflightOk,
    median: b.summary.medianE6,
    maxDev: b.summary.maxDeviationBps,
    publishes: !b.summary.wouldHalt,
    navs,
    reasons: b.summary.rejectReasons.map((r) => `s${r.slot}:${r.reason}`),
  });
  const r = results.at(-1)!;
  console.log(
    `${String(r.caseId).padEnd(4)} ${id.padEnd(24)} ref=${r.band.padEnd(16)} ` +
      `acc=${r.accepted}/5 median=${usd(r.median).padStart(10)} maxDev=${String(r.maxDev ?? '—').padStart(8)}bps ` +
      `${r.publishes ? '*** PUBLISHES ***' : 'halt'}  navs=[${r.navs.map((n) => (n === null ? '—' : n.toFixed(3))).join(', ')}] ${r.reasons.join(' ')}`,
  );
}

const winners = results.filter((r) => r.publishes).sort((a, b) => (a.maxDev ?? 1e9) - (b.maxDev ?? 1e9));
console.log('');
if (winners.length) {
  console.log(`BEST: ${winners[0]!.id}  maxDev=${winners[0]!.maxDev}bps  median=${usd(winners[0]!.median)}`);
} else {
  const closest = [...results].sort((a, b) => (a.maxDev ?? 1e9) - (b.maxDev ?? 1e9))[0];
  console.log(`NONE publish. Closest: ${closest?.id} at ${closest?.maxDev}bps (band ${BAND}bps).`);
}
