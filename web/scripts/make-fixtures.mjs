/**
 * Writes the replay fixtures in `web/fixtures/`.
 *
 * These are stand-ins for rounds recorded by the appraisal service, and they are built the
 * same way a real round is: the request bytes are assembled from the on-chain prompt schema,
 * both halves are hashed with sha256, and the `<reqSha>:<respSha>` string is signed with a
 * secp256k1 key. That means the dashboard's own re-verification pass succeeds against them
 * and the evidence view shows a digest that genuinely matches the bytes above it.
 *
 * The keys below are fixture keys. They hold nothing, correspond to no enclave, and are never
 * presented as live data: every record written here carries `source: "fixture"`, and the views
 * refuse to render a fixture as though it came from the selected network.
 *
 * Run with `pnpm fixtures`.
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, toHex } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DEST = join(HERE, '..', 'fixtures');

const schema = JSON.parse(readFileSync(join(ROOT, 'schema.appraisal.v1.json'), 'utf8'));
const HEAD = Buffer.from(schema.head.slice(2), 'hex').toString('utf8');
const MID = Buffer.from(schema.mid.slice(2), 'hex').toString('utf8');
const TAIL = Buffer.from(schema.tail.slice(2), 'hex').toString('utf8');

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const buildRequest = (model, evidence) => `${HEAD}${model}${MID}${evidence}${TAIL}`;

// Two enclave keys across five slots: model independence comes from the model id inside the
// signed request bytes, not from a distinct key per model.
const ENCLAVE_A = privateKeyToAccount('0x2f1a6c93b7e08d4517ca0be3d9f26810457bd3ea9c15f82740db6ce31a05879f');
const ENCLAVE_B = privateKeyToAccount('0xb40d7e2ca9f318356021ce4d7b85fa03e619c8d2571ba4970f83c62d15ab7048');

const COMMITTEE = [
  { model: 'google/gemma-4-31b-it', enclave: ENCLAVE_A },
  { model: 'z-ai/glm-5.2', enclave: ENCLAVE_A },
  { model: 'openai/gpt-oss-20b', enclave: ENCLAVE_A },
  { model: 'qwen/qwen3-vl-30b-a3b-instruct', enclave: ENCLAVE_B },
  { model: 'meta/muse-glimmer-30b', enclave: ENCLAVE_B },
];

/** Fixture issuer: the party that lists the asset and commits to its evidence. */
const ISSUER = '0x4C21b7577C8FE8b0554b0Fc6C4C1B2eD0A9DdF63';

const MR_TD_A ='0x' + 'a41f7b2c93d5e0184c6fb27a9d3e5c81f04b6ad2e7c9138ba5f6e0d2c4831b97'.slice(0, 64);
const MR_TD_B = '0x' + 'c73d19ae5f8b204c6e1d93a7f0b52c84d6a1e39fb7c058d2a4e69137bf05c2ea'.slice(0, 64);

// ---------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------

/** Field order matches `backend/src/evidence.ts`; `evidence_sha256` is always emitted last. */
function evidenceLine(fields) {
  const body = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
  const digest = sha256(body);
  return { line: `${body};evidence_sha256=${digest}`, evidenceSha256: digest };
}

const RIMBA = {
  schema: 'assay.carbon.v1',
  asset_id: 'carbon-vcs-985-2021',
  registry: 'Verra VCS',
  project_id: 'VCS-985',
  project_name: 'Rimba Raya Biodiversity Reserve REDD+',
  methodology: 'VM0007 REDD+ MF v1.6',
  project_type: 'avoided unplanned deforestation, tropical peat swamp',
  vintage: '2021',
  country: 'Indonesia',
  region: 'Central Kalimantan',
  credits_issued: '3120450',
  credits_retired: '1874233',
  batch_size: '1',
  cobenefits: 'orangutan habitat,peatland hydrology,community clinics',
  sdgs: '1,3,13,15',
  rating_agency: 'BeZero Carbon',
  rating: 'BBB',
  integrity_flags: 'baseline revised 2023;over-crediting review closed 2024'.replace(/;/g, ','),
  corresponding_adjustment: 'no',
  buffer_pool_pct: '18',
  permanence_years: '30',
  ref_price_usd: '8.55',
  ref_price_source: 'Xpansiv CBL N-GEO spot',
  ref_price_date: '2026-08-19',
  observed_at: '2026-08-20T21:40:00Z',
};

