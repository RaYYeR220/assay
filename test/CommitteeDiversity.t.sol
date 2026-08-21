// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetConfig, HaltReason, NavState, Verdict} from "../src/Types.sol";

/// @notice Two different things can be diverse about a committee, and an asset has to choose which
///         one it is buying. A gateway that fronts five models with one enclave gives model
///         diversity and a single key; a fleet of eleven instances of one model gives key diversity
///         and one model. `quorum` counts answers, `minDistinctSigners` counts enclaves, and only
///         the second notices when several slots come from the same box.
contract CommitteeDiversityTest is Fixtures {
    bytes32 internal constant MODEL_DIVERSE = keccak256("assay.test.asset.model-diverse");
    bytes32 internal constant ENCLAVE_DIVERSE = keccak256("assay.test.asset.enclave-diverse");

    string internal constant KIMI = "moonshotai/kimi-k2.6";

    /// @dev Five models, all served by one gateway enclave, so every answer carries the same key.
    function _listModelDiverse() internal {
        AssetConfig memory cfg = defaultConfig();
        cfg.quorum = 5;
        cfg.minDistinctSigners = 1;
        registerAsset(MODEL_DIVERSE, committee5(), cfg);
        for (uint256 i = 0; i < 5; ++i) {
            attest(PK_0, modelName(i));
        }
    }

    /// @dev One model, five instances, each with its own key.
    function _listEnclaveDiverse(uint8 minDistinct) internal {
        string[] memory models = new string[](5);
        for (uint256 i = 0; i < 5; ++i) {
            models[i] = KIMI;
        }
        AssetConfig memory cfg = defaultConfig();
        cfg.quorum = 5;
        cfg.minDistinctSigners = minDistinct;
        registerAsset(ENCLAVE_DIVERSE, models, cfg);
        for (uint256 i = 0; i < 5; ++i) {
            attest(pkAt(i), KIMI);
        }
    }

    function _round(bytes32 id, uint256[5] memory pks) internal view returns (Verdict[] memory vs) {
        vs = new Verdict[](5);
        for (uint8 i = 0; i < 5; ++i) {
            vs[i] = goodVerdict(pks[i], id, i, 1_000_000, 9000, block.timestamp);
        }
    }

    function test_ModelDiverseCommittee_PublishesFromASingleEnclaveKey() public {
        _listModelDiverse();
        Verdict[] memory vs = _round(MODEL_DIVERSE, [PK_0, PK_0, PK_0, PK_0, PK_0]);

        assertTrue(oracle.postAppraisal(MODEL_DIVERSE, evidence, vs));
        assertEq(oracle.navOf(MODEL_DIVERSE).accepted, 5);
        assertEq(oracle.navOf(MODEL_DIVERSE).distinctSigners, 1, "one gateway, five models");
        assertEq(oracle.navOf(MODEL_DIVERSE).valueE6, 1_000_000);
    }

    /// @dev Each slot still names its own model, so the request bytes differ per slot and the one
    ///      key has to sign five different payloads. A single signature does not cover the round.
    function test_ModelDiverseCommittee_StillBindsEachSlotToItsModel() public {
        _listModelDiverse();
        Verdict[] memory vs = _round(MODEL_DIVERSE, [PK_0, PK_0, PK_0, PK_0, PK_0]);
        vs[4].signature = vs[0].signature;

        assertFalse(oracle.postAppraisal(MODEL_DIVERSE, evidence, vs));
        assertEq(uint8(oracle.navOf(MODEL_DIVERSE).state), uint8(NavState.Empty));
    }

    function test_EnclaveDiverseCommittee_PublishesWithDistinctKeys() public {
        _listEnclaveDiverse(3);
        Verdict[] memory vs = _round(ENCLAVE_DIVERSE, [PK_0, PK_1, PK_2, PK_3, PK_4]);

        assertTrue(oracle.postAppraisal(ENCLAVE_DIVERSE, evidence, vs));
        assertEq(oracle.navOf(ENCLAVE_DIVERSE).distinctSigners, 5);
    }

    function test_EnclaveDiverseCommittee_AcceptsExactlyTheThreshold() public {
        _listEnclaveDiverse(3);
        // Three slots from one instance, two from others: quorum is met and so is the threshold.
        Verdict[] memory vs = _round(ENCLAVE_DIVERSE, [PK_0, PK_0, PK_0, PK_1, PK_2]);

        assertTrue(oracle.postAppraisal(ENCLAVE_DIVERSE, evidence, vs));
        assertEq(oracle.navOf(ENCLAVE_DIVERSE).accepted, 5);
        assertEq(oracle.navOf(ENCLAVE_DIVERSE).distinctSigners, 3);
    }

    /// @dev Every slot answers, every answer is valid, and the round still refuses: five answers
    ///      from two boxes are two opinions wearing five hats.
    function test_EnclaveDiverseCommittee_HaltsWhenTooFewBoxesAnswered() public {
        _listEnclaveDiverse(3);
        Verdict[] memory vs = _round(ENCLAVE_DIVERSE, [PK_0, PK_0, PK_0, PK_0, PK_1]);

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.Halted(ENCLAVE_DIVERSE, 1, HaltReason.InsufficientQuorum, 5, sha256(evidence));
        assertFalse(oracle.postAppraisal(ENCLAVE_DIVERSE, evidence, vs));
        assertEq(uint8(oracle.navOf(ENCLAVE_DIVERSE).state), uint8(NavState.Halted));
    }

    /// @dev With one model across every slot the request bytes are identical, so one answer can be
    ///      copied into all five. The distinct-signer floor is the only thing that notices.
    function test_EnclaveDiverseCommittee_CatchesOneAnswerCopiedAcrossEverySlot() public {
        _listEnclaveDiverse(3);
        Verdict memory one = goodVerdict(PK_0, ENCLAVE_DIVERSE, 0, 1_000_000, 9000, block.timestamp);

        Verdict[] memory vs = new Verdict[](5);
        for (uint8 i = 0; i < 5; ++i) {
            vs[i] = Verdict({
                slot: i,
                responseBody: one.responseBody,
                signature: one.signature,
                contentOffset: one.contentOffset,
                finishOffset: one.finishOffset,
                createdOffset: one.createdOffset
            });
        }

        assertFalse(oracle.postAppraisal(ENCLAVE_DIVERSE, evidence, vs), "five copies is still one answer");
        assertEq(uint8(oracle.lastHaltReason(ENCLAVE_DIVERSE)), uint8(HaltReason.InsufficientQuorum));

        // The same committee with a floor of one would have taken it, which is why the floor is a
        // per-asset choice rather than a constant.
        _listModelDiverse();
        assertEq(assets.config(MODEL_DIVERSE).minDistinctSigners, 1);
    }
}
