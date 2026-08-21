/**
 * appraise.ts — run one appraisal round across the 5-slot committee and produce a bundle
 * that is ready to post to `AssayOracle.postAppraisal(assetId, evidence, verdicts)`.
 *
 * Per slot:
 *   buildRequestBytes(modelId, evidence)  -> POST raw bytes -> x-receipt-id
 *   -> GET /v1/signature/{id} (SAME bearer token, immediately)
 *   -> preflight the FULL on-chain check locally -> pack the Verdict tuple
 *
 * NOTHING is trusted. `preflightVerdict` reproduces the contract's checks in the contract's
 * order, so a slot this module marks `ok` is a slot that will be accepted on-chain, and a
 * slot it marks `!ok` names the exact check that failed.
 *
 * ALL FIVE SLOTS ARE ALWAYS SUBMITTED. A model that times out, errors, or refuses is packed
 * with an empty `responseBody`, which the contract rejects visibly. A missing model must be
 * a recorded rejection, never a silent omission that quietly shrinks the committee.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';

import { chatRaw, getSignature, getAttestation } from './redpill.ts';
import {
  buildRequestBytes,
  buildRequestString,
  sha256Hex,
  preflightVerdict,
  packVerdict,
  parseResponseOnChain,
  SCHEMA_ID,
  type OnChainVerdict,
  type PreflightResult,
  type RejectReason,
} from './canonical.ts';
import { PROMPT_VERSION } from './prompt.ts';
import { buildEvidence, loadAsset, evidenceHex, type CanonicalEvidence } from './evidence.ts';
import { deployCommittee } from './slots.ts';
import { precheckRound, commitEvidenceCall, type ChainPrecheck } from './chain.ts';
import { keccak256, toHex } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
export const BUNDLES_DIR = join(DATA, 'bundles');

/** The contract requires every slot every round. */
export const COMMITTEE_SIZE = 5;

// ---------------------------------------------------------------------------

export interface CommitteeConfig {
  selectedCommittee: string[];
  signerAnalysis: { distinctSigningAddresses: string[]; answer: string };
  models: { id: string; signingAddress: string | null; gpuTee: boolean; providers: string[] }[];
}

export function loadCommittee(): CommitteeConfig {
  return JSON.parse(readFileSync(join(DATA, 'committee.json'), 'utf8')) as CommitteeConfig;
}

/**
 * Slot -> model, in the order the CONTRACT enforces.
 *
 * `script/Deploy.s.sol` is the source of truth: `modelAt(assetId, slot)` is checked against
 * the recovered signer, so appraising in a different order silently invalidates every
 * verdict. Discovery's `selectedCommittee` is only a suggestion and is used solely as a
 * fallback when the deploy script cannot be read.
 */
export function committeeSlots(models?: string[]): string[] {
  if (models) {
    if (models.length !== COMMITTEE_SIZE) {
      throw new Error(`committee must have exactly ${COMMITTEE_SIZE} slots, got ${models.length}`);
    }
    return models;
  }
  const deployed = deployCommittee();
  const list = deployed ?? loadCommittee().selectedCommittee;
  if (list.length !== COMMITTEE_SIZE) {
    throw new Error(`committee must have exactly ${COMMITTEE_SIZE} slots, got ${list.length}`);
  }
  return list;
}

/**
 * Does discovery's suggestion match what will actually be deployed? Membership drift means
 * we are attesting models the contract will not accept; order drift means every signature
 * lands on the wrong model id.
 */
export function committeeDrift(): { deployed: string[] | null; discovered: string[]; sameSet: boolean; sameOrder: boolean } {
  const deployed = deployCommittee();
  const discovered = loadCommittee().selectedCommittee;
  if (!deployed) return { deployed: null, discovered, sameSet: false, sameOrder: false };
  const sameSet = deployed.length === discovered.length && deployed.every((m) => discovered.includes(m));
  return { deployed, discovered, sameSet, sameOrder: JSON.stringify(deployed) === JSON.stringify(discovered) };
}

