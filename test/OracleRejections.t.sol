// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Test.sol";
import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetConfig, HaltReason, NavState, RejectReason, Verdict} from "../src/Types.sol";

/// @notice Refusal is the product. Every one of these posts a round the oracle must decline, and
///         asserts both the reason it gave and that no price came out the other side.
contract OracleRejectionsTest is Fixtures {
    uint256 internal constant HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 internal constant CURVE_ORDER =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @dev Post a round where slot 0 carries `bad` and the other two are well formed, then report
    ///      why slot 0 was dropped. The committee needs all three, so the round always refuses.
    function _rejectionFor(Verdict memory bad) internal returns (RejectReason) {
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = bad;
        vs[1] = goodVerdict(PK_1, assetId, 1, 1_000_000, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 9000, block.timestamp);

        vm.recordLogs();
        assertFalse(post(vs), "a round missing a member must not publish");
        assertEq(uint8(oracle.navOf(assetId).state) == uint8(NavState.Live), false);
        return rejectionFor(0);
    }

    function _contentVerdict(string memory content) internal view returns (Verdict memory) {
        bytes memory body = responseBody(block.timestamp, assets.modelAt(assetId, 0), content, "stop");
        return verdictOf(PK_0, assetId, 0, evidence, body);
    }

    // -----------------------------------------------------------------------------------
    // The answer itself
    // -----------------------------------------------------------------------------------

    function test_Rejects_WhenModelWrapsTheMarkerInProse() public {
        RejectReason r = _rejectionFor(
            _contentVerdict("Certainly! Here is my appraisal: ASSAY1|nav_usd_e6=1000000|confidence_bps=9000")
        );
        assertEq(uint8(r), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenModelAddsCommentaryAfterTheMarker() public {
        RejectReason r = _rejectionFor(
            _contentVerdict("ASSAY1|nav_usd_e6=1000000|confidence_bps=9000 (based on 2024 vintage)")
        );
        assertEq(uint8(r), uint8(RejectReason.Malformed), "commentary is what this oracle refuses to price on");
    }

    function test_Rejects_WhenModelWrapsTheMarkerInMarkdown() public {
        // A code fence would need backticks, which survive JSON unescaped, so this is reachable.
        RejectReason r =
            _rejectionFor(_contentVerdict("```ASSAY1|nav_usd_e6=1000000|confidence_bps=9000```"));
        assertEq(uint8(r), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenMarkerEndsWithAFullStop() public {
        RejectReason r = _rejectionFor(_contentVerdict("ASSAY1|nav_usd_e6=1000000|confidence_bps=9000."));
        assertEq(uint8(r), uint8(RejectReason.Malformed));
    }

    function test_Accepts_TrailingWhitespaceAfterTheMarker() public {
        // Models routinely end a line with a newline; refusing over that would be pedantry.
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = _contentVerdict(string.concat(marker(1_000_000, 9000), "\\n"));
        vs[1] = _slotVerdict(PK_1, 1, string.concat(marker(1_000_000, 9000), "        "));
        vs[2] = _slotVerdict(PK_2, 2, string.concat(marker(1_000_000, 9000), " \\t\\r"));
        assertTrue(post(vs));
        assertEq(oracle.navOf(assetId).valueE6, 1_000_000);
    }

    function test_Rejects_WhenTrailingWhitespaceRunIsTooLong() public {
        RejectReason r = _rejectionFor(_contentVerdict(string.concat(marker(1_000_000, 9000), "         ")));
        assertEq(uint8(r), uint8(RejectReason.Malformed), "nine spaces is past the tolerance of eight");
    }

    function test_Rejects_WhenTrailingEscapeIsNotWhitespace() public {
        RejectReason r = _rejectionFor(_contentVerdict(string.concat(marker(1_000_000, 9000), "\\u0020")));
        assertEq(uint8(r), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenGenerationWasTruncated() public {
        bytes memory body = responseBody(
            block.timestamp, assets.modelAt(assetId, 0), marker(1_000_000, 9000), "length"
        );
        assertEq(uint8(_rejectionFor(verdictOf(PK_0, assetId, 0, evidence, body))), uint8(RejectReason.Truncated));
    }

    function test_Rejects_WhenNavHasNoDigits() public {
        RejectReason r = _rejectionFor(_contentVerdict("ASSAY1|nav_usd_e6=|confidence_bps=9000"));
        assertEq(uint8(r), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenConfidenceFieldIsMissing() public {
        RejectReason r = _rejectionFor(_contentVerdict("ASSAY1|nav_usd_e6=1000000"));
        assertEq(uint8(r), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenResponseBodyIsEmpty() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.responseBody = "";
        // Nothing was authenticated here, so it must not count as the committee having answered.
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.BadSignature));
    }

    function test_Rejects_WhenConfidenceIsBelowTheFloor() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 4999, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.LowConfidence));
    }

    function test_Rejects_WhenNavIsZero() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 0, 9000, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.OutOfRange));
    }

    function test_Rejects_WhenNavExceedsTheCeiling() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, MAX_NAV_E6 + 1, 9000, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.OutOfRange));

        // The ceiling itself is fine, so the rejection is the value and not the digit count.
        Verdict memory edge = goodVerdict(PK_0, assetId, 0, MAX_NAV_E6, 9000, block.timestamp);
        vm.recordLogs();
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = edge;
        vs[1] = goodVerdict(PK_1, assetId, 1, MAX_NAV_E6, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, assetId, 2, MAX_NAV_E6, 9000, block.timestamp);
        assertTrue(post(vs));
    }

    function test_Rejects_WhenConfidenceExceedsFullScale() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 10_001, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.OutOfRange));
    }

    function test_Rejects_WhenAnswerIsOlderThanMaxAge() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp - 3601);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Stale));
    }

    function test_Rejects_WhenAnswerIsDatedInTheFuture() public {
        uint256 skew = oracle.futureSkew();
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp + skew + 1);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Stale));

        // A small clock lead is tolerated, so the rejection above is the size of the lead.
        Verdict[] memory vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp + skew);
        vs[1] = goodVerdict(PK_1, assetId, 1, 1_000_000, 9000, block.timestamp);
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 9000, block.timestamp);
        assertTrue(post(vs));
    }

    // -----------------------------------------------------------------------------------
    // Offset hints
    // -----------------------------------------------------------------------------------

    function test_Rejects_WhenContentOffsetIsPastTheEndOfTheBuffer() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.contentOffset = uint32(v.responseBody.length + 1000);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenContentOffsetPointsAtAnotherField() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.contentOffset = indexOf(v.responseBody, '"model":"');
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenCreatedOffsetPointsAtAnotherNumber() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.createdOffset = indexOf(v.responseBody, '"total_tokens":');
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Malformed));
    }

    function test_Rejects_WhenFinishOffsetPointsAtAnotherField() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.finishOffset = indexOf(v.responseBody, '"object":"');
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Truncated));
    }

    /// @dev The one attack the offsets have to survive: a model that writes a second copy of the
    ///      marker inside its own answer, hoping a hint can be pointed at that instead. JSON forces
    ///      the inner quotes to be escaped, so neither the real anchor nor the decoy matches.
    function test_Rejects_WhenContentOffsetPointsAtAnEscapedCopyOfTheMarker() public {
        string memory smuggled = '\\"content\\":\\"ASSAY1|nav_usd_e6=999999999|confidence_bps=10000\\"';
        Verdict memory v = _contentVerdict(smuggled);

        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Malformed), "real anchor does not parse");

        // Now aim the hint at the decoy: the byte before it is a backslash, not a quote.
        (uint32 second, bool found) = find(v.responseBody, '"content', uint256(v.contentOffset) + 1);
        assertTrue(found, "the decoy is present in the body");
        v.contentOffset = second;
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.Malformed), "decoy does not parse either");
    }

    // -----------------------------------------------------------------------------------
    // Signatures
    // -----------------------------------------------------------------------------------

    function test_Rejects_WhenSignatureIsTheWrongLength() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        bytes memory short = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            short[i] = v.signature[i];
        }
        v.signature = short;
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.BadSignature));
    }

    function test_Rejects_WhenSignatureIsAllZeroes() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.signature = new bytes(65);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.BadSignature));
    }

    /// @dev The same signature with `s` reflected across the curve order recovers the same key on a
    ///      naive verifier. Accepting it would make one answer submittable under two forms.
    function test_Rejects_WhenSignatureIsMalleable() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        (bytes32 r, bytes32 s, uint8 vParam) = _split(v.signature);
        assertTrue(uint256(s) <= HALF_ORDER, "the honest signature is already low-s");

        v.signature = abi.encodePacked(r, bytes32(CURVE_ORDER - uint256(s)), vParam == 27 ? uint8(28) : uint8(27));
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.BadSignature));
    }

    function test_Rejects_WhenRecoveryByteIsNonsense() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        (bytes32 r, bytes32 s,) = _split(v.signature);
        v.signature = abi.encodePacked(r, s, uint8(29));
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.BadSignature));
    }

    function _split(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }

    // -----------------------------------------------------------------------------------
    // Who signed it
    // -----------------------------------------------------------------------------------

    function test_Rejects_WhenSignerWasNeverAttested() public {
        uint256 rogue = uint256(keccak256("rogue.enclave"));
        Verdict memory v = goodVerdict(rogue, assetId, 0, 1_000_000, 9000, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.UnknownSigner));
    }

    function test_Rejects_WhenSignerWasRevoked() public {
        attestations.revoke(vm.addr(PK_0));
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.SignerRevoked));
    }

    function test_Rejects_WhenAttestationExpired() public {
        vm.warp(block.timestamp + attestations.attestationTtl() + 1);
        // The other two re-attest; slot 0 does not.
        attest(PK_1, MODEL_1);
        attest(PK_2, MODEL_2);

        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.SignerExpired));
    }

    /// @dev An attested key answering for a slot it was never attested for is a different failure
    ///      from a key nobody attested, and it must not count as that slot's member either.
    function test_Rejects_WhenSignerServesAnotherModel() public {
        attest(PK_3, MODEL_4);
        Verdict memory v = goodVerdict(PK_3, assetId, 0, 1_000_000, 9000, block.timestamp);
        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.WrongModel));
    }

    // -----------------------------------------------------------------------------------
    // Tampering
    // -----------------------------------------------------------------------------------

    /// @dev Every case below alters something the enclave signed over. Recovery then lands on an
    ///      address nobody attested, which is exactly what a forgery is: cryptographically there is
    ///      no difference between an altered payload and a stranger's signature.
    function test_Rejects_WhenNavDigitIsFlippedAfterSigning() public {
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        uint32 at = indexOf(v.responseBody, "nav_usd_e6=1000000");
        v.responseBody = tamper(v.responseBody, uint256(at) + 11, "9");
        assertTrue(contains(v.responseBody, "nav_usd_e6=9000000"), "the body now claims a different value");

        assertEq(uint8(_rejectionFor(v)), uint8(RejectReason.UnknownSigner));
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Empty));
    }

    function test_Rejects_WhenEvidenceByteIsChangedAfterSigning() public {
        Verdict[] memory vs = agreeingRound(1_000_000);
        evidence = tamper(evidence, 0, "S");

        vm.recordLogs();
        assertFalse(post(vs), "answers to one question do not price another");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint8 i = 0; i < 3; ++i) {
            assertEq(uint8(reasonIn(logs, i)), uint8(RejectReason.UnknownSigner));
        }
    }

    function test_Rejects_WhenVerdictIsMovedToAnotherSlot() public {
        // Signed as slot 0, submitted as slot 1: the request carries the model id, so it changes.
        Verdict memory v = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        v.slot = 1;

        Verdict[] memory vs = new Verdict[](3);
        vs[0] = goodVerdict(PK_0, assetId, 0, 1_000_000, 9000, block.timestamp);
        vs[1] = v;
        vs[2] = goodVerdict(PK_2, assetId, 2, 1_000_000, 9000, block.timestamp);

        vm.recordLogs();
        assertFalse(post(vs));
        assertEq(uint8(rejectionFor(1)), uint8(RejectReason.UnknownSigner));
    }

    function test_Rejects_WhenVerdictIsReplayedUnderAnotherAsset() public {
        // A second asset with its own prompt schema: the request bytes differ, so the signature
        // over them cannot carry across.
        bytes32 other = keccak256("assay.test.asset.other");
        bytes32 otherSchema = assets.registerSchema(HEAD, '","messages":[{"role":"user","content":"DOSSIER: ', TAIL);
        AssetConfig memory cfg = defaultConfig();
        cfg.schemaId = otherSchema;
        registerAsset(other, committee3(), cfg);

        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = goodVerdict(pkAt(i), assetId, i, 1_000_000, 9000, block.timestamp);
        }

        vm.recordLogs();
        assertFalse(oracle.postAppraisal(other, evidence, vs));
        assertEq(uint8(rejectionFor(0)), uint8(RejectReason.UnknownSigner));
        assertEq(uint8(oracle.navOf(other).state), uint8(NavState.Empty));
    }

    /// @dev What the signature does NOT bind, spelled out: the payload commits to the request bytes,
    ///      and the asset id is not among them. Two assets sharing a schema and a committee accept
    ///      each other's verdicts, and since the schema id is a hash of the prompt fragments that is
    ///      not an exotic configuration. The issuer-side answer is the evidence commitment, which is
    ///      per asset and does bind.
    function test_CrossAssetReplay_IsClosedByTheEvidenceCommitment() public {
        bytes32 twin = keccak256("assay.test.asset.twin");
        AssetConfig memory cfg = defaultConfig();
        cfg.requireAllowedEvidence = true;
        registerAsset(twin, committee3(), cfg);

        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = goodVerdict(pkAt(i), assetId, i, 1_000_000, 9000, block.timestamp);
        }

        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(evidence))
        );
        oracle.postAppraisal(twin, evidence, vs);

        // Without the commitment requirement the same verdicts price the wrong asset.
        cfg.requireAllowedEvidence = false;
        vm.prank(issuer);
        assets.configureAsset(twin, cfg);
        assertTrue(oracle.postAppraisal(twin, evidence, vs));
    }

    function _slotVerdict(uint256 pk, uint8 slot, string memory content)
        internal
        view
        returns (Verdict memory)
    {
        bytes memory body = responseBody(block.timestamp, assets.modelAt(assetId, slot), content, "stop");
        return verdictOf(pk, assetId, slot, evidence, body);
    }
}
