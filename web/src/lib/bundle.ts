import type { Hex } from 'viem';
import type { HaltReason, RejectReason } from './enums';

/**
 * A recorded appraisal round.
 *
 * This mirrors the `AppraisalBundle` the appraisal service writes to
 * `backend/data/bundles/*.json`, so a bundle can be dropped in and replayed with no
 * transformation. Everything under `onChain` is an optional overlay describing what the
 * contract did with the round; a bundle recorded before it was posted simply omits it, and
 * the dashboard falls back to its own preview of the decision.
 *
 * Nothing here is trusted. The dashboard recomputes the median, the deviation and the band
 * verdict from `verdicts[]` and shows both its own answer and the chain's, so a divergence
 * between the two is visible rather than hidden.
 */

export interface BundleVerdictValue {
  /** Integer string, USD scaled by 1e6. */
  navUsdE6: string;
  confidenceBps: number;
  /** The digest the member echoed back, binding its answer to the evidence it saw. */
  evidenceSha256: string;
}

export interface BundleMemberVerdict {
  /** Model id, exactly as it appears in the committee slot on chain. */
  model: string;
  /** Address recovered from the signature. */
  signer: string | null;
  /** Address the attestation endpoint published for this enclave. */
  attestedSigner: string | null;
  receiptId: string | null;
  /** The exact request bytes; the contract rebuilds these itself and hashes them. */
  requestBody: string;
  requestSha256: string;
  /** The raw HTTP response bytes the enclave signed. */
  responseBody: string;
  responseSha256: string;
  signature: Hex | null;
  /** The 129-character `<reqSha>:<respSha>` string covered by the signature. */
  signedText: string | null;
  gatewayText?: string | null;
  signatureOk: boolean;
  parseOk: boolean;
  verdict: BundleVerdictValue | null;
  /** Set when this member would cause, or contribute to, a refusal. */
  haltReason: string | null;
  latencyMs: number;

  // ---- optional overlay, filled in once the round has been posted -----------------------
  /** Committee position. Defaults to array index when absent. */
  slot?: number;
  /** What the contract decided about this member. */
  onChainAccepted?: boolean;
  onChainRejectReason?: RejectReason | null;
}

export interface BundleSummary {
  requested: number;
  signatureOk: number;
  parseOk: number;
  usable: number;
  navsUsdE6: string[];
  medianUsdE6: string | null;
  maxDeviationBps: number | null;
  /** Off-chain preview of the decision. The chain decides for real. */
  wouldHalt: boolean;
  haltReasons: string[];
}

/** Policy the round was judged against. Read from `AssetRegistry` when the chain is reachable. */
export interface BundlePolicy {
  quorum: number;
  minDistinctSigners: number;
  bandBps: number;
  minConfidenceBps: number;
  maxAgeSec: number;
  disputeBandBps?: number;
}

export interface BundleSlotOutcome {
  slot: number;
  signer: string | null;
  accepted: boolean;
  rejectReason: RejectReason | null;
  navE6: string | null;
  confidenceBps: number | null;
  /** `created` field read out of the signed response, in unix seconds. */
  createdAt: number | null;
}

/** What the contract actually did, reconstructed from the round's events. */
export interface BundleOnChain {
  chainId: number;
  epoch: number;
  /** The transaction that posted or halted the round. */
  txHash: Hex;
  blockNumber: string;
  /**
   * Block timestamp, unix seconds. Null when the round was recorded after the last chain
   * snapshot, in which case the views show the date as unknown rather than guess at it.
   */
  timestamp?: number | null;
  /** The asset the round was posted under, which is what its policy is keyed by. */
  assetId?: Hex | null;
  oracle?: string | null;
  /** Gas the posting transaction burned. */
  gasUsed?: number | null;
  /** Explorer root and direct link, as the appraisal service recorded them. */
  explorer?: string | null;
  txUrl?: string | null;
  published: boolean;
  navE6: string | null;
  haltReason: HaltReason | null;
  accepted: number;
  distinctSigners: number;
  /** Oldest accepted response timestamp, unix seconds. */
  observedAt: number | null;
  /** sha256 of the evidence bytes, as the contract computed it. */
  evidenceHash: Hex;
  slots: BundleSlotOutcome[];

