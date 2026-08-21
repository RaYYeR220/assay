// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Normalised view over an on-chain Intel DCAP quote verifier.
/// @dev Implementations do the real cryptographic work: walk the PCK certificate chain up to the
///      pinned Intel root, check the quoting-enclave report signature, then the attestation-key
///      signature over the TD report. This interface only fixes the shape of what comes back so the
///      registry does not have to care which verifier is wired in.
interface IQuoteAdapter {
    /// @param rawQuote the raw Intel TDX quote bytes
    /// @return ok true when the quote verified against the pinned Intel root of trust
    /// @return measurement identity of the software the enclave is running, as a single digest
    ///         over the trust domain measurement and every runtime measurement register
    /// @return reportData the 64 bytes the enclave bound into its own quote
    /// @return tcbStatus Intel TCB evaluation for the platform that produced the quote
    /// @dev Not marked `view`. A real verifier walks certificate chains and records that it did,
    ///      which costs gas and writes logs. Callers that only want to look can still `eth_call` it.
    function verifyQuote(bytes calldata rawQuote)
        external
        returns (bool ok, bytes32 measurement, bytes memory reportData, uint8 tcbStatus);
}