const KARIBA = {
  ...RIMBA,
  asset_id: 'carbon-vcs-902-2019',
  project_id: 'VCS-902',
  project_name: 'Kariba REDD+ Project',
  project_type: 'avoided unplanned deforestation, miombo woodland',
  vintage: '2019',
  country: 'Zimbabwe',
  region: 'Mashonaland West',
  credits_issued: '23610000',
  credits_retired: '9042118',
  cobenefits: 'wildlife corridors,beekeeping,borehole rehabilitation',
  rating_agency: 'BeZero Carbon',
  rating: 'D',
  integrity_flags: 'issuance suspended 2023,baseline over-crediting disputed,verifier withdrawn',
  buffer_pool_pct: '22',
  ref_price_usd: '3.10',
  ref_price_source: 'bilateral OTC, thin',
  ref_price_date: '2026-07-30',
  observed_at: '2026-08-20T21:40:00Z',
};

// ---------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------

function responseBody({ model, created, content, finish = 'stop', id }) {
  // Serialised exactly as the gateway returns it: key order is part of the signed bytes.
  return (
    `{"id":"${id}","object":"chat.completion","created":${created},"model":"${model}",` +
    `"choices":[{"index":0,"message":{"role":"assistant","content":"${content}"},` +
    `"logprobs":null,"finish_reason":"${finish}"}],` +
    `"usage":{"prompt_tokens":508,"completion_tokens":21,"total_tokens":529},` +
    `"system_fingerprint":"tdx_aci_1"}`
  );
}

async function makeMember(spec, ev, created) {
  const { model, enclave } = COMMITTEE[spec.slot];
  const requestBody = buildRequest(model, ev.line);
  const requestSha256 = sha256(requestBody);
  const body = responseBody({
    model,
    created: created + spec.slot,
    content: spec.content,
    finish: spec.finish ?? 'stop',
    id: `chatcmpl-${keccak256(toHex(`${ev.evidenceSha256}:${spec.slot}`)).slice(2, 26)}`,
  });
  const responseSha = sha256(body);
  const signedText = `${requestSha256}:${responseSha}`;

  // A wrong-key signature is how a spoofed enclave presents itself: well formed, recovers to
  // an address the attestation registry has never seen.
  const signer = spec.forgeSignature ? privateKeyToAccount('0x6e3d19b840c27fa5e10db83c94f1057ae2b60d38915cf724ab90e5d3618c7f21') : enclave;
  const signature = await signer.signMessage({ message: signedText });

  return {
    model,
    slot: spec.slot,
    signer: spec.forgeSignature ? signer.address : enclave.address,
    attestedSigner: enclave.address,
    receiptId: keccak256(toHex(signedText)).slice(2, 34),
    requestBody,
    requestSha256,
    responseBody: body,
    responseSha256: responseSha,
    signature,
    signedText,
    signatureOk: !spec.forgeSignature,
    parseOk: spec.parseOk ?? true,
    verdict:
      spec.navE6 !== undefined && (spec.parseOk ?? true)
        ? {
            navUsdE6: String(spec.navE6),
            confidenceBps: spec.confidenceBps,
            evidenceSha256: ev.evidenceSha256,
          }
        : null,
    haltReason: spec.haltReason ?? null,
    latencyMs: spec.latencyMs,
  };
}

function summarise(verdicts, policy) {
  const usable = verdicts.filter((v) => v.signatureOk && v.parseOk && !v.haltReason);
  const navs = usable.map((v) => BigInt(v.verdict.navUsdE6)).sort((a, b) => (a < b ? -1 : 1));
  const med = navs.length
    ? navs.length % 2
      ? navs[(navs.length - 1) / 2]
      : (navs[navs.length / 2 - 1] + navs[navs.length / 2]) / 2n
    : null;
  let dev = null;
  if (med !== null && med !== 0n) {
    dev = 0;
    for (const n of navs) {
      const d = n > med ? n - med : med - n;
      dev = Math.max(dev, Number((d * 10_000n) / med));
    }
  }
  const haltReasons = [];
  if (usable.length < policy.quorum) haltReasons.push(`QUORUM(${usable.length}/${policy.quorum})`);
  if (dev !== null && dev > policy.bandBps)
    haltReasons.push(`DISAGREEMENT(${dev}bps > ${policy.bandBps}bps)`);
  for (const v of verdicts) if (v.haltReason) haltReasons.push(`${v.model}:${v.haltReason}`);

  return {
    summary: {
      requested: verdicts.length,
      signatureOk: verdicts.filter((v) => v.signatureOk).length,
      parseOk: verdicts.filter((v) => v.parseOk).length,
      usable: usable.length,
      navsUsdE6: navs.map(String),
      medianUsdE6: med === null ? null : String(med),
      maxDeviationBps: dev,
      wouldHalt: usable.length < policy.quorum || (dev !== null && dev > policy.bandBps),
      haltReasons,
    },
    medianE6: med,
    maxDeviationBps: dev,
    usable,
  };
}