  /**
   * True when the round carried too few authentic signatures to mean anything and the contract
   * deliberately changed no state. Distinct from a halt: nobody disagreed, somebody posted noise.
   */
  ignored?: boolean;
  /** How many answers recovered to a key the registry has attested. */
  authenticated?: number;
  /** The issuer's prior commitment to this evidence digest, without which a round reverts. */
  evidenceCommitment?: {
    committed: boolean;
    issuer: string | null;
    /** Where the document can be fetched and checked against the digest. */
    uri?: string | null;
    /** The transaction in which the digest was committed. */
    txHash: Hex;
    blockNumber?: string | null;
    timestamp?: number | null;
    /** False when the digest was committed as part of running the round rather than ahead of it. */
    preCommitted?: boolean | null;
  };
}

export interface AppraisalBundle {
  bundleId: string;
  createdAt: string;
  promptVersion: string;
  /** Off-chain asset key, e.g. `carbon-vcs-985-2021`. */
  assetId: string;
  evidence: {
    line: string;
    evidenceSha256: string;
    lineSha256: string;
    byteLength: number;
  };
  systemPromptSha256: string;
  committee: string[];
  verdicts: BundleMemberVerdict[];
  summary: BundleSummary;

  // ---- optional overlay ----------------------------------------------------------------
  /** Human label for the asset, used in the header. */
  assetLabel?: string;
  /** The 32-byte id the contract keys this asset by, `keccak256(assetKey)`. */
  assetIdHash?: Hex;
  policy?: BundlePolicy;
  onChain?: BundleOnChain;
  /** Where this record came from. Fixtures are labelled so nothing is passed off as live. */
  source?: 'recorded' | 'fixture';
}

// ---------------------------------------------------------------------------------------
// Derived round view
// ---------------------------------------------------------------------------------------

export interface RoundReading {
  slot: number;
  model: string;
  /** null when the member produced nothing the contract could read. */
  navE6: bigint | null;
  confidenceBps: number | null;
  signer: string | null;
  accepted: boolean;
  rejectReason: RejectReason | null;
  /** Deviation from the median in basis points, null when there is no value. */
  deviationBps: number | null;
  /** True when the value verified but sits outside the agreement band. */
  outsideBand: boolean;
  latencyMs: number;
  responseBody: string;
  requestBody: string;
  signature: Hex | null;
  signedText: string | null;
  requestSha256: string;
  responseSha256: string;
}

export interface RoundView {
  bundle: AppraisalBundle;
  policy: BundlePolicy;
  readings: RoundReading[];
  /** Accepted values only. */
  accepted: RoundReading[];
  medianE6: bigint | null;
  maxDeviationBps: number | null;
  distinctSigners: number;
  published: boolean;
  navE6: bigint | null;
  haltReason: HaltReason | null;
  /** The round changed no state at all — too little of it was authentic to act on. */
  ignored: boolean;
  epoch: number | null;
  /** Set when the chain's verdict is known; otherwise this view is the dashboard's own preview. */
  fromChain: boolean;
}

export const DEFAULT_POLICY: BundlePolicy = {
  quorum: 3,
  minDistinctSigners: 2,
  bandBps: 1000,
  minConfidenceBps: 5000,
  maxAgeSec: 3600,
  disputeBandBps: 500,
};

function median(values: bigint[]): bigint | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2n;
}

/** Signed deviation from the median, in basis points. The band is judged on its magnitude. */
function deviationBps(value: bigint, med: bigint): number {
  if (med === 0n) return Number.MAX_SAFE_INTEGER;
  const above = value >= med;
  const d = above ? value - med : med - value;
  const magnitude = Number((d * 10_000n) / med);
  return above ? magnitude : -magnitude;
}

/**
 * Classifies one member the way `AssayOracle._checkVerdict` would, from the record alone.
 * Used when a bundle has not been posted yet, so the timeline still has something honest to
 * show. Once `onChain` is present the contract's own answer takes precedence.
 */
/**
 * Rejections raised after the strict parser has already read the answer. For anything else the
 * contract stopped at the signature or the registry, so there is no value to report.
 */
const PARSED_REJECTIONS = new Set<RejectReason>(['OutOfRange', 'LowConfidence', 'Stale']);

