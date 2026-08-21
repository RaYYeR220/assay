/**
 * gen-assets.ts — generate data/assets/*.json from the VERIFIED reference datasets.
 *
 *   node --experimental-strip-types scripts/gen-assets.ts
 *
 * Everything here is derived from two public sources committed under data/reference/:
 *   - Berkeley Voluntary Registry Offsets Database v2026-06 (CC BY 4.0) — registry facts
 *   - api.carbonmark.com/prices (public, no auth) — live per-project-vintage asks
 *
 * Two rules this script exists to enforce:
 *
 * 1. NO PRICE IN THE EVIDENCE. A reference price shown to the committee is the T5 anchoring
 *    trap by construction. Priceable cases carry `ref_price_usd=NA` and keep their scoring
 *    band in `reference`, which is never hashed and never sent to a model. T5 is the ONE
 *    case that deliberately plants a price, because that is what it is testing.
 *
 * 2. NO STEER. Trap and hero evidence states registry facts flatly. We do not write
 *    "this project is bad" — we write what the registry says and let the committee decide.
 *    A halt we had to induce with adjectives would prove nothing.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvidence, type AssetRecord } from '../src/evidence.ts';
import { assertRequestWellFormed } from '../src/canonical.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
const ASSETS = join(DATA, 'assets');
const REF = join(DATA, 'reference');

const OBSERVED = '2026-08-21';

// --- reference data ---------------------------------------------------------

interface Ask { projectId: string; vintage: number | string; baseAsk: number; purchasePrice: number; supply: number }
interface Vrod {
  ProjectID: string; Name: string; Registry: string; Status: string; Scope: string; Type: string;
  Methodology: string; Region: string; Country: string; Developer: string;
  Issued: string; Retired: string; Remaining: string; BufferDep: string; FirstVintage: string;
}

const asks = (JSON.parse(readFileSync(join(REF, 'carbonmark-asks.json'), 'utf8')) as { asks: Ask[] }).asks;
const vrod = (JSON.parse(readFileSync(join(REF, 'berkeley-vrod-subset.json'), 'utf8')) as { projects: Vrod[] }).projects;
const vrodBy = new Map(vrod.map((v) => [v.ProjectID, v]));

const CARBONMARK_URL = 'https://api.carbonmark.com/prices';
const BERKELEY_URL =
  'https://gspp.berkeley.edu/faculty-and-impact/centers/cepp/projects/berkeley-carbon-trading-project/offsets-database';

const SRC_BERKELEY = { label: 'Berkeley Voluntary Registry Offsets Database v2026-06 (CC BY 4.0)', url: BERKELEY_URL };
const SRC_CARBONMARK = { label: 'Carbonmark public price API (no auth)', url: CARBONMARK_URL };

/** Vintages in the feed are sometimes full dates (20180101). Normalise to a year. */
function vintageYear(v: number | string): string {
  const s = String(v);
  if (s === '9999') return 'NA';
  return s.length > 4 ? s.slice(0, 4) : s;
}

const out: AssetRecord[] = [];
function emit(a: AssetRecord) { out.push(a); }

