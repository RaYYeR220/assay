// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AssetConfig, HaltReason, Nav, NavState, RejectReason, Verdict} from "../src/Types.sol";
import {MockSequencerFeed} from "./mocks/MockSequencerFeed.sol";

/// @notice The round itself: what it takes to publish, and every way the oracle refuses to.
contract AssayOracleTest is Fixtures {
    bytes32 internal constant ASSET_4 = keccak256("assay.test.asset.four");
    bytes32 internal constant ASSET_5 = keccak256("assay.test.asset.five");

    // -----------------------------------------------------------------------------------
    // Publishing
    // -----------------------------------------------------------------------------------

    function test_Publishes_WhenCommitteeAgrees() public {
        uint256 t = block.timestamp;
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, t - 30);
        vs[1] = goodVerdict(PK_1, assetId, 1, 1_010_000, 8000, t - 10);
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_005_000, 7000, t - 20);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.AppraisalPosted(assetId, 1, 1_005_000, 3, 3, uint64(t - 30), sha256(evidence));
        assertTrue(post(vs));

        Nav memory n = oracle.navOf(assetId);
        assertEq(uint8(n.state), uint8(NavState.Live));
        assertEq(n.valueE6, 1_005_000, "the published value is the median, not the mean");
        assertEq(n.observedAt, uint64(t - 30), "freshness is measured from the oldest answer used");
        assertEq(n.postedAt, uint64(t));
        assertEq(n.accepted, 3);
        assertEq(n.distinctSigners, 3);
        assertEq(n.epoch, 1);
        assertEq(n.evidenceHash, sha256(evidence));

        assertEq(oracle.epochOf(assetId), 1);
        assertEq(oracle.haltCount(assetId), 0);
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.None));
        assertEq(oracle.observationWatermark(assetId), uint64(t - 10), "watermark is the newest answer");

        assertEq(oracle.requireFreshNav(assetId), 1_005_000);
        (Nav memory peeked, bool usable) = oracle.peekNav(assetId);
        assertTrue(usable);
        assertEq(peeked.valueE6, 1_005_000);
    }

    function test_Median_OfEvenCommitteeAveragesTheMiddlePair() public {
        listCommittee(ASSET_4, 4, 4, 4);
        Verdict[] memory vs = roundFor(ASSET_4, navList(1_006_000, 1_000_000, 1_004_000, 1_002_000));
        assertTrue(oracle.postAppraisal(ASSET_4, evidence, vs));
        assertEq(oracle.navOf(ASSET_4).valueE6, 1_003_000);
    }

    function test_Median_OfOddCommitteeIsTheMiddleValue() public {
        // A spread this wide only agrees under a wide band.
        AssetConfig memory cfg = defaultConfig();
        cfg.bandBps = 5000;
        vm.prank(issuer);
        assets.configureAsset(assetId, cfg);

        // Mean is 4_666_666; the middle value is what gets published.
        assertTrue(post(roundFor(assetId, navList(5_800_000, 4_000_000, 4_200_000))));
        assertEq(oracle.navOf(assetId).valueE6, 4_200_000);
    }

    function test_Publishes_WhenDeviationIsExactlyTheBand() public {
        // 5% band, median 1_000_000: a 50_000 deviation is exactly on the line and must pass.
        assertTrue(post(roundFor(assetId, navList(950_000, 1_000_000, 1_050_000))));
        assertEq(oracle.navOf(assetId).valueE6, 1_000_000);
    }

    function test_Halts_WhenDeviationExceedsTheBandByOne() public {
        Verdict[] memory vs = roundFor(assetId, navList(950_000, 1_000_000, 1_050_001));

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(assetId, 1, HaltReason.Disagreement, 3, sha256(evidence));
        assertFalse(post(vs));

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted));
        assertEq(oracle.haltCount(assetId), 1);
    }

    function test_Halts_WhenCommitteeDisagreesBeyondBand() public {
        publish(1_000_000);
        vm.warp(block.timestamp + 60);

        Verdict[] memory vs = roundFor(assetId, navList(1_000_000, 1_000_000, 1_200_000));
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(assetId, 2, HaltReason.Disagreement, 3, sha256(evidence));
        assertFalse(post(vs));

        Nav memory n = oracle.navOf(assetId);
        assertEq(uint8(n.state), uint8(NavState.Halted));
        assertEq(n.valueE6, 1_000_000, "the previous value is kept but no longer readable");
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.Disagreement));
        assertEq(oracle.haltCount(assetId), 1);

        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.OracleHalted.selector, assetId, HaltReason.Disagreement)
        );
        oracle.requireFreshNav(assetId);

        (, bool usable) = oracle.peekNav(assetId);
        assertFalse(usable);
    }

    function test_Halts_WhenFewerThanQuorumSurvive() public {
        Verdict[] memory vs = roundFor(assetId, navList(1_000_000, 1_000_000, 1_000_000));
        // Slot 2 answers with a confidence below the floor: authentic, but not usable.
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 4999, block.timestamp);

        vm.recordLogs();
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(assetId, 1, HaltReason.InsufficientQuorum, 2, sha256(evidence));
        assertFalse(post(vs));
        assertEq(uint8(rejectionFor(2)), uint8(RejectReason.LowConfidence));

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted));
        assertEq(oracle.haltCount(assetId), 1);
    }

    function test_Halts_WhenDistinctSignersNotMetDespiteQuorum() public {
        // Two slots run the same model, so one attested key can legitimately answer both.
        bytes32 id = keccak256("assay.test.asset.twin-models");
        string[] memory models = new string[](3);
        models[0] = MODEL_0;
        models[1] = MODEL_0;
        models[2] = MODEL_1;
        AssetConfig memory cfg = defaultConfig();
        cfg.quorum = 3;
        cfg.minDistinctSigners = 3;
        registerAsset(id, models, cfg);

        Verdict[] memory vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, id, 0, 1_000_000, 9000, block.timestamp);
        vs[1] = goodVerdict(PK_0, id, 1, 1_000_000, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_1, id, 2, 1_000_000, 9000, block.timestamp);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(id, 1, HaltReason.InsufficientQuorum, 3, sha256(evidence));
        assertFalse(oracle.postAppraisal(id, evidence, vs));

        // Quorum was met on count; it was the distinct-key requirement that failed.
        assertEq(uint8(oracle.navOf(id).state), uint8(NavState.Halted));

        cfg.minDistinctSigners = 2;
        vm.prank(issuer);
        assets.configureAsset(id, cfg);
        vm.warp(block.timestamp + 1);

        vs[0] = goodVerdict(PK_0, id, 0, 1_000_000, 9000, block.timestamp);
        vs[1] = goodVerdict(PK_0, id, 1, 1_000_000, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_1, id, 2, 1_000_000, 9000, block.timestamp);
        assertTrue(oracle.postAppraisal(id, evidence, vs));
        assertEq(oracle.navOf(id).distinctSigners, 2);
    }

    // -----------------------------------------------------------------------------------
    // Round admission
    // -----------------------------------------------------------------------------------

    function test_Reverts_WhenCommitteeIncomplete() public {
        Verdict[] memory vs = new Verdict[](2);
        vs[0] = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        vs[1] = goodVerdict(PK_1, assetId, 1, 1_000_000, 9000, block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.CommitteeIncomplete.selector, 2, 3));
        post(vs);
    }

    function test_Reverts_WhenAssetInactive() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        vm.prank(issuer);
        assets.setActive(assetId, false);
        vm.expectRevert(AssayOracle.AssetNotActive.selector);
        post(vs);
    }

    function test_Reverts_WhenAssetUnknown() public {
        vm.expectRevert(AssetRegistry.UnknownAsset.selector);
        oracle.postAppraisal(keccak256("nothing"), evidence, new Verdict[](0));
    }

    function test_Reverts_WhenEvidenceTooLong() public {
        evidence = new bytes(8193);
        for (uint256 i = 0; i < 8193; ++i) {
            evidence[i] = "a";
        }
        vm.expectRevert(AssayOracle.EvidenceTooLong.selector);
        oracle.postAppraisal(assetId, evidence, new Verdict[](3));
    }

    function test_Reverts_WhenEvidenceWouldBreakTheJsonBody() public {
        // A quote or a backslash in the evidence would restructure the request the models see.
        vm.expectRevert(AssayOracle.EvidenceNotJsonSafe.selector);
        oracle.postAppraisal(assetId, 'asset_id="x"', new Verdict[](3));

        vm.expectRevert(AssayOracle.EvidenceNotJsonSafe.selector);
        oracle.postAppraisal(assetId, "asset_id=x\\y", new Verdict[](3));

        vm.expectRevert(AssayOracle.EvidenceNotJsonSafe.selector);
        oracle.postAppraisal(assetId, "asset_id=x\ny", new Verdict[](3));
    }

    function test_DuplicateSlot_IsRejectedForTheSecondClaim() public {
        bytes32 id = keccak256("assay.test.asset.duplicate-slot");
        listCommittee(id, 3, 2, 2);

        Verdict[] memory vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, id, 0, 1_000_000, 9000, block.timestamp);
        vs[1] = goodVerdict(PK_0, id, 0, 9_000_000, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, id, 2, 1_000_000, 9000, block.timestamp);

        vm.recordLogs();
        assertTrue(oracle.postAppraisal(id, evidence, vs));
        assertEq(uint8(rejectionFor(0)), uint8(RejectReason.DuplicateSlot));
        assertEq(oracle.navOf(id).valueE6, 1_000_000, "the first claim on a slot is the one that counts");
        assertEq(oracle.navOf(id).accepted, 2);
    }

    function test_OutOfRangeSlot_IsRejected() public {
        Verdict[] memory vs = roundFor(assetId, navList(1_000_000, 1_000_000, 1_000_000));
        vs[2].slot = 7;

        vm.recordLogs();
        assertFalse(post(vs));
        assertEq(uint8(rejectionFor(7)), uint8(RejectReason.DuplicateSlot));
    }

    // -----------------------------------------------------------------------------------
    // Rounds nobody could have produced
    // -----------------------------------------------------------------------------------

    /// @dev Posting is permissionless. If junk could halt the oracle, freezing every consumer of
    ///      an asset would cost one transaction, so a round that never reached the committee has to
    ///      leave the state exactly as it found it.
    function test_JunkRound_IsIgnoredRatherThanHalting() public {
        publish(1_000_000);
        uint32 epochBefore = oracle.epochOf(assetId);
        vm.warp(block.timestamp + 60);

        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = Verdict({
                slot: i,
                responseBody: goodBody(assetId, i, 5_000_000, 9000, block.timestamp),
                signature: new bytes(65),
                contentOffset: 0,
                finishOffset: 0,
                createdOffset: 0
            });
        }

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.RoundIgnored(assetId, epochBefore + 1, 0, sha256(evidence));
        assertFalse(post(vs));

        Nav memory n = oracle.navOf(assetId);
        assertEq(uint8(n.state), uint8(NavState.Live), "a junk round cannot take the oracle down");
        assertEq(n.valueE6, 1_000_000);
        assertEq(oracle.haltCount(assetId), 0);
        assertEq(oracle.requireFreshNav(assetId), 1_000_000);
    }

    function test_AuthenticButUnusableRound_DoesHalt() public {
        publish(1_000_000);
        vm.warp(block.timestamp + 60);

        // Real signatures from real attested keys, but every answer is truncated.
        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            bytes memory body = responseBody(
                block.timestamp, assets.modelAt(assetId, i), marker(1_000_000, 9000), "length"
            );
            vs[i] = verdictOf(pkAt(i), assetId, i, evidence, body);
        }

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(assetId, 2, HaltReason.InsufficientQuorum, 0, sha256(evidence));
        assertFalse(post(vs));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted));
        assertEq(oracle.haltCount(assetId), 1);
    }

    function test_AuthenticationBoundary_IsExactlyQuorum() public {
        publish(1_000_000);
        vm.warp(block.timestamp + 60);

        // Two authentic-but-malformed answers and one forgery: one short of quorum, so ignored.
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = _malformed(0);
        vs[1] = _malformed(1);
        vs[2] = Verdict({
            slot: 2,
            responseBody: goodBody(assetId, 2, 1_000_000, 9000, block.timestamp),
            signature: new bytes(65),
            contentOffset: 0,
            finishOffset: 0,
            createdOffset: 0
        });

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.RoundIgnored(assetId, 2, 2, sha256(evidence));
        assertFalse(post(vs));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live));

        // Replace the forgery with a third authentic answer and the same round halts instead.
        vs[2] = _malformed(2);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(assetId, 3, HaltReason.InsufficientQuorum, 0, sha256(evidence));
        assertFalse(post(vs));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted));
    }

    function _malformed(uint8 slot) internal view returns (Verdict memory) {
        bytes memory body = responseBody(
            block.timestamp, assets.modelAt(assetId, slot), "I am unable to appraise this asset.", "stop"
        );
        return verdictOf(pkAt(slot), assetId, slot, evidence, body);
    }

    // -----------------------------------------------------------------------------------
    // Sequencer health
    // -----------------------------------------------------------------------------------

    function test_Halts_WhenSequencerIsDown() public {
        MockSequencerFeed feed = new MockSequencerFeed(1, block.timestamp - 1 days);
        oracle.setSequencerFeed(feed, 30 minutes);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(assetId, 1, HaltReason.SequencerDown, 0, sha256(evidence));
        assertFalse(post(agreeingRound(1_000_000)));
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.SequencerDown));
    }

    function test_Halts_WhenSequencerIsInsideItsGracePeriod() public {
        MockSequencerFeed feed = new MockSequencerFeed(0, block.timestamp - 10 minutes);
        oracle.setSequencerFeed(feed, 30 minutes);
        assertFalse(post(agreeingRound(1_000_000)), "up, but not up long enough to be trusted");
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.SequencerDown));

        feed.set(0, block.timestamp - 31 minutes);
        vm.warp(block.timestamp + 1);
        assertTrue(post(agreeingRound(1_000_000)));
    }

    function test_RequireFreshNav_RevertsWhenSequencerGoesDownAfterPublishing() public {
        publish(1_000_000);
        MockSequencerFeed feed = new MockSequencerFeed(1, block.timestamp);
        oracle.setSequencerFeed(feed, 30 minutes);

        vm.expectRevert(AssayOracle.SequencerDown.selector);
        oracle.requireFreshNav(assetId);
        (, bool usable) = oracle.peekNav(assetId);
        assertFalse(usable);
    }

    /// @dev `startedAt == 0` is Chainlink's marker for a round that has not started, and a feed
    ///      reporting a future start would underflow the grace subtraction. `peekNav` promises an
    ///      answer rather than an exception, so neither may revert.
    function test_PeekNav_DoesNotRevertOnDegenerateFeedReadings() public {
        publish(1_000_000);
        MockSequencerFeed feed = new MockSequencerFeed(0, 0);
        oracle.setSequencerFeed(feed, 30 minutes);

        (, bool usableAtZero) = oracle.peekNav(assetId);
        assertFalse(usableAtZero);

        feed.set(0, block.timestamp + 1 days);
        (, bool usableInFuture) = oracle.peekNav(assetId);
        assertFalse(usableInFuture);

        vm.expectRevert(AssayOracle.SequencerDown.selector);
        oracle.requireFreshNav(assetId);
    }

    // -----------------------------------------------------------------------------------
    // Consumption
    // -----------------------------------------------------------------------------------

    function test_RequireFreshNav_RevertsWhenThereIsNoNav() public {
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NoNav.selector, assetId));
        oracle.requireFreshNav(assetId);

        (, bool usable) = oracle.peekNav(assetId);
        assertFalse(usable);
    }

    function test_RequireFreshNav_RevertsOnceTheNavAgesPastMaxAge() public {
        publish(1_000_000);
        uint64 observedAt = oracle.navOf(assetId).observedAt;
        assertEq(observedAt, uint64(START_TIME));

        vm.warp(START_TIME + 3600);
        assertEq(oracle.requireFreshNav(assetId), 1_000_000, "the last second of the window is fine");

        vm.warp(START_TIME + 3601);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NavStale.selector, assetId, observedAt));
        oracle.requireFreshNav(assetId);

        (Nav memory n, bool usable) = oracle.peekNav(assetId);
        assertFalse(usable);
        assertEq(uint8(n.state), uint8(NavState.Live), "state is still Live; it is simply too old");
    }

    // -----------------------------------------------------------------------------------
    // Governance
    // -----------------------------------------------------------------------------------

    function test_Governance_IsOwnerOnly() public {
        address stranger = address(0xBAD);
        vm.startPrank(stranger);
        vm.expectRevert(AssayOracle.NotOwner.selector);
        oracle.setSequencerFeed(MockSequencerFeed(address(0)), 1);
        vm.expectRevert(AssayOracle.NotOwner.selector);
        oracle.setFutureSkew(1);
        vm.expectRevert(AssayOracle.NotOwner.selector);
        oracle.setChallengeWindow(1);
        vm.expectRevert(AssayOracle.NotOwner.selector);
        oracle.setGrammar("a", "b", "c", "d", "e");
        vm.expectRevert(AssayOracle.NotOwner.selector);
        oracle.transferOwnership(stranger);
        vm.stopPrank();
    }

    function test_SetGrammar_ChangesWhatCountsAsWellFormed() public {
        oracle.setGrammar('"content":"NAV2|value=', "|conf=", '"', '"finish_reason":"stop"', '"created":');

        bytes memory body = responseBody(
            block.timestamp,
            assets.modelAt(assetId, 0),
            string.concat("NAV2|value=", vm.toString(uint256(1_000_000)), "|conf=9000"),
            "stop"
        );
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = verdictOf(PK_0, assetId, 0, evidence, body);
        vs[1] = goodVerdict(PK_1, assetId, 1, 1_000_000, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 9000, block.timestamp);

        vm.recordLogs();
        assertFalse(post(vs), "the old grammar no longer parses");
        assertEq(uint8(rejectionFor(1)), uint8(RejectReason.Malformed));
    }

    // -----------------------------------------------------------------------------------
    // Gas
    // -----------------------------------------------------------------------------------

    function test_Gas_PostAppraisal_ThreeMembers() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        uint256 before = gasleft();
        oracle.postAppraisal(assetId, evidence, vs);
        emit log_named_uint("postAppraisal gas, 3 members", before - gasleft());
    }

    function test_Gas_PostAppraisal_FiveMembers() public {
        listCommittee(ASSET_5, 5, 5, 5);
        Verdict[] memory vs =
            roundFor(ASSET_5, navList(1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000));
        uint256 before = gasleft();
        oracle.postAppraisal(ASSET_5, evidence, vs);
        emit log_named_uint("postAppraisal gas, 5 members", before - gasleft());
    }
}
