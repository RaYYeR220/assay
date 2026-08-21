// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @notice Decoded form of the bytes blob returned by
 *         `AutomataDcapAttestationFee.verifyAndAttestOnChain(...)` for a TDX (v4) quote.
 */
struct TdxAttestationOutput {
    uint16 quoteVersion; // 4
    uint16 quoteBodyType; // 1 = SGX enclave report, 2 = TD1.0 report, 3 = TD1.5 report
    uint8 tcbStatus; // see TCB_STATUS_* below
    bytes6 fmspc;
    bytes16 teeTcbSvn;
    bytes mrSeam; // 48
    bytes mrSignerSeam; // 48
    bytes8 tdAttributes;
    bytes8 xFAM;
    bytes mrTd; // 48
    bytes mrConfigId; // 48
    bytes mrOwner; // 48
    bytes mrOwnerConfig; // 48
    bytes rtMr0; // 48
    bytes rtMr1; // 48
    bytes rtMr2; // 48
    bytes rtMr3; // 48
    bytes reportData; // 64
}

/**
 * @title DcapOutput
 * @notice Decoder for Automata's `serializeOutput()` packing.
 *
 * Wire format (abi.encodePacked, big-endian ints):
 *   [0  :2  ] uint16 quoteVersion
 *   [2  :4  ] uint16 quoteBodyType
 *   [4  :5  ] uint8  tcbStatus
 *   [5  :11 ] bytes6 fmspc
 *   [11 :11+N] quoteBody  (N = 584 for TD1.0, 648 for TD1.5, 384 for SGX)
 *   [11+N:  ] abi.encode(string[] advisoryIDs)   -- omitted entirely when empty
 *
 * TD1.0 report body offsets (relative to the start of quoteBody, i.e. +11 absolute):
 *   teeTcbSvn      0   (16)
 *   mrSeam        16   (48)
 *   mrSignerSeam  64   (48)
 *   seamAttributes 112 (8)
 *   tdAttributes  120  (8)
 *   xFAM          128  (8)
 *   mrTd          136  (48)
 *   mrConfigId    184  (48)
 *   mrOwner       232  (48)
 *   mrOwnerConfig 280  (48)
 *   rtMr0         328  (48)
 *   rtMr1         376  (48)
 *   rtMr2         424  (48)
 *   rtMr3         472  (48)
 *   reportData    520  (64)
 */