export interface SlotResult {
  slot: number;
  model: string;
  /** Attested signer for this model, from /v1/attestation/report. */
  attestedSigner: string | null;
  receiptId: string | null;
  requestBody: string;
  requestSha256: string;
  responseBody: string;
  responseSha256: string;
  signature: Hex | null;
  /** The `text` the gateway says it signed — cross-check against our own computation. */
  gatewayText: string | null;
  gatewayTextMatches: boolean | null;
  /** Full local reproduction of the on-chain check. */
  preflight: PreflightResult | null;
  /** The exact tuple to submit. Always present, even for a dead slot. */
  onChain: OnChainVerdict;
  available: boolean;
  failure: string | null;
  latencyMs: number;
}

export interface AppraisalBundle {
  bundleId: string;
  createdAt: string;
  promptVersion: string;
  schemaId: string;
  assetId: string;
  assetIdHex: string;
  evidence: { line: string; hex: string; sha256: string; byteLength: number };
  /**
   * Round-gating chain state read before posting. `evidenceCommitted: null` means it could
   * not be checked, which is reported as unknown rather than assumed fine.
   */
  chain: ChainPrecheck & { commitEvidenceCall: ReturnType<typeof commitEvidenceCall> | null };
  committee: string[];
  slots: SlotResult[];
  /** Ready to splice into a postAppraisal call. */
  submission: { assetId: string; evidence: string; verdicts: OnChainVerdict[] };
  /** Populated by scripts/post-round.ts once the round is on chain. */
  onChain?: {
    chainId: number; epoch: number | null; txHash: string; blockNumber: number;
    published: boolean; navE6: string | null; haltReason: string | null;
    accepted: number; distinctSigners: number; evidenceHash: string;
    policy?: { quorum: number; bandBps: number; minConfidenceBps: number; maxAgeSec: number; schemaId: string };
    slots: unknown[]; evidenceCommitment: Record<string, unknown>;
  };
  summary: {
    slots: number;
    available: number;
    signatureOk: number;
    preflightOk: number;
    navsE6: string[];
    medianE6: string | null;
    maxDeviationBps: number | null;
    /** Off-chain preview. The chain decides for real. */
    wouldHalt: boolean;
    /** The call reverts before any verdict is read — distinct from a halt. */
    wouldRevert: boolean;
    haltReasons: string[];
    rejectReasons: { slot: number; model: string; reason: RejectReason; check: string | null; detail: string | null }[];
  };
}

// ---------------------------------------------------------------------------

function median(vals: bigint[]): bigint {
  const s = [...vals].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = s.length;
  if (n === 0) throw new Error('median of empty set');
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2n;
}

function maxDeviationBps(vals: bigint[], med: bigint): number {
  if (med === 0n) return Number.MAX_SAFE_INTEGER;
  let worst = 0n;
  for (const v of vals) {
    const d = v > med ? v - med : med - v;
    const bps = (d * 10_000n) / med;
    if (bps > worst) worst = bps;
  }
  return Number(worst);
}

// ---------------------------------------------------------------------------

export interface AppraiseOptions {
  apiKey: string;
  models?: string[];
  quorum?: number;
  bandBps?: number;
  minConfidenceBps?: number;
  maxAgeSec?: number;
  timeoutMs?: number;
  persist?: boolean;
  /** From `precheckRound`. Threaded into every slot so the blocker is reported once per verdict. */
  evidenceCommitted?: boolean;
  observationWatermark?: number;
  /**
   * The REGISTERED on-chain asset id (from deployments/<chainId>.json).
   *
   * Must be passed whenever the round will actually be posted. `assetIdHex()` derives an id
   * from the local asset name, which is NOT what the issuer registered — prechecking against
   * a derived id reads an asset that does not exist, reports "evidence not committed", and
   * makes every slot look rejected while the chain happily accepts them.
   */
  onChainAssetId?: `0x${string}`;
}

