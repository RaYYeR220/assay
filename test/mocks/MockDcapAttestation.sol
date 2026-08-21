// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IDcapAttestation} from "../../src/adapters/AutomataTdxAdapter.sol";

/// @notice Test double for the Automata on-chain Intel DCAP verifier deployed on X Layer.
/// @dev Returns whatever packed record the test sets, so the adapter's offset arithmetic can be
///      checked against a record with known bytes at every documented position. The real verifier
///      walks the PCK chain up to the Intel root; this one performs no cryptography at all.
contract MockDcapAttestation is IDcapAttestation {
    bool public success = true;
    bytes public output;
    uint32 public lastTcbEvaluationDataNumber;

    function set(bool success_, bytes memory output_) external {
        success = success_;
        output = output_;
    }

    function verifyAndAttestOnChain(bytes calldata, uint32 tcbEvaluationDataNumber)
        external
        payable
        returns (bool, bytes memory)
    {
        lastTcbEvaluationDataNumber = tcbEvaluationDataNumber;
        return (success, output);
    }
}
