// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQuoteAdapter} from "../interfaces/IQuoteAdapter.sol";

/// @notice The on-chain Intel DCAP verifier this adapter delegates to.
interface IDcapAttestation {
    /// @param rawQuote the raw Intel quote bytes
    /// @param tcbEvaluationDataNumber which Intel TCB evaluation the collateral was uploaded under
    /// @return success false when the quote did not verify
    /// @return output on success, a packed attestation record; on failure, a UTF-8 reason string
    function verifyAndAttestOnChain(bytes calldata rawQuote, uint32 tcbEvaluationDataNumber)
        external
        payable
        returns (bool success, bytes memory output);
}

/// @title AutomataTdxAdapter
/// @notice Verifies an Intel TDX quote through the DCAP verifier deployed on X Layer and hands back
///         the three fields the attestation registry cares about.
/// @dev The verifier returns a packed record rather than an ABI-encoded struct, so the fields are
///      read at fixed offsets. For a TDX v4 quote the record is 595 bytes:
///
///        [0:2]    quote version (4)
///        [2:4]    quote body type (2, meaning a TD 1.0 report)
///        [4:5]    TCB status
///        [5:11]   FMSPC
///        [11:595] the TD report body, copied verbatim out of the quote
///
///      Within that, `mrTd` sits at 147 and `report_data` at 531. A failed verification comes back
///      as `success == false` with a reason string in `output`, not as a revert, so the return value
///      has to be checked rather than assumed.
contract AutomataTdxAdapter is IQuoteAdapter {
    uint256 internal constant TDX_OUTPUT_LEN = 595;
    uint256 internal constant OFF_TCB_STATUS = 4;
    uint256 internal constant OFF_MRTD = 147;
    uint256 internal constant OFF_RTMR0 = 339;
    uint256 internal constant OFF_REPORT_DATA = 531;
    uint256 internal constant MEASUREMENT_LEN = 48;
    uint256 internal constant REPORT_DATA_LEN = 64;

    /// @notice The DCAP verifier on this chain.
    IDcapAttestation public immutable dcap;

    /// @notice Which Intel TCB evaluation the uploaded collateral corresponds to.
    /// @dev Pinned rather than resolved at call time. The collateral stores are keyed by this
    ///      number, so letting the verifier pick one could silently select an evaluation nothing was
    ///      uploaded for, and it costs extra gas to look up.
    uint32 public immutable tcbEvaluationDataNumber;

    /// @notice Emitted on every successful verification so the raw measurements stay auditable.
    /// @param measurement the digest the registry keys its allowlist on
    /// @param raw the trust domain measurement followed by all four runtime registers, 240 bytes
    event QuoteVerified(bytes32 indexed measurement, uint8 tcbStatus, bytes6 fmspc, bytes raw);

    error OutputTooShort(uint256 length);

    constructor(IDcapAttestation dcap_, uint32 tcbEvaluationDataNumber_) {
        dcap = dcap_;
        tcbEvaluationDataNumber = tcbEvaluationDataNumber_;
    }

    /// @notice Always true. This adapter performs real cryptographic verification.
    function isTrusted() external pure returns (bool) {
        return true;
    }

    /// @inheritdoc IQuoteAdapter
    function verifyQuote(bytes calldata rawQuote)
        external
        returns (bool ok, bytes32 measurement, bytes memory reportData, uint8 tcbStatus)
    {
        bytes memory output;
        (ok, output) = dcap.verifyAndAttestOnChain(rawQuote, tcbEvaluationDataNumber);
        if (!ok) return (false, bytes32(0), "", 0);
        if (output.length < TDX_OUTPUT_LEN) revert OutputTooShort(output.length);

        tcbStatus = uint8(output[OFF_TCB_STATUS]);

        // The trust domain measurement is 48 bytes, and on its own it only pins the base image.
        // Concatenating it with the four runtime measurement registers and hashing the result gives
        // one word that identifies the entire boot chain, including whatever was loaded into the
        // domain afterwards. Two enclaves running different software cannot collide on it.
        bytes memory raw = new bytes(MEASUREMENT_LEN * 5);
        _copy(raw, 0, output, OFF_MRTD, MEASUREMENT_LEN);
        for (uint256 i = 0; i < 4; ++i) {
            _copy(raw, MEASUREMENT_LEN * (i + 1), output, OFF_RTMR0 + MEASUREMENT_LEN * i, MEASUREMENT_LEN);
        }
        measurement = keccak256(raw);

        reportData = new bytes(REPORT_DATA_LEN);
        _copy(reportData, 0, output, OFF_REPORT_DATA, REPORT_DATA_LEN);

        bytes6 fmspc;
        assembly {
            fmspc := mload(add(add(output, 0x20), 5))
        }
        emit QuoteVerified(measurement, tcbStatus, fmspc, raw);
    }

    function _copy(bytes memory dst, uint256 dstOff, bytes memory src, uint256 srcOff, uint256 len)
        private
        pure
    {
        for (uint256 i = 0; i < len; ++i) {
            dst[dstOff + i] = src[srcOff + i];
        }
    }
}
