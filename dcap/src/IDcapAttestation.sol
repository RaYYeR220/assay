// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IDcapAttestation
 * @notice The exact surface of the deployed `AutomataDcapAttestationFee` that a
 *         consumer (e.g. AttestationRegistry) needs. Import this instead of
 *         pulling in the whole Automata repo.
 *
 * Usage:
 *   (bool ok, bytes memory out) = dcap.verifyAndAttestOnChain(rawQuote, 20);
 *   require(ok, string(out));                 // on failure `out` IS the reason string
 *   address signer = DcapOutput.signingAddress(out);
 *
 * NOTE: these are `payable` and non-view (they emit `AttestationSubmitted`), but the
 * verification itself is pure computation over on-chain PCCS state, so `eth_call`
 * works fine for a read-only check. `msg.value` may be 0 while the fee bp is 0.
 */
interface IDcapAttestation {
    /// @param rawQuote raw Intel DCAP quote bytes (TDX v4 = 5006 bytes for Phala dstack)
    /// @return success false when verification failed
    /// @return output  on success: the serialized VerifiedOutput (see DcapOutput.sol);
    ///                 on failure: a UTF-8 reason string
    function verifyAndAttestOnChain(bytes calldata rawQuote)
        external
        payable
        returns (bool success, bytes memory output);

    /// @param tcbEvaluationDataNumber pin the Intel TCB evaluation data number
    ///        (0 = resolve the "standard" one via TcbEvalDao)
    function verifyAndAttestOnChain(bytes calldata rawQuote, uint32 tcbEvaluationDataNumber)
        external
        payable
        returns (bool success, bytes memory output);

    /// @notice fee in basis points of the transaction cost; 0 on our deployment
    function getBp() external view returns (uint16);

    function quoteVerifiers(uint16 quoteVersion) external view returns (address);

    event AttestationSubmitted(bool success, uint8 verifierType, bytes output);
}
