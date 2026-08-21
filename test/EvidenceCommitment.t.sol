// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AssetConfig, NavState, Verdict} from "../src/Types.sol";

/// @notice Whoever posts a round also supplies the facts the models were shown, which is the one
///         input the chain cannot verify for itself. The commitment splits that apart: the issuer
///         says what the evidence is, the committee says what it is worth, and the oracle checks
///         that the round it is being handed used the one against the other.
contract EvidenceCommitmentTest is Fixtures {
    bytes32 internal constant OTHER = keccak256("assay.test.asset.other-evidence");

    function _round(bytes32 id, bytes memory ev) internal view returns (Verdict[] memory vs) {
        vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = verdictOf(pkAt(i), id, i, ev, goodBody(id, i, 1_000_000, 9000, block.timestamp));
        }
    }

    function test_CommittedEvidence_IsAccepted() public {
        assertTrue(assets.evidenceAllowed(assetId, sha256(evidence)));
        assertTrue(post(_round(assetId, evidence)));
        assertEq(oracle.navOf(assetId).evidenceHash, sha256(evidence));
    }

    function test_UncommittedEvidence_IsRefused() public {
        bytes memory invented = "schema=assay.test.v1;asset_id=carbon-001;credits=999999;vintage=2024";
        Verdict[] memory vs = _round(assetId, invented);

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(invented)));
        oracle.postAppraisal(assetId, invented, vs);

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Empty));
        assertEq(oracle.epochOf(assetId), 0, "a refused round never opens an epoch");
    }

    /// @dev One byte of difference is a different document, which is the whole point of committing
    ///      to a digest rather than to a description.
    function test_Commitment_BindsTheExactBytes() public {
        bytes memory altered = tamper(evidence, evidence.length - 1, "5");
        Verdict[] memory vs = _round(assetId, altered);

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(altered)));
        oracle.postAppraisal(assetId, altered, vs);
    }

    function test_WithdrawnCommitment_StartsRefusingAgain() public {
        assertTrue(post(_round(assetId, evidence)));

        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(assetId, h, "ipfs://evidence", false);

        vm.warp(block.timestamp + 60);
        Verdict[] memory vs = _round(assetId, evidence);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, h));
        oracle.postAppraisal(assetId, evidence, vs);
    }

    /// @dev The commitment is per asset, and that is what stops a round for one asset being filed
    ///      under another. The signature covers the request bytes, which carry the schema, the model
    ///      and the evidence but not the asset id, so two assets sharing a schema and a committee
    ///      would otherwise accept each other's verdicts verbatim.
    function test_Commitment_IsScopedToOneAsset() public {
        AssetConfig memory cfg = defaultConfig();
        vm.prank(issuer);
        assets.registerAsset(OTHER, cfg, committee3(), "ipfs://assay/test");
        // Deliberately not committed for OTHER, though it is committed for the default asset.

        Verdict[] memory vs = _round(assetId, evidence);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(evidence)));
        oracle.postAppraisal(OTHER, evidence, vs);

        // And once its own issuer stands behind the same document, the replay does go through, so
        // the commitment is doing the work rather than the signature.
        commit(OTHER, evidence);
        assertTrue(oracle.postAppraisal(OTHER, evidence, vs));
    }

    function test_Commitment_IsIssuerOnly() public {
        bytes32 h = sha256("some other evidence");
        vm.prank(address(0xBAD));
        vm.expectRevert(AssetRegistry.NotIssuer.selector);
        assets.commitEvidence(assetId, h, "ipfs://evidence", true);
    }

    function test_ResolveDispute_EnforcesTheCommitmentToo() public {
        assertTrue(post(_round(assetId, evidence)));

        address challenger = makeAddr("challenger");
        vm.deal(challenger, 1 ether);
        vm.prank(challenger);
        oracle.challenge{value: 0.01 ether}(assetId);

        vm.warp(block.timestamp + 60);
        bytes memory altered = tamper(evidence, 0, "S");
        Verdict[] memory vs = _round(assetId, altered);

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(altered)));
        oracle.resolveDispute(assetId, altered, vs);
    }

    /// @dev The charset and length limits sit ahead of the commitment check, so evidence that could
    ///      never have been committed is still refused for the reason that describes it.
    function test_UnsafeEvidence_IsRefusedBeforeTheCommitmentIsConsulted() public {
        vm.expectRevert(AssayOracle.EvidenceNotJsonSafe.selector);
        oracle.postAppraisal(assetId, 'asset_id="x"', new Verdict[](3));
    }
}
