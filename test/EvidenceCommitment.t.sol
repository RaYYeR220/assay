// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AssetConfig, NavState, Verdict} from "../src/Types.sol";

/// @notice Whoever posts a round also supplies the facts the models were shown, which is the one
///         input the chain cannot verify. The commitment splits that apart: the issuer says what
///         the evidence is, the committee says what it is worth, and the oracle checks both.
contract EvidenceCommitmentTest is Fixtures {
    bytes32 internal constant STRICT = keccak256("assay.test.asset.strict-evidence");

    function _strictAsset() internal {
        AssetConfig memory cfg = defaultConfig();
        cfg.requireAllowedEvidence = true;
        registerAsset(STRICT, committee3(), cfg);
    }

    function _round(bytes32 id) internal view returns (Verdict[] memory vs) {
        vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = goodVerdict(pkAt(i), id, i, 1_000_000, 9000, block.timestamp);
        }
    }

    function test_UncommittedEvidence_IsAcceptedWhenTheFlagIsOff() public {
        assertFalse(assets.config(assetId).requireAllowedEvidence);
        assertTrue(post(agreeingRound(1_000_000)));
    }

    function test_UncommittedEvidence_RevertsWhenTheFlagIsOn() public {
        _strictAsset();
        Verdict[] memory vs = _round(STRICT);

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(evidence)));
        oracle.postAppraisal(STRICT, evidence, vs);
        assertEq(uint8(oracle.navOf(STRICT).state), uint8(NavState.Empty));
        assertEq(oracle.epochOf(STRICT), 0, "a refused round never opens an epoch");
    }

    function test_CommittedEvidence_IsAccepted() public {
        _strictAsset();
        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(STRICT, h, "ipfs://evidence/carbon-001", true);

        assertTrue(oracle.postAppraisal(STRICT, evidence, _round(STRICT)));
        assertEq(oracle.navOf(STRICT).evidenceHash, sha256(evidence));
    }

    function test_WithdrawnCommitment_StartsRefusingAgain() public {
        _strictAsset();
        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(STRICT, h, "ipfs://evidence", true);
        assertTrue(oracle.postAppraisal(STRICT, evidence, _round(STRICT)));

        vm.prank(issuer);
        assets.commitEvidence(STRICT, h, "ipfs://evidence", false);

        vm.warp(block.timestamp + 60);
        Verdict[] memory vs = _round(STRICT);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(evidence)));
        oracle.postAppraisal(STRICT, evidence, vs);
    }

    function test_Commitment_IsScopedToOneAsset() public {
        _strictAsset();
        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(assetId, h, "ipfs://evidence", true);

        // Committed for the other asset, which says nothing about this one.
        Verdict[] memory vs = _round(STRICT);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(evidence)));
        oracle.postAppraisal(STRICT, evidence, vs);
    }

    function test_Commitment_IsIssuerOnly() public {
        _strictAsset();
        bytes32 h = sha256(evidence);
        vm.prank(address(0xBAD));
        vm.expectRevert(AssetRegistry.NotIssuer.selector);
        assets.commitEvidence(STRICT, h, "ipfs://evidence", true);
    }

    function test_Commitment_BindsTheExactBytes() public {
        _strictAsset();
        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(STRICT, h, "ipfs://evidence", true);

        bytes memory altered = tamper(evidence, evidence.length - 1, "5");
        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            bytes memory body = goodBody(STRICT, i, 1_000_000, 9000, block.timestamp);
            vs[i] = verdictOf(pkAt(i), STRICT, i, altered, body);
        }

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(altered)));
        oracle.postAppraisal(STRICT, altered, vs);
    }

    function test_ResolveDispute_EnforcesTheCommitmentToo() public {
        _strictAsset();
        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(STRICT, h, "ipfs://evidence", true);
        assertTrue(oracle.postAppraisal(STRICT, evidence, _round(STRICT)));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, 1 ether);
        vm.prank(challenger);
        oracle.challenge{value: 0.01 ether}(STRICT);

        vm.warp(block.timestamp + 60);
        bytes memory altered = tamper(evidence, 0, "S");
        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = verdictOf(pkAt(i), STRICT, i, altered, goodBody(STRICT, i, 1_000_000, 9000, block.timestamp));
        }

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(altered)));
        oracle.resolveDispute(STRICT, altered, vs);
    }
}
