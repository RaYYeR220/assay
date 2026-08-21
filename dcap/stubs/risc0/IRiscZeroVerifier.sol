// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.9;

/// @notice Minimal local stub of RISC Zero's IRiscZeroVerifier.
/// @dev Only the `verify` selector is referenced by AttestationEntrypointBase.
///      We stub it so we don't have to vendor the whole risc0-ethereum repo.
interface IRiscZeroVerifier {
    function verify(bytes calldata seal, bytes32 imageId, bytes32 journalDigest) external view;
}
