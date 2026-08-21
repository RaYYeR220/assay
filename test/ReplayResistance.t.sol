// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {HaltReason, NavState, RejectReason, Verdict} from "../src/Types.sol";

/// @notice Regression cover for the two ways a round could once have been turned into a halt by
///         someone who never spoke to the committee: posting an old round again, and copying a
///         pending one with its offsets rewritten.
/// @dev Signatures stay valid for the whole freshness window, so an old round can always be posted
///      again, and the offsets have never been covered by a signature at all. Neither may change
///      what a round means. A replay is refused member by member and leaves the valuation exactly
///      where it was; corrupted offsets are simply ignored.
contract ReplayResistanceTest is Fixtures {
    bytes32 internal constant PROD = keccak256("assay.prod.like");

    // -----------------------------------------------------------------------------------
    // Replay
    // -----------------------------------------------------------------------------------

    function test_VerbatimReplay_IsIgnoredAndLeavesTheValuationLive() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));
        vm.warp(block.timestamp + 60);

        vm.recordLogs();
        assertFalse(post(vs));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint8 i = 0; i < 3; ++i) {
            assertEq(uint8(reasonIn(logs, i)), uint8(RejectReason.Stale), "reason should be Stale");
        }
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live), "must stay Live");
        assertEq(oracle.haltCount(assetId), 0, "no halt");
        assertEq(oracle.requireFreshNav(assetId), 1_000_000);
    }
}
