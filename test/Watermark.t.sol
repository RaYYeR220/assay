// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {HaltReason, NavState, RejectReason, Verdict} from "../src/Types.sol";

/// @notice Signatures stay valid for the whole freshness window, so without a floor on observation
///         time a relayer could hold a favourable set of answers and re-post it after a later round
///         disagreed. Every accepted answer has to be strictly newer than the newest answer of the
///         last published round.
contract WatermarkTest is Fixtures {
    bytes32 internal constant LOOSE = keccak256("assay.test.asset.loose-quorum");

    function test_Watermark_IsTheNewestAcceptedAnswer() public {
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp - 30);
        vs[1] = goodVerdict(PK_1, assetId, 1, 1_000_000, 9000, block.timestamp - 10);
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 9000, block.timestamp - 20);
        assertTrue(post(vs));

        assertEq(oracle.observationWatermark(assetId), uint64(block.timestamp - 10));
        assertEq(oracle.navOf(assetId).observedAt, uint64(block.timestamp - 30));
    }

    /// @dev A verbatim replay is authentic in every respect. It must not publish, and it must not
    ///      halt either: the calldata of every honest round is public, so if replaying it could
    ///      halt the oracle then every published price would come with a free off switch.
    function test_ReplayedRound_IsIgnoredRatherThanHalting() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));
        vm.warp(block.timestamp + 60);

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.RoundIgnored(assetId, 2, 0, sha256(evidence));
        assertFalse(post(vs), "the same answers cannot be sold twice");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint8 i = 0; i < 3; ++i) {
            assertEq(uint8(reasonIn(logs, i)), uint8(RejectReason.Stale));
        }

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live));
        assertEq(oracle.haltCount(assetId), 0);
        assertEq(oracle.requireFreshNav(assetId), 1_000_000);
    }

    function test_RecycledAnswer_IsDroppedFromAnOtherwiseFreshRound() public {
        listCommittee(LOOSE, 3, 2, 2);

        Verdict[] memory first = roundFor(LOOSE, navList(1_000_000, 1_000_000, 1_000_000));
        assertTrue(oracle.postAppraisal(LOOSE, evidence, first));

        vm.warp(block.timestamp + 60);
        Verdict[] memory second = roundFor(LOOSE, navList(2_000_000, 2_000_000, 2_000_000));
        second[2] = first[2]; // still inside maxAgeSec, but it belongs to the previous round

        vm.recordLogs();
        assertTrue(oracle.postAppraisal(LOOSE, evidence, second));
        assertEq(uint8(rejectionFor(2)), uint8(RejectReason.Stale));

        assertEq(oracle.navOf(LOOSE).accepted, 2, "the recycled member is dropped, the round stands");
        assertEq(oracle.navOf(LOOSE).valueE6, 2_000_000);
    }

    /// @dev A halt must not retire the answers that were submitted with it. If it did, one member
    ///      arriving late would strand the rest and the committee would have to answer all over
    ///      again to make any progress.
    function test_Watermark_DoesNotAdvanceOnAHaltedRound() public {
        assertTrue(post(agreeingRound(1_000_000)));
        uint64 watermark = oracle.observationWatermark(assetId);

        vm.warp(block.timestamp + 60);
        Verdict[] memory disagreeing = roundFor(assetId, navList(1_000_000, 1_000_000, 5_000_000));
        assertFalse(post(disagreeing));
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.Disagreement));
        assertEq(oracle.observationWatermark(assetId), watermark, "a halt retires nothing");

        // The two members that agreed are still usable; only the outlier is replaced.
        Verdict[] memory retry = new Verdict[](3);
        retry[0] = disagreeing[0];
        retry[1] = disagreeing[1];
        retry[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 9000, block.timestamp);
        assertTrue(post(retry));
        assertEq(oracle.navOf(assetId).valueE6, 1_000_000);
        assertEq(oracle.navOf(assetId).accepted, 3);
    }

    function test_Watermark_AllowsAnswersFromTheSameSecondOnlyOnce() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));
        uint64 watermark = oracle.observationWatermark(assetId);

        // An answer bearing exactly the watermark second is not strictly newer.
        Verdict[] memory sameSecond = roundFor(assetId, navList(1_100_000, 1_100_000, 1_100_000));
        vm.recordLogs();
        assertFalse(post(sameSecond));
        assertEq(uint8(rejectionFor(0)), uint8(RejectReason.Stale));

        vm.warp(block.timestamp + 1);
        assertTrue(post(roundFor(assetId, navList(1_100_000, 1_100_000, 1_100_000))));
        assertEq(oracle.observationWatermark(assetId), watermark + 1);
    }
}