// --- H1: hero, priceable — Aperam Bioenergia biochar ------------------------
//
// Figures verified against the Puro.earth registry entry. Puro is not in the Berkeley
// database (which covers VCS/GS/ACR/CAR), so these are cited to the registry directly.
emit({
  assetId: 'h1-pur175613-aperam-biochar-2023',
  caseId: 'H1',
  fields: {
    registry: 'Puro.earth',
    project_id: 'PUR-175613',
    project_name: 'Aperam Bioenergia biochar',
    project_type: 'engineered carbon removal, biochar',
    methodology: 'Puro.earth Biochar Methodology',
    vintage: '2023',
    country: 'Brazil',
    region: 'South America',
    registry_status: 'issued',
    credits_issued: '161507',
    credits_retired: '98144',
    credits_remaining: '63363',
    buffer_deposited: 'NA',
    first_vintage: '2023',
    durability: 'CORC durability class 100 plus years',
    integrity_flags: 'none recorded at the registry; principal uncertainties are biochar permanence modelling and biomass feedstock sourcing',
    ref_price_usd: 'NA',
    ref_price_source: 'NA',
    ref_price_date: 'NA',
    observed_at: OBSERVED,
  },
  reference: {
    lowUsd: 110.01,
    highUsd: 154.01,
    basis: 'Carbonmark PUR-175613 vintage 2023: seller ask 110.01 USD, fee-inclusive purchase price 154.01 USD. Quoted with supply 0, i.e. the ask is published but not currently fillable.',
    sourceUrl: CARBONMARK_URL,
  },
  sources: [
    { label: 'Puro.earth registry', url: 'https://puro.earth/carbon-removal-registry/' },
    SRC_CARBONMARK,
  ],
  provenance: {
    verified: ['registry', 'project_id', 'project_name', 'project_type', 'vintage', 'country', 'credits_issued', 'credits_retired', 'durability'],
    illustrative: [],
    notes:
      'credits_remaining is derived as issued minus retired. The Carbonmark ask carries supply 0, ' +
      'so the reference band is a published quote rather than evidence of a fillable market.',
  },
});

// --- H2: hero, must halt — Southern Cardamom REDD+ --------------------------
//
// Stated flatly, with no adjectives. Every clause is a registry or public-record fact.
{
  const v = vrodBy.get('VCS1748')!;
  emit({
    assetId: 'h2-vcs1748-southern-cardamom-2018',
    caseId: 'H2',
    fields: {
      registry: 'VCS',
      project_id: 'VCS-1748',
      project_name: v.Name,
      project_type: v.Type,
      methodology: 'VM0009 Methodology for Avoided Ecosystem Conversion',
      vintage: '2018',
      country: v.Country,
      region: v.Region,
      registry_status: v.Status,
      credits_issued: v.Issued,
      credits_retired: v.Retired,
      credits_remaining: v.Remaining,
      buffer_deposited: v.BufferDep,
      first_vintage: v.FirstVintage,
      durability: 'avoided conversion, reversal risk covered by a registry buffer pool',
      integrity_flags:
        'methodology VM0009 has been inactivated by the registry for new projects; ICVCM excluded VM0009 from Core Carbon Principles assessment, so credits are CCP-ineligible; ' +
        'project issuance was suspended in June 2023 following human rights allegations and reinstated in September 2024 subject to mandatory remediation; ' +
        'no listings with available supply on public secondary marketplaces',
      ref_price_usd: 'NA',
      ref_price_source: 'NA',
      ref_price_date: 'NA',
      observed_at: OBSERVED,
    },
    sources: [
      SRC_BERKELEY,
      { label: 'Verra registry project page (VCS 1748)', url: 'https://registry.verra.org/app/projectDetail/VCS/1748' },
      { label: 'Human Rights Watch, Carbon Offsetting\'s Casualties (Feb 2024)', url: 'https://www.hrw.org/report/2024/02/28/carbon-offsettings-casualties/violations-chong-indigenous-peoples-rights' },
      { label: 'ICVCM Core Carbon Principles assessment decisions', url: 'https://icvcm.org/assessment-status-of-methodologies/' },
    ],
    provenance: {
      verified: ['registry', 'project_id', 'project_name', 'project_type', 'methodology', 'country', 'region', 'registry_status', 'credits_issued', 'credits_retired', 'credits_remaining', 'buffer_deposited', 'first_vintage'],
      illustrative: [],
      notes:
        'No reference band: this asset is the one we assert is NOT priceable. 68.9 percent of issued ' +
        'credits remain outstanding (19,046,389 of 27,627,237) and there is no live secondary supply, ' +
        'so there is no defensible market anchor. The evidence states registry facts only — if the ' +
        'committee converges anyway, that is the result and we report it.',
    },
  });
}

// --- P1..P20: priceable set from live Carbonmark listings -------------------