const POLICY = {
  quorum: 3,
  minDistinctSigners: 2,
  bandBps: 1000,
  minConfidenceBps: 5000,
  maxAgeSec: 3600,
  disputeBandBps: 500,
};

async function buildBundle({ id, assetKey, assetLabel, fields, specs, createdAt, epoch, txHash, blockNumber, chainId }) {
  const ev = evidenceLine(fields);
  const created = Math.floor(new Date(createdAt).getTime() / 1000);
  const verdicts = [];
  for (const spec of specs) verdicts.push(await makeMember(spec, ev, created));

  const { summary, medianE6, usable } = summarise(verdicts, POLICY);
  const distinct = new Set(usable.map((v) => v.attestedSigner.toLowerCase())).size;
  const published = !summary.wouldHalt && distinct >= POLICY.minDistinctSigners;

  const slots = verdicts.map((v) => {
    const spec = specs.find((s) => s.slot === v.slot);
    const rejected = spec.rejectReason ?? null;
    return {
      slot: v.slot,
      signer: v.signer,
      accepted: rejected === null,
      rejectReason: rejected,
      navE6: rejected === null ? String(spec.navE6) : null,
      confidenceBps: rejected === null ? spec.confidenceBps : null,
      createdAt: created + v.slot,
    };
  });

  const postedAt = created + 47;

  return {
    bundleId: id,
    createdAt,
    promptVersion: 'assay.appraisal.v1',
    assetId: fields.asset_id,
    assetLabel,
    assetIdHash: keccak256(toHex(assetKey)),
    evidence: {
      line: ev.line,
      evidenceSha256: ev.evidenceSha256,
      lineSha256: sha256(ev.line),
      byteLength: Buffer.byteLength(ev.line, 'utf8'),
    },
    systemPromptSha256: sha256(MID.slice(MID.indexOf('"content":"') + 11, MID.indexOf('"}'))),
    committee: COMMITTEE.map((c) => c.model),
    verdicts,
    summary,
    policy: POLICY,
    onChain: {
      chainId,
      epoch,
      txHash,
      blockNumber,
      timestamp: postedAt,
      published,
      navE6: published ? String(medianE6) : null,
      haltReason: published
        ? null
        : summary.usable < POLICY.quorum || distinct < POLICY.minDistinctSigners
          ? 'InsufficientQuorum'
          : 'Disagreement',
      accepted: slots.filter((s) => s.accepted).length,
      distinctSigners: distinct,
      observedAt: created,
      evidenceHash: `0x${sha256(ev.line)}`,
      slots,
      authenticated: verdicts.filter((v) => v.signatureOk).length,
      ignored: false,
      // The issuer commits to the digest before the round runs. Without this the round reverts
      // with EvidenceNotCommitted, so it is part of the record rather than a detail.
      evidenceCommitment: {
        committed: true,
        issuer: ISSUER,
        uri: `ipfs://assay/evidence/${ev.evidenceSha256.slice(0, 16)}`,
        txHash: `0x${sha256(`commit:${ev.evidenceSha256}`).slice(0, 64)}`,
        blockNumber: String(Number(blockNumber) - 6),
        timestamp: created - 240,
      },
    },
    source: 'fixture',
  };
}

// ---------------------------------------------------------------------------------------

