// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Why a single committee member's verdict was not counted.
/// @dev Rejections are recorded rather than reverted: one bad member must not stop the round, but
///      it must also never silently pass. If enough members are rejected the round simply fails to
///      reach quorum and the oracle halts.
enum RejectReason {
    None,
    BadSignature,
    UnknownSigner,
    SignerExpired,
    SignerRevoked,
    WrongModel,
    Truncated,
    Malformed,
    OutOfRange,
    LowConfidence,
    Stale,
    DuplicateSlot,
    NoTimestamp
}

/// @notice Why the oracle refused to publish a price for a round.
enum HaltReason {
    None,
    InsufficientQuorum,
    Disagreement,
    SequencerDown,
    AssetInactive,
    Unauthenticated
}

/// @notice Lifecycle of the most recent NAV for an asset.
enum NavState {
    Empty,
    Live,
    Halted,
    Disputed,
    Voided
}

/// @notice One committee member's signed answer, exactly as the inference gateway returned it.
/// @param slot committee position, which fixes the model the answer must have come from
/// @param responseBody the raw HTTP response bytes; the chain hashes these itself
/// @param signature 65-byte secp256k1 signature produced inside the enclave
/// @dev The three offsets are inert. They are carried so an indexer can point at the fields without
///      re-scanning, and the contract ignores them: an offset travels outside the signature, so
///      anyone watching a pending round could otherwise rewrite one and change what the round says.
///      The oracle finds each field itself, at the first position where the literal pattern occurs.
struct Verdict {
    uint8 slot;
    bytes responseBody;
    bytes signature;
}

/// @notice Per-asset appraisal policy, chosen by whoever lists the asset.
struct AssetConfig {
    address issuer;
    uint8 quorum;
    uint8 minDistinctSigners;
    uint16 bandBps;
    uint16 minConfidenceBps;
    uint32 maxAgeSec;
    uint16 disputeBandBps;
    uint96 disputeBond;
    bytes32 schemaId;
    bool active;
}

/// @notice The published valuation, or the recorded absence of one.
/// @dev `maxAgeSec` is copied in at publication time rather than read from the asset config on
///      demand. Reading it live would let an issuer widen the window afterwards and bring an
///      already-expired valuation back into service, which is the opposite of what a freshness
///      window is for.
struct Nav {
    uint128 valueE6;
    uint64 postedAt;
    uint64 observedAt;
    uint32 epoch;
    uint32 maxAgeSec;
    uint8 accepted;
    uint8 distinctSigners;
    NavState state;
    bytes32 evidenceHash;
}