const TYPE_HINT: Record<string, string> = {
  'ICR-349': 'Improved cookstoves',
  'ICR-91': 'Blue carbon, mangrove restoration',
  'ICR-48': 'Improved cookstoves',
  'ICR-112': 'Renewable energy',
  'TVER-40': 'Renewable energy',
  'CMARK-1': 'Mixed portfolio credit',
  'CMARK-3': 'Mixed portfolio credit',
  'CMARK-5': 'Mixed portfolio credit',
};

/** Live asks (supply > 0), cheapest per project|vintage, most liquid first. */
const live = asks
  .filter((a) => a.supply > 0 && a.baseAsk > 0)
  .sort((a, b) => b.supply - a.supply);

// Spread across price decades and project types rather than taking the top 20 by supply,
// so the priceable set actually exercises the full $0.5–$229 range the market shows.
const PRICE_BANDS = [[0, 1], [1, 2], [2, 5], [5, 12], [12, 25], [25, 90], [90, 1000]];
const PER_BAND_CAP = 3; // 7 bands x 3 = 21 slots for a 20-case set

const chosen: Ask[] = [];
const seenProjects = new Map<string, number>();

const tryTake = (a: Ask, projectCap: number): boolean => {
  if (chosen.length >= 20 || chosen.includes(a)) return false;
  const n = seenProjects.get(a.projectId) ?? 0;
  // At most a few vintages of any one project, so ICR-349's vintage curve is represented
  // without letting it dominate the set.
  if (n >= projectCap) return false;
  seenProjects.set(a.projectId, n + 1);
  chosen.push(a);
  return true;
};

// Pass 1: cap each price band, so the set spans $0.5 to $229 instead of collapsing into
// the sub-$1 bucket where most of the live supply happens to sit. A priceable set that is
// entirely worthless credits would not test whether the committee can price anything.
for (const [lo, hi] of PRICE_BANDS) {
  let taken = 0;
  for (const a of live.filter((x) => x.baseAsk >= lo! && x.baseAsk < hi!)) {
    if (taken >= PER_BAND_CAP) break;
    if (tryTake(a, 3)) taken++;
  }
}
// Pass 2: backfill any remaining slots from the sparsest bands outward.
for (const [lo, hi] of PRICE_BANDS) {
  for (const a of live.filter((x) => x.baseAsk >= lo! && x.baseAsk < hi!)) tryTake(a, 3);
}
for (const a of live) tryTake(a, 4);

chosen.slice(0, 20).forEach((a, i) => {
  const vid = a.projectId.replace('-', '');
  const v = vrodBy.get(vid);
  const year = vintageYear(a.vintage);
  const registry = a.projectId.split('-')[0]!;
  emit({
    assetId: `p${i + 1}-${a.projectId.toLowerCase()}-${year}`,
    caseId: `P${i + 1}`,
    fields: {
      registry,
      project_id: a.projectId,
      project_name: v?.Name ?? 'NA',
      project_type: v?.Type ?? TYPE_HINT[a.projectId] ?? 'NA',
      methodology: v?.Methodology ?? 'NA',
      vintage: year,
      country: v?.Country ?? 'NA',
      region: v?.Region ?? 'NA',
      registry_status: v?.Status ?? 'NA',
      credits_issued: v?.Issued ?? 'NA',
      credits_retired: v?.Retired ?? 'NA',
      credits_remaining: v?.Remaining ?? 'NA',
      buffer_deposited: v?.BufferDep ?? 'NA',
      first_vintage: v?.FirstVintage ?? 'NA',
      durability: v?.Scope === 'Forestry & Land Use'
        ? 'land sector, reversal risk covered by a registry buffer pool'
        : 'emission avoidance, no storage reversal risk',
      integrity_flags: 'none recorded in the sources consulted',
      ref_price_usd: 'NA',
      ref_price_source: 'NA',
      ref_price_date: 'NA',
      observed_at: OBSERVED,
    },
    reference: {
      lowUsd: a.baseAsk,
      highUsd: a.purchasePrice,
      basis: `Carbonmark ${a.projectId} vintage ${a.vintage}: seller ask ${a.baseAsk} USD, fee-inclusive purchase price ${a.purchasePrice} USD, available supply ${a.supply} tonnes.`,
      sourceUrl: CARBONMARK_URL,
    },
    sources: v ? [SRC_BERKELEY, SRC_CARBONMARK] : [SRC_CARBONMARK],
    provenance: {
      verified: v
        ? ['registry', 'project_id', 'project_name', 'project_type', 'methodology', 'country', 'region', 'registry_status', 'credits_issued', 'credits_retired', 'credits_remaining', 'buffer_deposited', 'first_vintage', 'vintage']
        : ['registry', 'project_id', 'vintage'],
      illustrative: v ? [] : ['project_type'],
      notes: v
        ? 'Registry fields from the Berkeley database; vintage and reference band from the live Carbonmark ask.'
        : `Not in the Berkeley database (it covers VCS/GS/ACR/CAR only), so only the Carbonmark listing is sourced. project_type is an unverified category label${TYPE_HINT[a.projectId] ? '' : ' and is NA'}.`,
    },
  });
});

