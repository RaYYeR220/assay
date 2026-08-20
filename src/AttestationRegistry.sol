// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQuoteAdapter} from "./interfaces/IQuoteAdapter.sol";

/// @title AttestationRegistry
/// @notice Decides which keys the oracle is willing to listen to, and does it by verifying Intel
///         TDX attestations on chain rather than by trusting an operator.
/// @dev A confidential-inference enclave derives a secp256k1 key, binds that address into the
///      `report_data` field of its own TDX quote, and signs every answer it produces with it.
///      `registerSigner` re-verifies that quote through {IQuoteAdapter} and reads the address back
///      out of the verified report data. Nobody, including the owner of this contract, gets to name
///      a signer directly: the address is a consequence of a quote that the Intel root of trust
///      vouches for. Registrations expire, so an operator has to keep proving the enclave is alive.
contract AttestationRegistry {
    struct Signer {
        bytes32 mrTd;
        uint64 attestedAt;
        uint8 tcbStatus;
        bool revoked;
        bool known;
    }

    /// @notice Verifier used to check raw quotes.
    IQuoteAdapter public adapter;

    /// @notice Address allowed to curate measurements, TCB policy and revocations.
    address public owner;

    /// @notice How long a single attestation stays valid before the enclave must re-attest.
    uint64 public attestationTtl = 7 days;

    /// @notice Byte offset of the signer address inside the 64-byte report data.
    uint8 public signerOffset;

    /// @notice Measurements the registry accepts, i.e. approved enclave images.
    mapping(bytes32 mrTd => bool) public allowedImage;

    /// @notice Intel TCB statuses the registry tolerates (0 is normally UpToDate).
    mapping(uint8 tcbStatus => bool) public allowedTcbStatus;

    mapping(address signer => Signer) internal _signers;

    /// @notice Which models a given attested key is allowed to answer for.
    mapping(address signer => mapping(bytes32 modelIdHash => bool)) public servesModel;

    event AdapterSet(address indexed adapter);
    event OwnerSet(address indexed owner);
    event ImageAllowed(bytes32 indexed mrTd, bool allowed);
    event TcbStatusAllowed(uint8 indexed status, bool allowed);
    event AttestationTtlSet(uint64 ttl);
    event SignerAttested(
        address indexed signer, bytes32 indexed mrTd, bytes32 indexed modelIdHash, uint8 tcbStatus
    );
    event SignerRevoked(address indexed signer);

    error NotOwner();
    error QuoteRejected();
    error ImageNotAllowed(bytes32 mrTd);
    error TcbNotAllowed(uint8 status);
    error ReportDataTooShort();
    error SignerIsRevoked(address signer);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IQuoteAdapter adapter_, address owner_) {
        adapter = adapter_;
        owner = owner_;
        allowedTcbStatus[0] = true;
        emit AdapterSet(address(adapter_));
        emit OwnerSet(owner_);
        emit TcbStatusAllowed(0, true);
    }

    /// @notice Verify a TDX quote on chain and bind the key it carries to a model.
    /// @param rawQuote the enclave quote, exactly as the attestation endpoint served it
    /// @param modelId the model this enclave answers for, e.g. deepseek/deepseek-v4-flash-0731
    /// @return signer the attested address, read out of the verified report data
    /// @dev Anyone may call this. There is no privileged path that skips verification, which is the
    ///      point: registry contents derive from the Intel root of trust, not from an assertion.
    function registerSigner(bytes calldata rawQuote, string calldata modelId)
        external
        returns (address signer)
    {
        (bool ok, bytes32 mrTd, bytes memory reportData, uint8 tcbStatus) =
            adapter.verifyQuote(rawQuote);
        if (!ok) revert QuoteRejected();
        if (!allowedImage[mrTd]) revert ImageNotAllowed(mrTd);
        if (!allowedTcbStatus[tcbStatus]) revert TcbNotAllowed(tcbStatus);

        signer = _readSigner(reportData);

        Signer storage s = _signers[signer];
        // Revocation has to survive re-attestation. A quote is a static blob that anyone can
        // replay, so clearing the flag here would let whoever holds a withdrawn key reinstate it
        // by re-submitting the very quote it was withdrawn for. A revoked enclave derives a new
        // key instead.
        if (s.revoked) revert SignerIsRevoked(signer);
        s.mrTd = mrTd;
        s.attestedAt = uint64(block.timestamp);
        s.tcbStatus = tcbStatus;
        s.known = true;

        bytes32 modelIdHash = keccak256(bytes(modelId));
        servesModel[signer][modelIdHash] = true;

        emit SignerAttested(signer, mrTd, modelIdHash, tcbStatus);
    }

    /// @notice Whether `signer` currently counts as a live attested enclave key for `modelIdHash`.
    /// @return live true only if attested, unrevoked, unexpired and bound to that model
    /// @return revoked true when the key was explicitly withdrawn
    /// @return expired true when the attestation aged out
    function status(address signer, bytes32 modelIdHash)
        external
        view
        returns (bool live, bool revoked, bool expired)
    {
        Signer memory s = _signers[signer];
        if (!s.known) return (false, false, false);
        revoked = s.revoked;
        expired = block.timestamp > uint256(s.attestedAt) + attestationTtl;
        live = !revoked && !expired && servesModel[signer][modelIdHash];
    }

    function signerInfo(address signer) external view returns (Signer memory) {
        return _signers[signer];
    }

    /// @notice Withdraw a key permanently. Re-attesting the same key afterwards reverts.
    function revoke(address signer) external onlyOwner {
        _signers[signer].revoked = true;
        emit SignerRevoked(signer);
    }

    function setAllowedImage(bytes32 mrTd, bool allowed) external onlyOwner {
        allowedImage[mrTd] = allowed;
        emit ImageAllowed(mrTd, allowed);
    }

    function setAllowedTcbStatus(uint8 tcbStatus, bool allowed) external onlyOwner {
        allowedTcbStatus[tcbStatus] = allowed;
        emit TcbStatusAllowed(tcbStatus, allowed);
    }

    function setAttestationTtl(uint64 ttl) external onlyOwner {
        attestationTtl = ttl;
        emit AttestationTtlSet(ttl);
    }

    function setAdapter(IQuoteAdapter adapter_) external onlyOwner {
        adapter = adapter_;
        emit AdapterSet(address(adapter_));
    }

    function setSignerOffset(uint8 offset) external onlyOwner {
        signerOffset = offset;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
        emit OwnerSet(newOwner);
    }

    function _readSigner(bytes memory reportData) internal view returns (address signer) {
        uint256 off = signerOffset;
        if (reportData.length < off + 20) revert ReportDataTooShort();
        uint256 word;
        assembly {
            word := mload(add(add(reportData, 0x20), off))
        }
        signer = address(uint160(word >> 96));
    }
}
