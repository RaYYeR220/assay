// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

/// @notice Test double for the Chainlink L2 sequencer uptime feed on X Layer.
/// @dev `answer == 0` means the sequencer is up, which is the Chainlink convention the oracle
///      relies on. `startedAt` is when the current status began.
contract MockSequencerFeed is IAggregatorV3 {
    int256 public answer;
    uint256 public startedAt;
    uint80 public roundId = 1;

    constructor(int256 answer_, uint256 startedAt_) {
        answer = answer_;
        startedAt = startedAt_;
    }

    function set(int256 answer_, uint256 startedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
        ++roundId;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, startedAt, startedAt, roundId);
    }
}