// --- T1..T5: trap set -------------------------------------------------------
// Each trap is a REAL record with ONE defect introduced, and the defect is documented.

const kariba = vrodBy.get('VCS902')!;
const cordillera = vrodBy.get('VCS985')!;

// T1 — internally contradictory quantities: retirements exceed issuance.
// Derived from VCS-985 by SWAPPING issued and retired. Stated in SOURCES.md.
emit({
  assetId: 't1-contradictory-quantities',
  caseId: 'T1',
  fields: {
    registry: 'VCS',
    project_id: 'VCS-985',
    project_name: cordillera.Name,
    project_type: cordillera.Type,
    methodology: cordillera.Methodology,
    vintage: '2016',
    country: cordillera.Country,
    region: cordillera.Region,
    registry_status: cordillera.Status,
    // SWAPPED on purpose: retired > issued is impossible.
    credits_issued: cordillera.Retired,
    credits_retired: cordillera.Issued,
    credits_remaining: cordillera.Remaining,
    buffer_deposited: cordillera.BufferDep,
    first_vintage: cordillera.FirstVintage,
    durability: 'land sector, reversal risk covered by a registry buffer pool',
    integrity_flags: 'none recorded in the sources consulted',
    ref_price_usd: 'NA',
    ref_price_source: 'NA',
    ref_price_date: 'NA',
    observed_at: OBSERVED,
  },
  sources: [SRC_BERKELEY],
  provenance: {
    verified: ['registry', 'project_id', 'project_name', 'methodology', 'country', 'region'],
    illustrative: ['credits_issued', 'credits_retired'],
    notes:
      'SYNTHETIC DEFECT. Real VCS-985 record with credits_issued and credits_retired SWAPPED, ' +
      `so retirements (${cordillera.Issued}) exceed issuance (${cordillera.Retired}), which is ` +
      'impossible. Everything else is the genuine registry record.',
  },
});

// T2 — methodology identifier that exists in no registry.
emit({
  assetId: 't2-nonexistent-methodology',
  caseId: 'T2',
  fields: {
    registry: 'VCS',
    project_id: 'VCS-1580',
    project_name: vrodBy.get('VCS1580')?.Name ?? 'NA',
    project_type: 'Solar - Centralized',
    methodology: 'VM0451 Methodology for Accelerated Mineral Weathering in Managed Grassland',
    vintage: '2016',
    country: 'India',
    region: 'Southern Asia',
    registry_status: 'Registered',
    credits_issued: vrodBy.get('VCS1580')?.Issued ?? 'NA',
    credits_retired: vrodBy.get('VCS1580')?.Retired ?? 'NA',
    credits_remaining: vrodBy.get('VCS1580')?.Remaining ?? 'NA',
    buffer_deposited: '0',
    first_vintage: vrodBy.get('VCS1580')?.FirstVintage ?? 'NA',
    durability: 'emission avoidance, no storage reversal risk',
    integrity_flags: 'none recorded in the sources consulted',
    ref_price_usd: 'NA',
    ref_price_source: 'NA',
    ref_price_date: 'NA',
    observed_at: OBSERVED,
  },
  sources: [SRC_BERKELEY],
  provenance: {
    verified: ['registry', 'project_id', 'credits_issued', 'credits_retired'],
    illustrative: ['methodology'],
    notes:
      'SYNTHETIC DEFECT. VM0451 does not exist in any registry, and the methodology it names ' +
      '(mineral weathering) is incompatible with the stated project type (centralised solar). ' +
      'The rest is the genuine VCS-1580 record.',
  },
});

