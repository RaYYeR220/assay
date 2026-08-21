import type { Address, Hex } from 'viem';
import type { HaltReason, NavState, RejectReason } from './enums.ts';

/** Addresses the client talks to. Only `oracle` is strictly required for consumer reads. */
export interface AssayAddresses {
  oracle: Address;
  assetRegistry?: Address;
  attestationRegistry?: Address;
  vault?: Address;
  currency?: Address;
  quoteAdapter?: Address;
}

/** Per-asset appraisal policy, as stored in AssetRegistry. */
export interface AssetConfig {
  issuer: Address;
  quorum: number;
  minDistinctSigners: number;
  bandBps: number;
  minConfidenceBps: number;
  maxAgeSec: number;
  disputeBandBps: number;
  disputeBond: bigint;
  schemaId: Hex;
  active: boolean;
}

/** The stored valuation, or the recorded absence of one. */
export interface Nav {
  valueE6: bigint;
  postedAt: bigint;
  observedAt: bigint;
  epoch: number;
  /** The freshness window snapshotted when this value was published. */
  maxAgeSec: number;
  accepted: number;
  distinctSigners: number;
  state: NavState;
  evidenceHash: Hex;
}

/** What `peekNav` answers. Never throws, so every refusal shows up in these fields. */
export interface NavView extends Nav {
  assetId: Hex;
  /** True only when the contract itself would let value move against this price. */
  usable: boolean;
  /** Decimal string, e.g. "42.135000" USD per unit. */
  value: string;
  stateText: string;
  /** Present whenever `usable` is false: why not, in the same shape `explainRevert` returns. */
  refusal?: Refusal;
  haltReason?: HaltReason;
  ageSec?: number;
  staleAfter?: number;
}

/** A listed asset with the policy it is priced under. */
export interface AssetSummary {
  assetId: Hex;
  metadataURI: string;
  config: AssetConfig;
  committee: string[];
  epoch: number;
  haltCount: number;
  lastHaltReason: HaltReason;
}

export interface CommitteeMember {
  slot: number;
  modelId: string;
}

/** One registered enclave key. */
export interface AttestedSigner {
  signer: Address;
  measurement: Hex;
  attestedAt: number;
  expiresAt: number;
  tcbStatus: number;
  tcbStatusText: string;
  revoked: boolean;
  known: boolean;
  expired: boolean;
  /** Models this key is bound to, as far as the scanned logs show. */
  models: string[];
  /** Where the quote was verified on chain. */
  txHash?: Hex;
  txUrl?: string;
  blockNumber?: bigint;
}

export interface AcceptedVerdict {
  slot: number;
  modelId?: string;
  signer: Address;
  navE6: bigint;
  value: string;
  confidenceBps: number;
  createdAt: number;
  /** Signed deviation from the round median, in basis points. */
  deviationBps?: number;
}

export interface RejectedVerdict {
  slot: number;
  modelId?: string;
  signer: Address;
  reason: RejectReason | 'Unknown';
  detail: string;
}

export type RoundOutcome = 'published' | 'halted' | 'ignored' | 'unknown';

/** One appraisal round, rebuilt from logs. */
export interface Round {
  assetId: Hex;
  epoch: number;
  outcome: RoundOutcome;
  /** One line summarising the round, suitable for an audit log. */
  summary: string;
  accepted: AcceptedVerdict[];
  rejected: RejectedVerdict[];
  medianE6?: bigint;
  median?: string;
  band?: { bps: number; lowE6: bigint; highE6: bigint; low: string; high: string };
  quorum?: number;
  minDistinctSigners?: number;
  distinctSigners?: number;
  observedAt?: number;
  evidenceHash?: Hex;
  haltReason?: HaltReason;
  haltReasonText?: string;
  authenticated?: number;
  blockNumber?: bigint;
  txHash?: Hex;
  txUrl?: string;
}

export interface DisputeView {
  assetId: Hex;
  open: boolean;
  challenger: Address;
  bond: bigint;
  epoch: number;
  openedAt: number;
  /** Present when a challenge is open: the epoch whose price is contested. */
  contestedEpoch?: number;
}

export interface VaultView {
  address: Address;
  name: string;
  symbol: string;
  assetId: Hex;
  issuer: Address;
  sharePriceE6?: bigint;
  sharePrice?: string;
  totalSupply: bigint;
  supplyCap: bigint;
  liquidity: bigint;
  currency: Address;
  currencyDecimals: number;
  subscriptionsPaused: boolean;
  canTransact: boolean;
  /** Why not, when `canTransact` is false. */
  refusal?: Refusal;
}

/**
 * A decoded revert. `reason` is a stable token to branch on; `detail` is the sentence to
 * show a human. Every field below `detail` is best-effort context.
 */
export interface Refusal {
  reason: RefusalReason;
  detail: string;
  /** The Solidity error that was raised, when one could be decoded. */
  error?: string;
  args?: Record<string, string>;
  /** True when the failure is a refusal to price rather than a caller mistake. */
  isRefusalToPrice: boolean;
  selector?: Hex;
  data?: Hex;
}

export const REFUSAL_REASONS = [
  'halted',
  'stale',
  'disputed',
  'no-nav',
  'sequencer-down',
  'asset-inactive',
  'evidence-rejected',
  'committee-incomplete',
  'unauthenticated',
  'dispute-state',
  'bond',
  'not-authorised',
  'bad-config',
  'unknown-asset',
  'unknown-schema',
  'attestation-rejected',
  'vault-limit',
  'token',
  'reverted',
  'network',
  'unknown',
] as const;

export type RefusalReason = (typeof REFUSAL_REASONS)[number];
