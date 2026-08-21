/**
 * Mirrors of the enums in `src/Types.sol`. The ordinals are load-bearing: they are what the
 * contract emits in `VerdictRejected` and `Halted`, so they must stay in the declared order.
 */

export const REJECT_REASONS = [
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
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export const HALT_REASONS = [
  'None',
  'InsufficientQuorum',
  'Disagreement',
  'SequencerDown',
  'AssetInactive',
  'Unauthenticated',
] as const;

export type HaltReason = (typeof HALT_REASONS)[number];

export const NAV_STATES = ['Empty', 'Live', 'Halted', 'Disputed', 'Voided'] as const;

export type NavState = (typeof NAV_STATES)[number];

/** Plain-language gloss for a rejected committee member, written for a reader with no context. */
export const REJECT_COPY: Record<RejectReason, string> = {
  None: 'Accepted.',
  BadSignature: 'The signature did not recover to any key. These bytes were not signed by the enclave that claimed them.',
  UnknownSigner: 'The recovered key has never been attested to this registry for this model.',
  SignerExpired: 'The enclave attestation aged out. The key must re-attest before its answers count again.',
  SignerRevoked: 'The enclave key was revoked.',
  WrongModel: 'The key is attested, but not for the model seated in this slot.',
  Truncated: 'The generation stopped early. Without a completed answer there is nothing to price on.',
  Malformed: 'The answer did not match the required single line. Prose, markdown or a missing field all land here.',
  OutOfRange: 'The value or confidence fell outside the range the contract will accept.',
  LowConfidence: 'The member reported less confidence than this asset requires.',
  Stale: 'The response timestamp, read out of the signed bytes, is older than the freshness window.',
  DuplicateSlot: 'Two answers claimed the same committee slot. Both were dropped.',
  NoTimestamp:
    'The signed response carried no readable timestamp, so its age cannot be established. An answer whose freshness cannot be checked is not counted.',
};

/** Plain-language gloss for a refusal, phrased so a first-time reader understands the cause. */
export const HALT_COPY: Record<HaltReason, string> = {
  None: 'No refusal recorded.',
  InsufficientQuorum:
    'Not enough valid answers. Too few committee members produced an answer the contract could verify and parse, so there was nothing to take a median of.',
  Disagreement:
    'The committee disagreed. Enough answers verified, but they spread wider than the agreement band this asset allows, so the contract published nothing.',
  SequencerDown:
    'The sequencer is not reliably up. Prices are withheld until it has been healthy for the full grace period.',
  AssetInactive: 'The asset is not currently listed for appraisal.',
  Unauthenticated:
    'Too few answers carried a signature from a key this registry has attested. The round said nothing the chain could act on, so it was ignored outright rather than recorded as a refusal.',
};

/**
 * Plain-language gloss for the errors a caller can hit. These are the words a reader gets
 * instead of "transaction failed", so they are written to be understood without the source.
 */
export const ERROR_COPY: Record<string, string> = {
  OracleHalted: 'The oracle refused to publish for this asset, so there is no price to transact at.',
  NavStale: 'The published valuation is older than its freshness window and is no longer usable.',
  NavDisputed: 'A challenge is open. Reads are withheld until it is settled.',
  NoNav: 'No round has ever published a price for this asset.',
  SequencerDown: 'The sequencer is not reliably up, so prices are withheld.',
  EvidenceNotCommitted:
    'The issuer never committed to this evidence document. A round can only be run on a digest that was published in advance, so nobody can pick the evidence after seeing the answers.',
  UnauthenticatedRound:
    'Too few answers came from attested keys for the round to mean anything. It changed no state.',
  InconclusiveRound: 'The round did not reach a conclusion, so the dispute cannot be settled on it.',
  DisputeStillOpen: 'The challenge window has not closed yet.',
  DisputeAlreadyOpen: 'A challenge is already open for this asset.',
  NoOpenDispute: 'There is no challenge to settle.',
  NothingToChallenge: 'Only a live valuation can be contested.',
  BondTooSmall: 'The bond posted is smaller than this asset requires.',
  SignerIsRevoked: 'That enclave key has been revoked and its answers no longer count.',
  CommitteeIncomplete: 'The full committee must be submitted; a partial one is refused.',
  AssetNotActive: 'The asset is not currently listed for appraisal.',
  SubscriptionsClosed: 'The issuer has paused new subscriptions. Redemptions stay open.',
  InsufficientLiquidity: 'The vault does not hold enough settlement currency to pay this redemption.',
  CapExceeded: 'This subscription would take shares outstanding past the supply cap.',
  ZeroAmount: 'The amount rounds to nothing at the current price.',
};

export function errorCopy(name: string | undefined): string | null {
  return name ? (ERROR_COPY[name] ?? null) : null;
}

export const NAV_STATE_COPY: Record<NavState, string> = {
  Empty: 'No round has ever been posted for this asset.',
  Live: 'A price is published and inside its freshness window.',
  Halted: 'The last round refused to publish.',
  Disputed: 'A challenge is open. Consumers stop reading immediately, before anyone adjudicates.',
  Voided: 'A challenge was upheld. The contested valuation was struck.',
};

export function rejectReasonAt(index: number): RejectReason {
  return REJECT_REASONS[index] ?? 'None';
}

export function haltReasonAt(index: number): HaltReason {
  return HALT_REASONS[index] ?? 'None';
}

export function navStateAt(index: number): NavState {
  return NAV_STATES[index] ?? 'Empty';
}
