// The three enums in Types.sol, as ordered lists. Solidity encodes an enum as its index, so
// the ORDER of every array here is load-bearing: appending is safe, reordering is not.
// test/enums.test.ts re-reads Types.sol when it is present and fails on drift.

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

export const HALT_REASONS = [
  'None',
  'InsufficientQuorum',
  'Disagreement',
  'SequencerDown',
  'AssetInactive',
  'Unauthenticated',
] as const;

export const NAV_STATES = ['Empty', 'Live', 'Halted', 'Disputed', 'Voided'] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];
export type HaltReason = (typeof HALT_REASONS)[number];
export type NavState = (typeof NAV_STATES)[number];

export function rejectReasonName(index: number): RejectReason | 'Unknown' {
  return REJECT_REASONS[index] ?? 'Unknown';
}

export function haltReasonName(index: number): HaltReason | 'Unknown' {
  return HALT_REASONS[index] ?? 'Unknown';
}

export function navStateName(index: number): NavState | 'Unknown' {
  return NAV_STATES[index] ?? 'Unknown';
}

/** What actually happened to one committee member's answer, in a sentence. */
export const REJECT_REASON_TEXT: Record<RejectReason, string> = {
  None: 'counted',
  BadSignature: 'the signature did not recover to any key over the request and response the chain rebuilt',
  UnknownSigner: "the recovered key is not a registered enclave, or is not registered for this slot's model",
  SignerExpired: "the enclave's attestation aged out and it has not re-attested",
  SignerRevoked: 'the enclave key was revoked',
  WrongModel: 'the enclave is attested, but not for the model seated in this slot',
  Truncated: 'the generation did not finish cleanly (finish_reason was not stop)',
  Malformed: 'the answer did not match the required single-line grammar exactly',
  OutOfRange: 'the value or confidence fell outside the permitted range',
  LowConfidence: "the model's own confidence was below the floor this asset requires",
  Stale: 'the response timestamp was outside the freshness window',
  DuplicateSlot: 'two answers claimed the same committee slot',
  NoTimestamp: 'the response carried no readable timestamp, so its freshness could not be established',
};

/** Why the round published nothing. */
export const HALT_REASON_TEXT: Record<HaltReason, string> = {
  None: 'no halt',
  InsufficientQuorum: 'too few committee answers survived verification to reach quorum',
  Disagreement: "the surviving answers disagreed by more than the asset's band",
  SequencerDown: 'the L2 sequencer is not reliably up, so no price is trusted',
  AssetInactive: 'the asset is not currently listed for appraisal',
  Unauthenticated: 'the round carried too few authentic enclave signatures to mean anything',
};

export const NAV_STATE_TEXT: Record<NavState, string> = {
  Empty: 'no round has ever published a price for this asset',
  Live: 'a price is published',
  Halted: 'the last round refused to publish',
  Disputed: 'a challenge is open and consumers are frozen',
  Voided: 'a challenge succeeded and the price was withdrawn',
};
