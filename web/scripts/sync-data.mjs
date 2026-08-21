/**
 * Bakes the deployment manifests, the recorded rounds and the recorded chain state into
 * `src/generated/data.ts`.
 *
 * The dashboard is a static export, so there is nothing at runtime that can read a file.
 * Everything a reader needs to look at with no wallet and no credentials is compiled in here
 * instead. Rounds recorded by the appraisal service in `backend/data/bundles/` always win;
 * the worked examples in `web/fixtures/` only fill an outcome the recorded set does not yet
 * cover, and they stay labelled as fixtures so nothing is presented as live data that is not.
 *
 * Runs automatically before `dev` and `build`. It never touches the network — the live figures
 * it needs are captured beforehand by `scripts/snapshot-chain.mjs`.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BUNDLES = join(ROOT, 'backend', 'data', 'bundles');
const DEPLOYMENTS = join(ROOT, 'deployments');
const FIXTURES = join(HERE, '..', 'fixtures');
const RECORDED = join(HERE, '..', 'data');
const DEST = join(HERE, '..', 'src', 'generated');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const jsonFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// --- deployments -----------------------------------------------------------------------

const deployments = {};
for (const file of jsonFiles(DEPLOYMENTS)) {
  const d = readJson(join(DEPLOYMENTS, file));
  const chainId = Number(d.chainId ?? file.replace('.json', ''));
  if (!Number.isFinite(chainId)) continue;
  deployments[chainId] = { ...d, chainId };
}

// --- recorded chain state --------------------------------------------------------------

/** Trust root and asset policy per chain, as captured from the live contracts. */
const attestations = {};
const policies = {};
const blocks = {};

/** Settlement transactions, read back off the chain, per network. */
const settlements = {};

for (const file of jsonFiles(RECORDED)) {
  const match = /^(attestation|policy|blocks|vault)\.(\d+)\.json$/.exec(file);
  if (!match) continue;
  const [, kind, id] = match;
  const chainId = Number(id);
  const data = readJson(join(RECORDED, file));
  if (kind === 'attestation') attestations[chainId] = { ...data, chainId, source: data.source ?? 'live' };
  else if (kind === 'policy') policies[chainId] = { ...data, chainId };
  else if (kind === 'vault') settlements[chainId] = data.settlements ?? [];
  else blocks[chainId] = data;
}

// A worked example only stands in for a chain that has nothing recorded for it.
if (existsSync(join(FIXTURES, 'attestation.json'))) {
  const fixture = readJson(join(FIXTURES, 'attestation.json'));
  const chainId = Number(fixture.chainId);
  if (!attestations[chainId]) attestations[chainId] = { ...fixture, source: 'fixture' };
}

// --- rounds ----------------------------------------------------------------------------

/** `<assetId>-latest.json` duplicates a timestamped file; skip it so rounds are not doubled. */
const isAlias = (name) => name.endsWith('-latest.json');

/**
 * The contract's halt ordinals, as the appraisal service spells them. `Band` and `Quorum` are
 * the service's shorthand for the two the oracle actually emits.
 */
const HALT_REASONS = {
  band: 'Disagreement',
  disagreement: 'Disagreement',
  quorum: 'InsufficientQuorum',
  insufficientquorum: 'InsufficientQuorum',
  sequencerdown: 'SequencerDown',
  assetinactive: 'AssetInactive',
  unauthenticated: 'Unauthenticated',
  none: 'None',
};

const REJECT_REASONS = new Set([
  'None',
  'BadSignature',
  'UnknownSigner',
  'SignerExpired',
  'SignerRevoked',
  'WrongModel',
  'Truncated',
  'Malformed',
  'OutOfRange',
  'LowConfidence',
  'Stale',
  'DuplicateSlot',
  'NoTimestamp',
]);

const ZERO = '0x0000000000000000000000000000000000000000';

const haltReason = (raw) => (raw ? (HALT_REASONS[String(raw).toLowerCase()] ?? 'Disagreement') : null);

const rejectReason = (raw) => {
  if (!raw || raw === 'None') return null;
  return REJECT_REASONS.has(raw) ? raw : 'Malformed';
};

const nonEmpty = (v) => (v === undefined || v === null || v === '' ? null : v);

/**
 * The policy the round was actually judged against, which is the one registered for the asset
 * the round was posted under — not whatever else the deployment happens to list.
 */
function assetPolicy(raw) {
  const chainId = Number(raw.onChain?.chainId ?? 0);
  const assets = policies[chainId]?.assets;
  if (!assets) return null;
  for (const key of [raw.onChain?.assetId, raw.assetIdHex, raw.assetIdHash]) {
    if (typeof key === 'string' && assets[key]) return assets[key];
  }
  return null;
}

