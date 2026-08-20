// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQuoteAdapter} from "../interfaces/IQuoteAdapter.sol";

/// @title UnverifiedQuoteAdapter
/// @notice A development stand-in that does NOT verify anything.
/// @dev Deliberately named so that it can never be mistaken for the real verifier on a block
///      explorer. It parrots back operator-supplied values and is only useful for exercising the
///      surrounding wiring on a throwaway network. {isTrusted} returns false so any user interface
///      or indexer can flag a deployment that is still pointing at it. Production deployments wire
///      {AttestationRegistry} to the on-chain Intel DCAP verifier instead.
contract UnverifiedQuoteAdapter is IQuoteAdapter {
    address public immutable operator;

    bytes32 public mrTd;
    bytes public reportData;
    uint8 public tcbStatus;
    bool public accept = true;

    event StandInConfigured(bytes32 mrTd, bytes reportData, uint8 tcbStatus, bool accept);

    error NotOperator();

    constructor(address operator_) {
        operator = operator_;
    }

    /// @notice Always false. This adapter provides no cryptographic assurance whatsoever.
    function isTrusted() external pure returns (bool) {
        return false;
    }

    function configure(bytes32 mrTd_, bytes calldata reportData_, uint8 tcbStatus_, bool accept_) external {
        if (msg.sender != operator) revert NotOperator();
        mrTd = mrTd_;
        reportData = reportData_;
        tcbStatus = tcbStatus_;
        accept = accept_;
        emit StandInConfigured(mrTd_, reportData_, tcbStatus_, accept_);
    }

    /// @inheritdoc IQuoteAdapter
    function verifyQuote(bytes calldata) external view returns (bool, bytes32, bytes memory, uint8) {
        return (accept, mrTd, reportData, tcbStatus);
    }
}
