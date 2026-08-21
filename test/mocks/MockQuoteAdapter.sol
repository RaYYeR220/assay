// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQuoteAdapter} from "../../src/interfaces/IQuoteAdapter.sol";

/// @notice Test double for the on-chain Intel DCAP verifier the registry talks to in production.
/// @dev Lets a test decide what a quote "verified" to, so attestation flows can be exercised
///      without a real TDX quote. The production wiring is an on-chain DCAP verifier behind
///      {IQuoteAdapter}; nothing here proves anything.
contract MockQuoteAdapter is IQuoteAdapter {
    /// @notice How many times the registry asked this adapter to verify something.
    uint256 public calls;

    bool public ok = true;
    bytes32 public measurement;
    bytes public reportData;
    uint8 public tcbStatus;

    function set(bool ok_, bytes32 measurement_, bytes memory reportData_, uint8 tcbStatus_) external {
        ok = ok_;
        measurement = measurement_;
        reportData = reportData_;
        tcbStatus = tcbStatus_;
    }

    /// @notice The real Phala report-data layout: the signer address, then 44 bytes of padding.
    function reportDataFor(address signer) public pure returns (bytes memory) {
        return bytes.concat(bytes20(signer), new bytes(44));
    }

    /// @notice Convenience for the common case: an accepted quote carrying `signer`.
    function setAccepting(bytes32 measurement_, address signer, uint8 tcbStatus_) external {
        ok = true;
        measurement = measurement_;
        reportData = reportDataFor(signer);
        tcbStatus = tcbStatus_;
    }

    /// @inheritdoc IQuoteAdapter
    function verifyQuote(bytes calldata) external returns (bool, bytes32, bytes memory, uint8) {
        ++calls;
        return (ok, measurement, reportData, tcbStatus);
    }
}