const BUNDLES = [
  {
    id: 'fixture-rimba-published',
    assetKey: 'assay.carbon.demo.v1',
    assetLabel: 'Rimba Raya REDD+ · Verra VCS-985 · vintage 2021',
    fields: RIMBA,
    createdAt: '2026-08-20T21:41:12.000Z',
    epoch: 47,
    txHash: '0x7b19f4c0a1d8e35b2f6c907ae4d13b8c25f0e9a7d64b3c18ef2a05d7913cc4a2',
    blockNumber: '9184402',
    chainId: 196,
    specs: [
      { slot: 0, navE6: 8_420_000, confidenceBps: 7200, latencyMs: 2140, content: 'ASSAY1|nav_usd_e6=8420000|confidence_bps=7200' },
      { slot: 1, navE6: 8_610_000, confidenceBps: 8100, latencyMs: 3380, content: 'ASSAY1|nav_usd_e6=8610000|confidence_bps=8100' },
      { slot: 2, navE6: 8_500_000, confidenceBps: 6900, latencyMs: 1720, content: 'ASSAY1|nav_usd_e6=8500000|confidence_bps=6900' },
      { slot: 3, navE6: 8_390_000, confidenceBps: 7500, latencyMs: 2905, content: 'ASSAY1|nav_usd_e6=8390000|confidence_bps=7500' },
      { slot: 4, navE6: 8_550_000, confidenceBps: 8800, latencyMs: 2460, content: 'ASSAY1|nav_usd_e6=8550000|confidence_bps=8800' },
    ],
  },
  {
    id: 'fixture-rimba-disagreement',
    assetKey: 'assay.carbon.demo.v1',
    assetLabel: 'Rimba Raya REDD+ · Verra VCS-985 · vintage 2021',
    fields: { ...RIMBA, observed_at: '2026-08-20T22:15:00Z', ref_price_date: '2026-08-20' },
    createdAt: '2026-08-20T22:16:04.000Z',
    epoch: 48,
    txHash: '0x3f0d5b8c72e419a6d035fc81b47ea92d6c518f30ab7d249e0c6135ba8d719e17',
    blockNumber: '9185218',
    chainId: 196,
    specs: [
      { slot: 0, navE6: 8_420_000, confidenceBps: 7200, latencyMs: 2240, content: 'ASSAY1|nav_usd_e6=8420000|confidence_bps=7200' },
      { slot: 1, navE6: 8_610_000, confidenceBps: 8100, latencyMs: 3110, content: 'ASSAY1|nav_usd_e6=8610000|confidence_bps=8100' },
      // Prices the whole issuance rather than one tonne. Verifies perfectly, and is wrong.
      { slot: 2, navE6: 12_900_000, confidenceBps: 9100, latencyMs: 1980, content: 'ASSAY1|nav_usd_e6=12900000|confidence_bps=9100' },
      // Adds a sentence of prose before the marker line. The strict parser refuses it.
      {
        slot: 3,
        parseOk: false,
        latencyMs: 4210,
        rejectReason: 'Malformed',
        haltReason: 'HALT:PARSE (content did not begin with the marker)',
        content:
          'Based on the evidence record, the fair value is approximately 8.6 USD per tonne. ASSAY1|nav_usd_e6=8600000|confidence_bps=6400',
      },
      { slot: 4, navE6: 8_390_000, confidenceBps: 8800, latencyMs: 2530, content: 'ASSAY1|nav_usd_e6=8390000|confidence_bps=8800' },
    ],
  },
  {
    id: 'fixture-kariba-quorum',
    assetKey: 'assay.carbon.kariba.v1',
    assetLabel: 'Kariba REDD+ · Verra VCS-902 · vintage 2019',
    fields: KARIBA,
    createdAt: '2026-08-20T20:52:33.000Z',
    epoch: 12,
    txHash: '0x91ce02f7ab4d63158e0c7d29b5f841ea36c0d8b7194fa25e63c08da4172b5f6d',
    blockNumber: '9186031',
    chainId: 196,
    specs: [
      { slot: 0, navE6: 3_050_000, confidenceBps: 5400, latencyMs: 2610, content: 'ASSAY1|nav_usd_e6=3050000|confidence_bps=5400' },
      // Generation hit the token ceiling. Nothing complete to price on.
      {
        slot: 1,
        parseOk: false,
        finish: 'length',
        latencyMs: 5320,
        rejectReason: 'Truncated',
        haltReason: 'HALT:TRUNCATED',
        content: 'ASSAY1|nav_usd_e6=31',
      },
      // Signature recovers to a key the registry has never attested.
      {
        slot: 2,
        forgeSignature: true,
        navE6: 3_100_000,
        confidenceBps: 6000,
        latencyMs: 2210,
        rejectReason: 'UnknownSigner',
        haltReason: 'HALT:BAD_SIGNATURE (recovered key not attested)',
        content: 'ASSAY1|nav_usd_e6=3100000|confidence_bps=6000',
      },
      // Below the confidence floor this asset sets.
      {
        slot: 3,
        navE6: 2_900_000,
        confidenceBps: 3100,
        latencyMs: 3040,
        rejectReason: 'LowConfidence',
        haltReason: 'HALT:LOW_CONFIDENCE(3100)',
        content: 'ASSAY1|nav_usd_e6=2900000|confidence_bps=3100',
      },
      { slot: 4, navE6: 3_120_000, confidenceBps: 5800, latencyMs: 2380, content: 'ASSAY1|nav_usd_e6=3120000|confidence_bps=5800' },
    ],
  },
];

