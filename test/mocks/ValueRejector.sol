// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test double for a party that cannot receive ether: a multisig or vault contract with no
///         payable fallback, which is what an issuer usually is in practice.
/// @dev Has no `receive`, so any push of value to it reverts. Used to check that a dispute settles
///      regardless, because a push that could revert would have let one party brick the other's
///      asset mid-dispute.
contract ValueRejector {
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "inner call failed");
        return ret;
    }
}