/** `bytes32 assetId` as the contract keys it. */
export function assetIdHex(assetId: string): `0x${string}` {
  return keccak256(toHex(assetId));
}

/** Appraise one slot. NEVER throws — every failure becomes a recorded, submittable rejection. */
export async function appraiseSlot(
  slot: number,
  model: string,
  ev: CanonicalEvidence,
  opts: AppraiseOptions,
): Promise<SlotResult> {
  const requestBytes = buildRequestBytes(model, ev.line);
  const requestBody = requestBytes.toString('utf8');

  const r: SlotResult = {
    slot,
    model,
    attestedSigner: null,
    receiptId: null,
    requestBody,
    requestSha256: sha256Hex(requestBytes),
    responseBody: '',
    responseSha256: '',
    signature: null,
    gatewayText: null,
    gatewayTextMatches: null,
    preflight: null,
    onChain: packVerdict(slot, null, null),
    available: false,
    failure: null,
    latencyMs: 0,
  };

  const t0 = Date.now();
  try {
    const att = await getAttestation(model).catch(() => ({}) as Awaited<ReturnType<typeof getAttestation>>);
    r.attestedSigner = att.signing_address ?? null;
    if (!r.attestedSigner) {
      r.failure = 'NO_ATTESTED_SIGNER (model is not receipt-signable)';
      r.latencyMs = Date.now() - t0;
      return r;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
    let res: Awaited<ReturnType<typeof chatRaw>>;
    try {
      res = await chatRaw(requestBody, opts.apiKey, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }

    r.responseBody = res.responseBody;
    r.responseSha256 = sha256Hex(res.responseBody);
    r.receiptId = res.receiptId;
    r.latencyMs = Date.now() - t0;

    if (res.status !== 200) { r.failure = `HTTP_${res.status}: ${res.responseBody.slice(0, 200)}`; return r; }
    if (!res.receiptId) { r.failure = 'NO_RECEIPT_ID header'; return r; }

    // Receipts are owned by sha256(bearer) and live 1h IN MEMORY ONLY. Fetch now, with the
    // same token, or the signature is gone forever.
    let signature: Hex | null = null;
    for (let i = 0; i < 6 && !signature; i++) {
      try {
        const sr = await getSignature(res.receiptId, 'ecdsa', opts.apiKey);
        if (typeof sr.text === 'string') r.gatewayText = sr.text;
        if (sr.signature && /^0x[0-9a-fA-F]{130}$/.test(sr.signature)) signature = sr.signature as Hex;
      } catch { /* retry */ }
      if (!signature) await new Promise((s) => setTimeout(s, 1200));
    }
    r.signature = signature;
    if (!signature) { r.failure = 'NO_SIGNATURE from /v1/signature (check bearer token / TTL)'; return r; }

    // Cross-check: the gateway tells us which text it signed. If that disagrees with our
    // own sha256 of the bytes we sent and received, the byte-exactness assumption is broken
    // and we want to know LOUDLY, not via a mysterious ecrecover mismatch.
    const ourText = `${r.requestSha256}:${r.responseSha256}`;
    r.gatewayTextMatches = r.gatewayText === null ? null : r.gatewayText === ourText;

    r.available = true;
    r.onChain = packVerdict(slot, res.responseBody, signature);
    r.preflight = await preflightVerdict({
      slot,
      modelId: model,
      evidence: ev.line,
      responseBody: res.responseBody,
      signature,
      attestedSigner: r.attestedSigner,
      minConfidenceBps: opts.minConfidenceBps,
      maxAgeSec: opts.maxAgeSec,
      evidenceCommitted: opts.evidenceCommitted,
      observationWatermark: opts.observationWatermark,
    });
    if (!r.preflight.ok) r.failure = `${r.preflight.reason} at ${r.preflight.failedCheck}: ${r.preflight.detail ?? ''}`;
    return r;
  } catch (e) {
    r.latencyMs = Date.now() - t0;
    r.failure = `TRANSPORT: ${(e as Error).message}`;
    return r;
  }
}

/** Run the full 5-slot committee in parallel and assemble a submittable bundle. */
export async function appraise(assetId: string, opts: AppraiseOptions): Promise<AppraisalBundle> {
  const asset = loadAsset(assetId);
  const ev = buildEvidence(asset);
  const models = committeeSlots(opts.models);
  // The registered id when we have one; the derived id is only a local placeholder.
  const idHex = opts.onChainAssetId ?? assetIdHex(assetId);
  const evHashHex = `0x${ev.evidenceSha256}` as `0x${string}`;

  // Read the round gates BEFORE spending credits: if the evidence is not committed, every
  // signature we buy is unpostable. We still run the round when the state is UNKNOWN, but
  // never when it is known-bad.
  const chain = await precheckRound(idHex, evHashHex);
  const slotOpts: AppraiseOptions = {
    ...opts,
    evidenceCommitted: chain.evidenceCommitted ?? undefined,
    observationWatermark: chain.observationWatermark ?? undefined,
  };

  const slots = await Promise.all(models.map((m, i) => appraiseSlot(i, m, ev, slotOpts)));

  const accepted = slots.filter((s) => s.preflight?.ok);
  const navs = accepted.map((s) => BigInt(s.preflight!.navE6!));
  const med = navs.length ? median(navs) : null;
  const dev = med !== null ? maxDeviationBps(navs, med) : null;

  const quorum = opts.quorum ?? 3;
  const bandBps = opts.bandBps ?? 1500;
  const haltReasons: string[] = [];
  // A round blocker is not a halt — the call never executes — so it is named distinctly.
  if (chain.evidenceCommitted === false) {
    haltReasons.push(`WILL_REVERT:EvidenceNotCommitted(${evHashHex}) — issuer must call commitEvidence first`);
  } else if (chain.evidenceCommitted === null) {
    haltReasons.push('UNKNOWN:evidence commitment could not be checked (no RPC configured)');
  }
  if (accepted.length < quorum) haltReasons.push(`QUORUM(${accepted.length}/${quorum})`);
  if (dev !== null && dev > bandBps) haltReasons.push(`BAND(${dev}bps > ${bandBps}bps)`);

  const bundle: AppraisalBundle = {
    bundleId: randomUUID(),
    createdAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    schemaId: SCHEMA_ID,
    assetId,
    assetIdHex: idHex,
    evidence: { line: ev.line, hex: evidenceHex(ev), sha256: ev.evidenceSha256, byteLength: ev.byteLength },
    chain: {
      ...chain,
      commitEvidenceCall: chain.evidenceCommitted === true ? null : commitEvidenceCall(idHex, evHashHex),
    },
    committee: models,
    slots,
    submission: {
      assetId,
      evidence: evidenceHex(ev),
      // ALL slots, always — including the dead ones.
      verdicts: slots.map((s) => s.onChain),
    },
    summary: {
      slots: slots.length,
      available: slots.filter((s) => s.available).length,
      signatureOk: slots.filter((s) => s.preflight && s.preflight.reason !== 'BadSignature' && s.preflight.recovered).length,
      preflightOk: accepted.length,
      navsE6: navs.map((n) => n.toString()),
      medianE6: med?.toString() ?? null,
      maxDeviationBps: dev,
      wouldHalt: accepted.length < quorum || (dev !== null && dev > bandBps),
      wouldRevert: chain.evidenceCommitted === false,
      haltReasons,
      rejectReasons: slots
        .filter((s) => !s.preflight?.ok)
        .map((s) => ({
          slot: s.slot,
          model: s.model,
          reason: (s.preflight?.reason ?? 'Malformed') as RejectReason,
          check: s.preflight?.failedCheck ?? null,
          detail: s.preflight?.detail ?? s.failure,
        })),
    },
  };

  if (opts.persist !== false) persistBundle(bundle);
  return bundle;
}

// ---------------------------------------------------------------------------
// Persistence — judges must be able to replay with ZERO credentials
// ---------------------------------------------------------------------------

export function persistBundle(b: AppraisalBundle): string {
  mkdirSync(BUNDLES_DIR, { recursive: true });
  const path = join(BUNDLES_DIR, `${b.assetId}-${b.createdAt.replace(/[:.]/g, '-')}.json`);
  const text = JSON.stringify(b, null, 2) + '\n';
  writeFileSync(path, text);
  writeFileSync(join(BUNDLES_DIR, `${b.assetId}-latest.json`), text);
  return path;
}

export function listBundles(): string[] {
  if (!existsSync(BUNDLES_DIR)) return [];
  return readdirSync(BUNDLES_DIR).filter((f) => f.endsWith('.json')).sort();
}

export function loadBundle(name: string): AppraisalBundle {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) throw new Error('bad bundle name');
  return JSON.parse(readFileSync(join(BUNDLES_DIR, name), 'utf8')) as AppraisalBundle;
}

/**
 * Re-run the entire on-chain check against a persisted bundle. No network, no API key.
 * This is the "judges reproduce it with zero credentials" path — and it rebuilds the
 * request bytes from the schema rather than trusting the ones stored in the bundle.
 */
export async function reverifyBundle(b: AppraisalBundle): Promise<{
  assetId: string;
  schemaId: string;
  requestBytesReproduced: boolean;
  slots: {
    slot: number; model: string; ok: boolean; reason: RejectReason;
    failedCheck: string | null; recovered: string | null; navE6: string | null; detail: string | null;
  }[];
  acceptedCount: number;
}> {
  const out = [];
  let allReproduced = true;
  for (const s of b.slots) {
    // Rebuild from the schema — do NOT trust b.evidence or s.requestBody blindly.
    const rebuilt = buildRequestString(s.model, b.evidence.line);
    if (rebuilt !== s.requestBody) allReproduced = false;

    if (!s.signature || !s.responseBody) {
      out.push({
        slot: s.slot, model: s.model, ok: false, reason: 'BadSignature' as RejectReason,
        failedCheck: 'responseBody.length == 0', recovered: null, navE6: null, detail: s.failure,
      });
      continue;
    }
    const pf = await preflightVerdict({
      slot: s.slot, modelId: s.model, evidence: b.evidence.line,
      responseBody: s.responseBody, signature: s.signature,
      attestedSigner: s.attestedSigner ?? undefined,
      // Replay the round under the SAME policy the chain applied, or the replay disagrees
      // with the transaction it claims to reproduce — a confidence floor of 0 would show
      // ACCEPT where the contract recorded LowConfidence.
      minConfidenceBps: b.onChain?.policy?.minConfidenceBps,
      maxAgeSec: b.onChain?.policy?.maxAgeSec,
      // Staleness is time-dependent; replaying an old bundle must not report a false
      // failure, so evaluate freshness at the moment it was created.
      now: Math.floor(new Date(b.createdAt).getTime() / 1000),
    });
    out.push({
      slot: s.slot, model: s.model, ok: pf.ok, reason: pf.reason,
      failedCheck: pf.failedCheck, recovered: pf.recovered, navE6: pf.navE6, detail: pf.detail,
    });
  }
  return {
    assetId: b.assetId,
    schemaId: b.schemaId,
    requestBytesReproduced: allReproduced,
    slots: out,
    acceptedCount: out.filter((s) => s.ok).length,
  };
}

/** Quick shape check of a raw response without any signature material. */
export function inspectResponse(responseBody: string) {
  return parseResponseOnChain(responseBody);
}
