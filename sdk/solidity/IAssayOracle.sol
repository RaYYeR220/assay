// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Lifecycle of the most recent NAV for an asset.
enum NavState {
    Empty,
    Live,
    Halted,
    Disputed,
    Voided
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

/// @notice The published valuation, or the recorded absence of one.
struct Nav {
    uint128 valueE6;
    uint64 postedAt;
    uint64 observedAt;
    uint32 epoch;
    /// @dev Snapshotted at publication so an issuer cannot widen the window and revive an
    ///      expired valuation.
    uint32 maxAgeSec;
    uint8 accepted;
    uint8 distinctSigners;
    NavState state;
    bytes32 evidenceHash;
}

/// @title IAssayOracle
/// @notice The consumer-facing surface of the Assay NAV oracle.
/// @dev Anything that moves value should call {requireFreshNav} and let it revert rather than
///      reading a possibly halted price. The revert is the product: it fires when the committee
///      failed to agree, when the valuation aged out, while a challenge is open, and when the
///      sequencer is not reliably up. A consumer that catches it and falls back to a cached
///      number has re-introduced exactly the failure this oracle exists to prevent.
///
///      This file is a standalone copy for integrators, structs inlined so it compiles on its
///      own. It is kept byte-compatible with `src/interfaces/IAssayOracle.sol`.
interface IAssayOracle {
    /// @notice Returns the current valuation in 1e6 USD per unit, or reverts.
    function requireFreshNav(bytes32 assetId) external view returns (uint256 valueE6);

    /// @notice Non-reverting read for user interfaces and monitoring.
    /// @return nav the stored record, whatever state it is in
    /// @return usable true only when {requireFreshNav} would return
    function peekNav(bytes32 assetId) external view returns (Nav memory nav, bool usable);

    // -- errors a consumer will see, worth catching by name -------------------------------

    /// @notice The last round refused to publish. `reason` says which check stopped it.
    error OracleHalted(bytes32 assetId, HaltReason reason);
    /// @notice The published price is older than the asset's freshness window.
    error NavStale(bytes32 assetId, uint64 observedAt);
    /// @notice A challenge is open, so every consumer is frozen until it resolves.
    error NavDisputed(bytes32 assetId);
    /// @notice No round has ever published a price for this asset.
    error NoNav(bytes32 assetId);
    /// @notice The L2 sequencer uptime feed is unhealthy.
    error SequencerDown();
}