library DcapOutput {
    uint256 internal constant HEADER_LEN = 11;
    uint256 internal constant TD10_BODY_LEN = 584;
    uint256 internal constant TD15_BODY_LEN = 648;

    // absolute offsets into the output blob for a TD1.0 body
    uint256 internal constant OFF_TEE_TCB_SVN = 11;
    uint256 internal constant OFF_MRSEAM = 27;
    uint256 internal constant OFF_MRSIGNERSEAM = 75;
    uint256 internal constant OFF_SEAM_ATTRIBUTES = 123;
    uint256 internal constant OFF_TD_ATTRIBUTES = 131;
    uint256 internal constant OFF_XFAM = 139;
    uint256 internal constant OFF_MRTD = 147;
    uint256 internal constant OFF_MRCONFIGID = 195;
    uint256 internal constant OFF_MROWNER = 243;
    uint256 internal constant OFF_MROWNERCONFIG = 291;
    uint256 internal constant OFF_RTMR0 = 339;
    uint256 internal constant OFF_RTMR1 = 387;
    uint256 internal constant OFF_RTMR2 = 435;
    uint256 internal constant OFF_RTMR3 = 483;
    uint256 internal constant OFF_REPORT_DATA = 531;

    uint8 internal constant TCB_STATUS_OK = 0;
    uint8 internal constant TCB_STATUS_SW_HARDENING_NEEDED = 1;
    uint8 internal constant TCB_STATUS_CONFIG_AND_SW_HARDENING_NEEDED = 2;
    uint8 internal constant TCB_STATUS_CONFIG_NEEDED = 3;
    uint8 internal constant TCB_STATUS_OUT_OF_DATE = 4;
    uint8 internal constant TCB_STATUS_OUT_OF_DATE_CONFIG_NEEDED = 5;
    uint8 internal constant TCB_STATUS_REVOKED = 6;
    uint8 internal constant TCB_STATUS_UNRECOGNIZED = 7;

    error NotATdxOutput(uint16 quoteVersion, uint16 quoteBodyType);
    error OutputTooShort(uint256 length);

    /// @dev Cheapest useful read: the 20 bytes of reportData that Phala/dstack fills
    ///      with the workload's signing address.
    function signingAddress(bytes calldata output) internal pure returns (address) {
        if (output.length < OFF_REPORT_DATA + 64) revert OutputTooShort(output.length);
        return address(bytes20(output[OFF_REPORT_DATA:OFF_REPORT_DATA + 20]));
    }

    function tcbStatus(bytes calldata output) internal pure returns (uint8) {
        if (output.length < HEADER_LEN) revert OutputTooShort(output.length);
        return uint8(output[4]);
    }

    function fmspc(bytes calldata output) internal pure returns (bytes6) {
        if (output.length < HEADER_LEN) revert OutputTooShort(output.length);
        return bytes6(output[5:11]);
    }

    function mrTd(bytes calldata output) internal pure returns (bytes memory) {
        return output[OFF_MRTD:OFF_MRTD + 48];
    }

    function rtMr(bytes calldata output, uint256 i) internal pure returns (bytes memory) {
        uint256 off = OFF_RTMR0 + 48 * i;
        return output[off:off + 48];
    }

    function reportData(bytes calldata output) internal pure returns (bytes memory) {
        return output[OFF_REPORT_DATA:OFF_REPORT_DATA + 64];
    }

    /// @notice Full decode. Reverts unless the blob is a TDX TD1.0 report.
    function parseTdx(bytes calldata output) internal pure returns (TdxAttestationOutput memory o) {
        if (output.length < HEADER_LEN + TD10_BODY_LEN) revert OutputTooShort(output.length);

        o.quoteVersion = uint16(bytes2(output[0:2]));
        o.quoteBodyType = uint16(bytes2(output[2:4]));
        if (o.quoteBodyType != 2 && o.quoteBodyType != 3) {
            revert NotATdxOutput(o.quoteVersion, o.quoteBodyType);
        }
        o.tcbStatus = uint8(output[4]);
        o.fmspc = bytes6(output[5:11]);

        o.teeTcbSvn = bytes16(output[OFF_TEE_TCB_SVN:OFF_TEE_TCB_SVN + 16]);
        o.mrSeam = output[OFF_MRSEAM:OFF_MRSEAM + 48];
        o.mrSignerSeam = output[OFF_MRSIGNERSEAM:OFF_MRSIGNERSEAM + 48];
        o.tdAttributes = bytes8(output[OFF_TD_ATTRIBUTES:OFF_TD_ATTRIBUTES + 8]);
        o.xFAM = bytes8(output[OFF_XFAM:OFF_XFAM + 8]);
        o.mrTd = output[OFF_MRTD:OFF_MRTD + 48];
        o.mrConfigId = output[OFF_MRCONFIGID:OFF_MRCONFIGID + 48];
        o.mrOwner = output[OFF_MROWNER:OFF_MROWNER + 48];
        o.mrOwnerConfig = output[OFF_MROWNERCONFIG:OFF_MROWNERCONFIG + 48];
        o.rtMr0 = output[OFF_RTMR0:OFF_RTMR0 + 48];
        o.rtMr1 = output[OFF_RTMR1:OFF_RTMR1 + 48];
        o.rtMr2 = output[OFF_RTMR2:OFF_RTMR2 + 48];
        o.rtMr3 = output[OFF_RTMR3:OFF_RTMR3 + 48];
        o.reportData = output[OFF_REPORT_DATA:OFF_REPORT_DATA + 64];
    }

    /// @notice `advisoryIDs` are appended as abi.encode(string[]) when the matching TCB
    ///         level carries any; absent otherwise.
    function advisoryIDs(bytes calldata output) internal pure returns (string[] memory ids) {
        uint256 bodyLen = uint16(bytes2(output[2:4])) == 3 ? TD15_BODY_LEN : TD10_BODY_LEN;
        uint256 tail = HEADER_LEN + bodyLen;
        if (output.length <= tail) return new string[](0);
        ids = abi.decode(output[tail:], (string[]));
    }
}
