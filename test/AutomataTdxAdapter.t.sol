// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AutomataTdxAdapter} from "../src/adapters/AutomataTdxAdapter.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {MockDcapAttestation} from "./mocks/MockDcapAttestation.sol";

/// @notice The adapter reads a packed record at fixed offsets, which is the kind of arithmetic that
///         fails silently. Every field is checked against a synthetic record whose bytes say where
///         they came from.
contract AutomataTdxAdapterTest is Test {
    MockDcapAttestation internal dcap;
    AutomataTdxAdapter internal adapter;

    uint256 internal constant OUTPUT_LEN = 595;
    uint256 internal constant OFF_TCB_STATUS = 4;
    uint256 internal constant OFF_FMSPC = 5;
    uint256 internal constant OFF_MRTD = 147;
    uint256 internal constant OFF_RTMR0 = 339;
    uint256 internal constant OFF_REPORT_DATA = 531;

    address internal enclave = address(0xE0C1A5E);

    event QuoteVerified(bytes32 indexed measurement, uint8 tcbStatus, bytes6 fmspc, bytes raw);

    function setUp() public {
        dcap = new MockDcapAttestation();
        adapter = new AutomataTdxAdapter(dcap, 18);
    }

    /// @dev A record whose every documented field carries a distinguishable pattern.
    function _output(bytes1 mrTdFill, bytes1[4] memory rtmrFills, address signer, uint8 tcbStatus)
        internal
        pure
        returns (bytes memory out)
    {
        out = new bytes(OUTPUT_LEN);
        out[0] = 0x00;
        out[1] = 0x04; // quote version
        out[2] = 0x00;
        out[3] = 0x02; // TD 1.0 report body
        out[OFF_TCB_STATUS] = bytes1(tcbStatus);
        for (uint256 i = 0; i < 6; ++i) {
            out[OFF_FMSPC + i] = bytes1(uint8(0x11 * (i + 1)));
        }
        for (uint256 i = 0; i < 48; ++i) {
            out[OFF_MRTD + i] = mrTdFill;
            for (uint256 r = 0; r < 4; ++r) {
                out[OFF_RTMR0 + 48 * r + i] = rtmrFills[r];
            }
        }
        bytes20 packed = bytes20(signer);
        for (uint256 i = 0; i < 20; ++i) {
            out[OFF_REPORT_DATA + i] = packed[i];
        }
    }

    function _fills(bytes1 a, bytes1 b, bytes1 c, bytes1 d) internal pure returns (bytes1[4] memory f) {
        f = [a, b, c, d];
    }

    function _expectedMeasurement(bytes1 mrTdFill, bytes1[4] memory rtmrFills)
        internal
        pure
        returns (bytes32)
    {
        bytes memory raw = new bytes(240);
        for (uint256 i = 0; i < 48; ++i) {
            raw[i] = mrTdFill;
            for (uint256 r = 0; r < 4; ++r) {
                raw[48 * (r + 1) + i] = rtmrFills[r];
            }
        }
        return keccak256(raw);
    }

    function test_ExtractsEveryFieldAtItsDocumentedOffset() public {
        bytes1[4] memory rtmrs = _fills(0xc0, 0xc1, 0xc2, 0xc3);
        dcap.set(true, _output(0xa1, rtmrs, enclave, 7));

        (bool ok, bytes32 measurement, bytes memory reportData, uint8 tcbStatus) =
            adapter.verifyQuote(hex"1234");

        assertTrue(ok);
        assertEq(tcbStatus, 7, "TCB status is the single byte at offset 4");
        assertEq(measurement, _expectedMeasurement(0xa1, rtmrs));
        assertEq(reportData.length, 64, "report data is 64 bytes from offset 531");
        assertEq(address(bytes20(reportData)), enclave);
        for (uint256 i = 20; i < 64; ++i) {
            assertEq(reportData[i], bytes1(0), "the padding after the signer address is zero");
        }
        assertEq(dcap.lastTcbEvaluationDataNumber(), 18, "the pinned evaluation number is passed on");
    }

    function test_EmitsTheRawMeasurementsForAudit() public {
        bytes1[4] memory rtmrs = _fills(0xc0, 0xc1, 0xc2, 0xc3);
        dcap.set(true, _output(0xa1, rtmrs, enclave, 0));

        bytes memory raw = new bytes(240);
        for (uint256 i = 0; i < 48; ++i) {
            raw[i] = 0xa1;
            for (uint256 r = 0; r < 4; ++r) {
                raw[48 * (r + 1) + i] = rtmrs[r];
            }
        }

        vm.expectEmit(true, false, false, true, address(adapter));
        emit QuoteVerified(keccak256(raw), 0, bytes6(hex"112233445566"), raw);
        adapter.verifyQuote(hex"1234");
    }

    /// @dev The reason the measurement is a digest over the whole boot chain rather than the trust
    ///      domain measurement alone: a domain that loaded different software after boot differs
    ///      only in a runtime register, and must not inherit the allowlist entry of the clean one.
    function test_RuntimeRegisterChange_ProducesADifferentMeasurement() public {
        bytes1[4] memory clean = _fills(0xc0, 0xc1, 0xc2, 0xc3);
        bytes1[4] memory dirty = _fills(0xc0, 0xc1, 0xff, 0xc3);

        dcap.set(true, _output(0xa1, clean, enclave, 0));
        (, bytes32 cleanMeasurement,,) = adapter.verifyQuote(hex"1234");

        dcap.set(true, _output(0xa1, dirty, enclave, 0));
        (, bytes32 dirtyMeasurement,,) = adapter.verifyQuote(hex"1234");

        assertTrue(cleanMeasurement != dirtyMeasurement, "RTMR2 is part of the identity");

        // And the difference is what keeps the allowlist honest.
        AttestationRegistry registry = new AttestationRegistry(adapter, address(this));
        registry.setAllowedImage(cleanMeasurement, true);

        vm.expectRevert(
            abi.encodeWithSelector(AttestationRegistry.ImageNotAllowed.selector, dirtyMeasurement)
        );
        registry.registerSigner(hex"1234", "vendor/model");

        dcap.set(true, _output(0xa1, clean, enclave, 0));
        assertEq(registry.registerSigner(hex"1234", "vendor/model"), enclave);
    }

    function test_MrTdChange_ProducesADifferentMeasurement() public {
        bytes1[4] memory rtmrs = _fills(0xc0, 0xc1, 0xc2, 0xc3);
        dcap.set(true, _output(0xa1, rtmrs, enclave, 0));
        (, bytes32 first,,) = adapter.verifyQuote(hex"1234");

        dcap.set(true, _output(0xa2, rtmrs, enclave, 0));
        (, bytes32 second,,) = adapter.verifyQuote(hex"1234");

        assertTrue(first != second);
    }

    /// @dev The verifier reports a failure by returning false with a reason string, not by
    ///      reverting, so a caller that ignored `ok` would treat the reason string as a record.
    function test_FailedVerification_ReturnsNotOkWithoutReverting() public {
        dcap.set(false, bytes("Quote signature is invalid"));

        (bool ok, bytes32 measurement, bytes memory reportData, uint8 tcbStatus) =
            adapter.verifyQuote(hex"1234");

        assertFalse(ok);
        assertEq(measurement, bytes32(0));
        assertEq(reportData.length, 0);
        assertEq(tcbStatus, 0);
    }

    function test_ShortOutput_Reverts() public {
        dcap.set(true, new bytes(OUTPUT_LEN - 1));
        vm.expectRevert(abi.encodeWithSelector(AutomataTdxAdapter.OutputTooShort.selector, OUTPUT_LEN - 1));
        adapter.verifyQuote(hex"1234");
    }

    function test_LongerOutput_IsAccepted() public {
        // Longer records from a future body type must still read at the documented offsets.
        bytes1[4] memory rtmrs = _fills(0xc0, 0xc1, 0xc2, 0xc3);
        dcap.set(true, bytes.concat(_output(0xa1, rtmrs, enclave, 3), new bytes(64)));

        (bool ok,, bytes memory reportData, uint8 tcbStatus) = adapter.verifyQuote(hex"1234");
        assertTrue(ok);
        assertEq(tcbStatus, 3);
        assertEq(address(bytes20(reportData)), enclave);
    }

    function test_IsTrusted() public view {
        assertTrue(adapter.isTrusted());
    }
}