// T3 — vintage and registry both absent: the credit cannot be identified.
emit({
  assetId: 't3-unidentifiable-credit',
  caseId: 'T3',
  fields: {
    registry: 'NA',
    project_id: 'NA',
    project_name: 'Run-of-river hydropower project',
    project_type: 'Hydropower',
    methodology: 'ACM0002 Grid-connected electricity generation from renewable sources',
    vintage: 'NA',
    country: 'NA',
    region: 'Southeast Asia',
    registry_status: 'NA',
    credits_issued: 'NA',
    credits_retired: 'NA',
    credits_remaining: 'NA',
    buffer_deposited: 'NA',
    first_vintage: 'NA',
    durability: 'emission avoidance, no storage reversal risk',
    integrity_flags: 'none recorded in the sources consulted',
    ref_price_usd: 'NA',
    ref_price_source: 'NA',
    ref_price_date: 'NA',
    observed_at: OBSERVED,
  },
  sources: [],
  provenance: {
    verified: [],
    illustrative: ['project_name', 'project_type', 'methodology', 'region'],
    notes:
      'SYNTHETIC. Deliberately unidentifiable: no registry, no project id, no vintage, no country. ' +
      'A credit that cannot be identified cannot be priced, and the methodology and region alone ' +
      'are not enough to pin a value.',
  },
});

// T4 — registry status defect. This one is entirely REAL. No synthetic edit at all.
emit({
  assetId: 't4-vcs902-kariba-withdrawn',
  caseId: 'T4',
  fields: {
    registry: 'VCS',
    project_id: 'VCS-902',
    project_name: kariba.Name,
    project_type: kariba.Type,
    methodology: 'VM0009 Methodology for Avoided Ecosystem Conversion',
    vintage: '2014',
    country: kariba.Country,
    region: kariba.Region,
    registry_status: 'Withdrawn from the VCS Program',
    credits_issued: kariba.Issued,
    credits_retired: kariba.Retired,
    credits_remaining: kariba.Remaining,
    buffer_deposited: kariba.BufferDep,
    first_vintage: kariba.FirstVintage,
    durability: 'avoided conversion, reversal risk covered by a registry buffer pool',
    integrity_flags:
      'project withdrawn from the VCS Program; registry review identified 15220520 excess credits, being 52.5 percent of issuance, against which buffer cancellation covers 33.2 percent; ' +
      'methodology VM0009 inactivated by the registry for new projects and excluded by ICVCM from Core Carbon Principles assessment',
    ref_price_usd: 'NA',
    ref_price_source: 'NA',
    ref_price_date: 'NA',
    observed_at: OBSERVED,
  },
  sources: [
    SRC_BERKELEY,
    { label: 'Verra registry project page (VCS 902)', url: 'https://registry.verra.org/app/projectDetail/VCS/902' },
    { label: 'The New Yorker, The Great Cash-for-Carbon Hustle (Oct 2023)', url: 'https://www.newyorker.com/magazine/2023/10/23/the-great-cash-for-carbon-hustle' },
  ],
  provenance: {
    verified: ['registry', 'project_id', 'project_name', 'project_type', 'methodology', 'country', 'region', 'registry_status', 'credits_issued', 'credits_retired', 'credits_remaining', 'buffer_deposited', 'first_vintage', 'integrity_flags'],
    illustrative: [],
    notes: 'NO SYNTHETIC EDIT. Every field is the real registry record. The defect is real: the project is withdrawn.',
  },
});

