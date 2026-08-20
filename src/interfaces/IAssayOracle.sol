// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Nav} from "../Types.sol";

/// @notice The consumer-facing surface of the oracle. Anything that moves value should call
///         {requireFreshNav} and let it revert rather than reading a possibly halted price.
interface IAssayOracle {
    /// @notice Returns the current valuation, or reverts if there is not a usable one.
    /// @dev Reverts when the last round halted, when the price aged out, while a challenge is open,
    ///      and when the sequencer is not reliably up.
    function requireFreshNav(bytes32 assetId) external view returns (uint256 valueE6);

    /// @notice Non-reverting read for user interfaces and monitoring.
    function peekNav(bytes32 assetId) external view returns (Nav memory nav, bool usable);
}