function offChainRejection(v: BundleMemberVerdict, policy: BundlePolicy): RejectReason | null {
  if (!v.signature) return 'BadSignature';
  if (!v.signatureOk) return 'BadSignature';
  if (!v.parseOk || !v.verdict) {
    return v.haltReason?.includes('TRUNCAT') ? 'Truncated' : 'Malformed';
  }
  if (v.verdict.confidenceBps < policy.minConfidenceBps) return 'LowConfidence';
  if (v.haltReason?.includes('EVIDENCE_HASH_MISMATCH')) return 'Malformed';
  if (v.haltReason?.includes('STALE')) return 'Stale';
  return null;
}

/**
 * Collapses a bundle, its policy and whatever the chain recorded into one shape the views
 * render. The band arithmetic is redone here in bigint so the dashboard never shows a number
 * it did not derive from the same integers the contract used.
 */
export function toRoundView(bundle: AppraisalBundle, policyOverride?: BundlePolicy): RoundView {
  const policy = policyOverride ?? bundle.policy ?? DEFAULT_POLICY;
  const chain = bundle.onChain;
  const slotOutcome = new Map<number, BundleSlotOutcome>();
  for (const s of chain?.slots ?? []) slotOutcome.set(s.slot, s);

  const provisional = bundle.verdicts.map((v, i) => {
    const slot = v.slot ?? i;
    const oc = slotOutcome.get(slot);
    const rejectReason = oc
      ? oc.accepted
        ? null
        : (oc.rejectReason ?? 'Malformed')
      : offChainRejection(v, policy);

    const rawNav = oc?.navE6 ?? v.verdict?.navUsdE6 ?? null;
    const navE6 = rawNav !== null && rejectReason === null ? BigInt(rawNav) : null;

    // A member rejected before the parser ran has no readable value or confidence, and showing
    // one anyway would imply the contract looked at content it never reached.
    const readable = rejectReason === null || PARSED_REJECTIONS.has(rejectReason);

    return {
      slot,
      model: v.model,
      navE6,
      confidenceBps: readable ? (oc?.confidenceBps ?? v.verdict?.confidenceBps ?? null) : null,
      signer: oc?.signer ?? v.signer ?? v.attestedSigner ?? null,
      accepted: rejectReason === null && navE6 !== null,
      rejectReason,
      deviationBps: null as number | null,
      outsideBand: false as boolean,
      latencyMs: v.latencyMs,
      responseBody: v.responseBody,
      requestBody: v.requestBody,
      signature: v.signature,
      signedText: v.signedText,
      requestSha256: v.requestSha256,
      responseSha256: v.responseSha256,
    } satisfies RoundReading;
  });

  const accepted = provisional.filter((r) => r.accepted && r.navE6 !== null);
  const medianE6 = median(accepted.map((r) => r.navE6!));

  let maxDeviationBps: number | null = null;
  if (medianE6 !== null) {
    for (const r of provisional) {
      if (r.navE6 === null) continue;
      r.deviationBps = deviationBps(r.navE6, medianE6);
      if (r.accepted) {
        const magnitude = Math.abs(r.deviationBps);
        r.outsideBand = magnitude > policy.bandBps;
        maxDeviationBps = Math.max(maxDeviationBps ?? 0, magnitude);
      }
    }
  }

  const distinctSigners = new Set(accepted.map((r) => r.signer?.toLowerCase()).filter(Boolean)).size;

  // The chain's verdict wins when we have it. Otherwise reproduce the same decision locally.
  let published: boolean;
  let haltReason: HaltReason | null;
  if (chain) {
    published = chain.published;
    haltReason = chain.published ? null : (chain.haltReason ?? 'Disagreement');
  } else if (accepted.length < policy.quorum || distinctSigners < policy.minDistinctSigners) {
    published = false;
    haltReason = 'InsufficientQuorum';
  } else if (maxDeviationBps !== null && maxDeviationBps > policy.bandBps) {
    published = false;
    haltReason = 'Disagreement';
  } else {
    published = true;
    haltReason = null;
  }

  return {
    bundle,
    policy,
    readings: provisional.sort((a, b) => a.slot - b.slot),
    accepted,
    medianE6: chain?.navE6 ? BigInt(chain.navE6) : medianE6,
    maxDeviationBps,
    distinctSigners: chain?.distinctSigners ?? distinctSigners,
    published,
    navE6: published ? (chain?.navE6 ? BigInt(chain.navE6) : medianE6) : null,
    haltReason,
    ignored: chain?.ignored ?? haltReason === 'Unauthenticated',
    epoch: chain?.epoch ?? null,
    fromChain: Boolean(chain),
  };
}