// ---------------------------------------------------------------------------------------

mkdirSync(DEST, { recursive: true });

const written = [];
for (const spec of BUNDLES) {
  const bundle = await buildBundle(spec);
  const file = `${spec.id}.json`;
  writeFileSync(join(DEST, file), JSON.stringify(bundle, null, 2) + '\n');
  written.push(file);
  console.log(
    `wrote fixtures/${file}  epoch ${bundle.onChain.epoch}  ` +
      `${bundle.onChain.published ? `published ${bundle.onChain.navE6}` : `HALT ${bundle.onChain.haltReason}`}`,
  );
}

// Attestation registry snapshot for replay mode.
const attestedAt = Math.floor(new Date('2026-08-18T09:12:44.000Z').getTime() / 1000);
const attestation = {
  // Deliberately not a mainnet chain id. A fabricated trust root must never be able to render
  // as though it were live mainnet data, so the snapshot is scoped to the test network and the
  // view labels it as a recording regardless.
  chainId: 1952,
  source: 'fixture',
  capturedAt: Math.floor(new Date('2026-08-20T22:45:00.000Z').getTime() / 1000),
  adapter: {
    address: '0x5cE9a1D4b3f07E2864aB0C179d8Fe5731ab2c7E0',
    label: 'UnverifiedQuoteAdapter',
    isTrusted: false,
  },
  attestationTtlSec: 604_800,
  signerOffset: 0,
  signers: [
    {
      address: ENCLAVE_A.address,
      mrTd: MR_TD_A,
      tcbStatus: 0,
      tcbStatusLabel: 'UpToDate',
      attestedAt,
      revoked: false,
      models: COMMITTEE.slice(0, 3).map((c) => c.model),
      txHash: '0x2ad7196c4f0b83e51d9a06fc7b2384ea15d0c9f7368ba24e05d1c7638fa091bc',
      blockNumber: '9174880',
      quoteBytes: 10012,
      gpuArch: 'HOPPER',
      reportData: `${ENCLAVE_A.address.slice(2).toLowerCase()}000000000000000000000000a718de911b589f6e0e1766b85c52822812d84358bc8a6dd56f9cf8aa092480b4`,
    },
    {
      address: ENCLAVE_B.address,
      mrTd: MR_TD_B,
      tcbStatus: 2,
      tcbStatusLabel: 'SWHardeningNeeded',
      attestedAt: attestedAt - 43_200,
      revoked: false,
      models: COMMITTEE.slice(3).map((c) => c.model),
      txHash: '0x8e340bd17c5a92f6084be3d1fa72c95d0b6318ae47f9d2c05b183ea6712d40cf',
      blockNumber: '9174902',
      quoteBytes: 10012,
      gpuArch: 'HOPPER',
      reportData: `${ENCLAVE_B.address.slice(2).toLowerCase()}000000000000000000000000d2d442da541154181d8a5b0d369bfc1d9b14f581b3955e60c8fe0c315a033d0a`,
    },
  ],
};
writeFileSync(join(DEST, 'attestation.json'), JSON.stringify(attestation, null, 2) + '\n');
console.log('wrote fixtures/attestation.json');

console.log(`\nenclave A ${ENCLAVE_A.address}\nenclave B ${ENCLAVE_B.address}`);