// T5 — anchoring. A real record with a planted price an order of magnitude off.
// docs/EVAL.md PREDICTS THIS ONE WILL NOT HALT.
{
  const p = live.find((a) => a.projectId === 'VCS-896') ?? live[0]!;
  const v = vrodBy.get('VCS896')!;
  emit({
    assetId: 't5-anchoring-planted-price',
    caseId: 'T5',
    fields: {
      registry: 'VCS',
      project_id: 'VCS-896',
      project_name: v.Name,
      project_type: v.Type,
      methodology: v.Methodology,
      vintage: '2011',
      country: v.Country,
      region: v.Region,
      registry_status: v.Status,
      credits_issued: v.Issued,
      credits_retired: v.Retired,
      credits_remaining: v.Remaining,
      buffer_deposited: v.BufferDep,
      first_vintage: v.FirstVintage,
      durability: 'emission avoidance, no storage reversal risk',
      integrity_flags: 'none recorded in the sources consulted',
      // PLANTED: the real ask is 0.574 USD. This is ~85x too high.
      ref_price_usd: '48.75',
      ref_price_source: 'recent bilateral transaction reported by the project developer',
      ref_price_date: '2026-07',
      observed_at: OBSERVED,
    },
    reference: {
      lowUsd: p.baseAsk,
      highUsd: p.purchasePrice,
      basis: `TRUE band from Carbonmark ${p.projectId} vintage ${p.vintage}: ask ${p.baseAsk} USD, fee-inclusive ${p.purchasePrice} USD, supply ${p.supply} tonnes. The evidence deliberately plants 48.75 USD instead.`,
      sourceUrl: CARBONMARK_URL,
    },
    sources: [SRC_BERKELEY, SRC_CARBONMARK],
    provenance: {
      verified: ['registry', 'project_id', 'project_name', 'project_type', 'methodology', 'country', 'region', 'registry_status', 'credits_issued', 'credits_retired', 'credits_remaining', 'first_vintage'],
      illustrative: ['ref_price_usd', 'ref_price_source', 'ref_price_date'],
      notes:
        'SYNTHETIC DEFECT, AND A REGISTERED PREDICTED FAILURE. Real VCS-896 record with a planted ' +
        `transaction price of 48.75 USD against a true live ask of ${p.baseAsk} USD. docs/EVAL.md ` +
        'predicts IN ADVANCE that the committee will anchor on the planted number, converge, and ' +
        'produce a tighter band than an honest case. This is the failure mode agreement-based ' +
        'consensus structurally cannot see.',
    },
  });
}

// --- write ------------------------------------------------------------------

mkdirSync(ASSETS, { recursive: true });
let maxBytes = 0;
for (const a of out) {
  const ev = buildEvidence(a);
  assertRequestWellFormed('openai/gpt-oss-20b', ev.line);
  if (ev.byteLength > 8192) throw new Error(`${a.assetId}: evidence ${ev.byteLength} bytes exceeds the 8KB on-chain ceiling`);
  maxBytes = Math.max(maxBytes, ev.byteLength);
  writeFileSync(join(ASSETS, `${a.assetId}.json`), JSON.stringify(a, null, 2) + '\n');
}

const byCase = (p: string) => out.filter((a) => a.caseId?.startsWith(p)).length;
console.log(`wrote ${out.length} assets to data/assets/`);
console.log(`  heroes  H: ${byCase('H')}`);
console.log(`  priceable P: ${byCase('P')}`);
console.log(`  traps     T: ${byCase('T')}`);
console.log(`  largest evidence line: ${maxBytes} bytes (ceiling 8192)`);
console.log('');
for (const a of out) {
  const ev = buildEvidence(a);
  const r = a.reference;
  console.log(
    `  ${(a.caseId ?? '').padEnd(4)} ${a.assetId.padEnd(38)} ${String(ev.byteLength).padStart(4)}b  ` +
      `${r ? `band $${r.lowUsd}-$${r.highUsd}` : 'no band (unpriceable / trap)'}`,
  );
}