/** Reads the `key=value;key=value` evidence line into a map. */
function evidenceFields(line) {
  const out = {};
  for (const part of String(line ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** A title for the specimen, assembled from what the evidence itself states about it. */
function assetLabel(fields, fallback) {
  const name = fields.project_name ?? fields.asset_name;
  if (!name) return fallback;
  const provenance = [fields.registry, fields.project_id].filter(Boolean).join(' ');
  const vintage = fields.vintage ? `vintage ${fields.vintage}` : null;
  return [name, provenance || null, vintage].filter(Boolean).join(' · ');
}

/** The single answer line the contract's parser looks for, pulled back out of a response. */
function readAnswer(responseBody) {
  const match = /ASSAY1\|nav_usd_e6=(\d+)\|confidence_bps=(\d+)/.exec(responseBody ?? '');
  return match ? { navUsdE6: match[1], confidenceBps: Number(match[2]) } : null;
}

/** The system prompt every seat was given, hashed as the service hashes it. */
function systemPromptHash(slots) {
  for (const s of slots ?? []) {
    try {
      const messages = JSON.parse(s.requestBody).messages ?? [];
      const system = messages.find((m) => m.role === 'system');
      if (system?.content) return sha256(system.content);
    } catch {
      /* a slot whose request never formed cannot answer this */
    }
  }
  return '';
}

/**
 * Rewrites a round as the appraisal service records it into the shape the views read.
 *
 * Nothing is invented here. Every figure is carried across from the record, and a field the
 * record does not carry is left absent rather than filled with a plausible number — the views
 * are built to show an absence as an absence.
 */
function normaliseRecorded(raw, chainBlocks) {
  const slots = raw.slots ?? raw.verdicts ?? [];
  const oc = raw.onChain ?? null;
  const outcomeBySlot = new Map();
  for (const s of oc?.slots ?? []) outcomeBySlot.set(Number(s.slot), s);

  const fields = evidenceFields(raw.evidence?.line);
  const times = chainBlocks?.timestamps ?? {};
  const commitmentBlocks = chainBlocks?.commitmentBlocks ?? {};

  const verdicts = slots.map((s, i) => {
    const slot = Number(s.slot ?? i);
    const outcome = outcomeBySlot.get(slot);
    const reason = rejectReason(outcome?.reason ?? outcome?.rejectReason ?? null);
    const preflightReason = s.preflight?.reason ?? null;
    const answer = readAnswer(s.responseBody);

    // The recovered signer is the chain's, not the record's: a bad signature recovers to
    // nothing, and saying so is the whole point of the slot.
    const recovered = outcome?.signer && outcome.signer !== ZERO ? outcome.signer : null;

    const navUsdE6 = nonEmpty(outcome?.navE6) ?? answer?.navUsdE6 ?? null;
    const confidenceBps = outcome?.confidenceBps ?? answer?.confidenceBps ?? null;

    return {
      model: s.model,
      slot,
      signer: recovered ?? (reason === 'BadSignature' ? null : (nonEmpty(s.attestedSigner) ?? null)),
      attestedSigner: nonEmpty(s.attestedSigner) ?? null,
      receiptId: nonEmpty(s.receiptId) ?? null,
      requestBody: s.requestBody ?? '',
      requestSha256: s.requestSha256 ?? '',
      responseBody: s.responseBody ?? '',
      responseSha256: s.responseSha256 ?? '',
      signature: nonEmpty(s.signature) ?? null,
      signedText: nonEmpty(s.gatewayText ?? s.signedText) ?? null,
      gatewayText: nonEmpty(s.gatewayText) ?? null,
      signatureOk: reason === 'BadSignature' ? false : (s.gatewayTextMatches ?? s.signatureOk ?? true),
      parseOk:
        preflightReason === null || preflightReason === 'None'
          ? answer !== null
          : !['Truncated', 'Malformed'].includes(preflightReason),
      verdict:
        navUsdE6 !== null && confidenceBps !== null
          ? {
              navUsdE6: String(navUsdE6),
              confidenceBps: Number(confidenceBps),
              evidenceSha256: raw.evidence?.sha256 ?? '',
            }
          : null,
      haltReason: nonEmpty(s.failure) && s.failure !== 'None at null: ' ? s.failure : null,
      latencyMs: Number(s.latencyMs ?? 0),
      onChainAccepted: outcome ? Boolean(outcome.accepted) : undefined,
      onChainRejectReason: outcome ? reason : undefined,
    };
  });

  const accepted = (oc?.slots ?? []).filter((s) => s.accepted);
  const navs =
    raw.summary?.navsE6?.length > 0
      ? raw.summary.navsE6.map(String)
      : accepted.map((s) => nonEmpty(s.navE6)).filter(Boolean).map(String);

  const commitment = oc?.evidenceCommitment ?? null;
  const commitmentBlock = commitment?.txHash ? commitmentBlocks[commitment.txHash] : undefined;

  const onChain = oc
    ? {
        chainId: Number(oc.chainId),
        epoch: Number(oc.epoch ?? 0),
        txHash: oc.txHash,
        blockNumber: String(oc.blockNumber ?? ''),
        timestamp: times[String(oc.blockNumber)] ?? null,
        published: Boolean(oc.published),
        navE6: nonEmpty(oc.navE6) === null ? null : String(oc.navE6),
        haltReason: oc.published ? null : haltReason(oc.haltReason),
        accepted: Number(oc.accepted ?? accepted.length),
        distinctSigners: Number(oc.distinctSigners ?? 0),
        observedAt: oc.observedAt ?? null,
        assetId: oc.assetId ?? null,
        oracle: oc.oracle ?? null,
        evidenceHash: oc.evidenceHash,
        gasUsed: oc.gasUsed ?? null,
        explorer: oc.explorer ?? null,
        txUrl: oc.txUrl ?? null,
        slots: (oc.slots ?? []).map((s) => ({
          slot: Number(s.slot),
          signer: s.signer && s.signer !== ZERO ? s.signer : null,
          accepted: Boolean(s.accepted),
          rejectReason: rejectReason(s.reason ?? s.rejectReason ?? null),
          navE6: nonEmpty(s.navE6) === null ? null : String(s.navE6),
          confidenceBps: s.confidenceBps ?? null,
          createdAt: s.createdAt ?? null,
        })),
        evidenceCommitment: commitment
          ? {
              committed: Boolean(commitment.committed),
              issuer: commitment.issuer ?? assetPolicy(raw)?.issuer ?? null,
              uri: nonEmpty(commitment.uri) ?? null,
              txHash: commitment.txHash,
              blockNumber: commitmentBlock ?? null,
              timestamp: commitmentBlock ? (times[commitmentBlock] ?? null) : null,
              preCommitted: commitment.preCommitted ?? null,
            }
          : undefined,
      }
    : undefined;

  const chainPolicy = assetPolicy(raw);

  return {
    bundleId: raw.bundleId,
    createdAt: raw.createdAt,
    promptVersion: raw.promptVersion ?? 'assay.appraisal.v1',
    assetId: raw.assetId,
    assetIdHash: raw.assetIdHex ?? raw.assetIdHash ?? undefined,
    assetLabel: assetLabel(fields, raw.assetLabel ?? raw.assetId),
    evidence: {
      line: raw.evidence?.line ?? '',
      // The line's own digest is what the contract commits to and keys the round by.
      evidenceSha256: fields.evidence_sha256 ?? raw.evidence?.sha256 ?? '',
      lineSha256: raw.evidence?.sha256 ?? '',
      byteLength: Number(raw.evidence?.byteLength ?? 0),
    },
    systemPromptSha256: raw.systemPromptSha256 ?? systemPromptHash(slots),
    committee: raw.committee ?? [],
    verdicts,
    summary: {
      requested: Number(raw.summary?.slots ?? raw.summary?.requested ?? slots.length),
      signatureOk: Number(raw.summary?.signatureOk ?? 0),
      parseOk: verdicts.filter((v) => v.parseOk).length,
      usable: Number(oc?.accepted ?? raw.summary?.usable ?? 0),
      navsUsdE6: navs,
      medianUsdE6: nonEmpty(raw.summary?.medianE6 ?? raw.summary?.medianUsdE6) === null
        ? null
        : String(raw.summary.medianE6 ?? raw.summary.medianUsdE6),
      maxDeviationBps: raw.summary?.maxDeviationBps ?? null,
      wouldHalt: Boolean(raw.summary?.wouldHalt ?? true),
      haltReasons: raw.summary?.haltReasons ?? [],
    },
    policy: chainPolicy
      ? {
          quorum: chainPolicy.quorum,
          minDistinctSigners: chainPolicy.minDistinctSigners,
          bandBps: chainPolicy.bandBps,
          minConfidenceBps: chainPolicy.minConfidenceBps,
          maxAgeSec: chainPolicy.maxAgeSec,
          disputeBandBps: chainPolicy.disputeBandBps,
        }
      : raw.policy,
    onChain,
    source: 'recorded',
  };
}

/** A bundle already in the dashboard's own shape needs nothing doing to it. */
const isNativeShape = (raw) => Array.isArray(raw.verdicts) && raw.verdicts.length > 0 && 'signatureOk' in (raw.verdicts[0] ?? {});

const allRecorded = jsonFiles(BUNDLES)
  .filter((f) => !isAlias(f))
  .map((f) => {
    const raw = readJson(join(BUNDLES, f));
    const chainId = Number(raw.onChain?.chainId ?? 0);
    return isNativeShape(raw)
      ? { ...raw, source: 'recorded' }
      : normaliseRecorded(raw, blocks[chainId]);
  })
  .filter((b) => b.verdicts.length > 0)
  .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

/**
 * The service re-appraises the same specimen every few minutes, so the same asset ends up
 * recorded many times over with the same result. The register carries the latest entry for
 * each specimen and each outcome; the older repeats say nothing the newest does not.
 */
const recorded = [];
const seen = new Set();
for (const b of allRecorded) {
  const key = `${b.onChain?.chainId ?? '—'}:${b.onChain?.assetId ?? b.assetIdHash ?? b.assetId}:${b.assetId}:${Boolean(b.onChain?.published)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  recorded.push(b);
}

// Only `fixture-*.json` are rounds; the directory also holds the attestation worked example.
//
// A worked example carries an illustrative `onChain` overlay: an epoch, a block, transaction
// hashes. Those transactions do not exist. Now that both networks are real, an overlay like
// that would render as a link into a live explorer that resolves to nothing, so it is dropped
// here — the example keeps its answers and its arithmetic, and states plainly that no chain has
// seen it. A worked example may illustrate the mechanism; it may not imitate a receipt.
const fixtures = jsonFiles(FIXTURES)
  .filter((f) => f.startsWith('fixture-'))
  .map((f) => {
    const { onChain, ...bundle } = readJson(join(FIXTURES, f));
    void onChain;
    return { ...bundle, source: 'fixture' };
  });

/**
 * Whether a round published or refused. A recorded round always states this itself; a bundle
 * that has not been posted has only the dashboard's own preview to go on.
 */
const outcomeOf = (b) => (b.onChain ? Boolean(b.onChain.published) : b.summary?.wouldHalt === false);

// A recorded round takes precedence over a fixture for the same outcome, always. The fixtures
// stay only for an outcome nothing recorded covers yet — a reader has to be able to see both a
// published valuation and a refusal, and the refusal is the thing the dashboard exists to show.
let rounds = [...recorded];
const covered = new Set(recorded.map(outcomeOf));
for (const f of fixtures) {
  if (covered.has(outcomeOf(f))) continue;
  rounds.push(f);
  covered.add(outcomeOf(f));
}
if (rounds.length === 0) rounds = fixtures;

// Newest first, and a published round ahead of a refusal at the same instant so the register
// opens on a struck valuation wherever one exists.
rounds.sort((a, b) => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return Number(outcomeOf(b)) - Number(outcomeOf(a));
});

// --- emit ------------------------------------------------------------------------------

mkdirSync(DEST, { recursive: true });

const recordedCount = rounds.filter((r) => r.source === 'recorded').length;
const fixtureCount = rounds.length - recordedCount;

const banner =
  '// Generated by scripts/sync-data.mjs. Do not edit by hand.\n' +
  `// ${recordedCount} recorded round(s), ${fixtureCount} worked example(s), ` +
  `${Object.keys(deployments).length} deployment manifest(s).\n\n`;

writeFileSync(
  join(DEST, 'data.ts'),
  banner +
    `import type { AppraisalBundle } from '@/lib/bundle';\n` +
    `import type { Deployment } from '@/lib/deployments';\n` +
    `import type { AttestationSnapshot } from '@/lib/attestation';\n` +
    `import type { Settlement } from '@/lib/settlement';\n\n` +
    `export const DEPLOYMENTS: Record<number, Deployment> = ${JSON.stringify(deployments, null, 2)};\n\n` +
    `export const ROUNDS: AppraisalBundle[] = ${JSON.stringify(rounds, null, 2)} as unknown as AppraisalBundle[];\n\n` +
    `/** Trust root per chain, captured from the registry by scripts/snapshot-chain.mjs. */\n` +
    `export const ATTESTATIONS: Record<number, AttestationSnapshot> = ${JSON.stringify(attestations, null, 2)} as unknown as Record<number, AttestationSnapshot>;\n\n` +
    `/** Settlement transactions read back off each chain by scripts/snapshot-chain.mjs. */\n` +
    `export const SETTLEMENTS: Record<number, Settlement[]> = ${JSON.stringify(settlements, null, 2)} as unknown as Record<number, Settlement[]>;\n`,
);

console.log(
  `synced ${rounds.length} round(s) (${recordedCount} recorded, ${fixtureCount} worked example) · ` +
    `${Object.keys(deployments).length} deployment(s) · ` +
    `attestation for chain(s) ${Object.keys(attestations).join(', ') || 'none'}`,
);
for (const r of rounds) {
  console.log(
    `  ${r.source === 'recorded' ? 'recorded' : 'example '} · ` +
      `${outcomeOf(r) ? 'published' : 'refused  '} · epoch ${r.onChain?.epoch ?? '—'} · ${r.assetId}`,
  );
}
