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
    /// @return mrTd measurement of the trust domain (the image the enclave is running)
    /// @return reportData the 64 bytes the enclave bound into its own quote
    /// @return tcbStatus Intel TCB evaluation for the platform that produced the quote
    function verifyQuote(bytes calldata rawQuote)
        external
        view
        returns (bool ok, bytes32 mrTd, bytes memory reportData, uint8 tcbStatus);
}
