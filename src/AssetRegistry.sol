// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AssetConfig} from "./Types.sol";
import {Ascii} from "./libraries/Ascii.sol";

/// @title AssetRegistry
/// @notice The listing surface: anyone can register an asset, choose its appraisal committee, and
///         set the policy under which a price for it may be published.
/// @dev This is what makes Assay a primitive rather than a single product. Two things live here.
///      First, prompt schemas: the exact byte fragments that get concatenated into the HTTP request
///      an enclave is asked to answer. Because the oracle rebuilds that request from these stored
///      fragments, the question put to the models is itself on chain and immutable, and no relayer
///      can quietly reword it. Second, per-asset policy: how many members must agree, how tightly,
///      how fresh the answer has to be, and what a challenge costs.
///
///      There is no owner and no privileged role. Schemas are content-addressed so an id cannot be
///      claimed by a body other than the one that hashes to it, and every other write is gated on
///      being the issuer of the asset in question.
contract AssetRegistry {
    using Ascii for bytes;

    /// @notice Byte fragments assembled as `head || modelId || mid || evidence || tail`.
    struct PromptSchema {
        bytes head;
        bytes mid;
        bytes tail;
        bool exists;
    }

    mapping(bytes32 schemaId => PromptSchema) internal _schemas;
    mapping(bytes32 assetId => AssetConfig) internal _configs;
    mapping(bytes32 assetId => string[]) internal _committee;
    mapping(bytes32 assetId => string) public metadataURI;

    /// @notice Evidence documents the issuer has committed to, keyed by their sha256 digest.
    /// @dev Mandatory, not optional, and that is the point. Posting a round is permissionless, so
    ///      if the poster also chose the evidence they would be choosing the facts the models see,
    ///      and the entire verification chain would rest on an input nothing checks. Anyone can
    ///      still run a round; they just cannot invent what it is about. Three roles, separated:
    ///      the issuer commits to what the evidence IS, the committee decides what it is WORTH,
    ///      and the chain checks both.
    mapping(bytes32 assetId => mapping(bytes32 evidenceHash => bool)) public evidenceAllowed;

    bytes32[] internal _assetIds;

    event SchemaRegistered(bytes32 indexed schemaId, uint256 headLen, uint256 midLen, uint256 tailLen);
    event AssetRegistered(bytes32 indexed assetId, address indexed issuer, bytes32 indexed schemaId);
    event AssetConfigured(bytes32 indexed assetId, AssetConfig config);
    event CommitteeSet(bytes32 indexed assetId, string[] models);
    event AssetActiveSet(bytes32 indexed assetId, bool active);
    event EvidenceCommitted(bytes32 indexed assetId, bytes32 indexed evidenceHash, string uri, bool allowed);

    error NotIssuer();
    error SchemaExists();
    error UnknownSchema();
    error AssetExists();
    error UnknownAsset();
    error BadConfig();
    error EmptyCommittee();

    modifier onlyIssuer(bytes32 assetId) {
        if (_configs[assetId].issuer != msg.sender) revert NotIssuer();
        _;
    }

    /// @notice Publish a reusable prompt schema. Permissionless, immutable, content-addressed.
    /// @return schemaId `keccak256(abi.encode(head, mid, tail))`
    /// @dev The id is derived from the fragments rather than chosen by the caller. That is what
    ///      makes it safe to let anyone register one: an id cannot be claimed by a different body,
    ///      so nobody can front-run a well-known schema id with a doctored prompt. Immutability
    ///      matters for the same reason an asset points at an id — otherwise the question behind
    ///      every historical price could be rewritten after the fact.
    function registerSchema(bytes calldata head, bytes calldata mid, bytes calldata tail)
        external
        returns (bytes32 schemaId)
    {
        schemaId = schemaIdOf(head, mid, tail);
        if (_schemas[schemaId].exists) revert SchemaExists();
        _schemas[schemaId] = PromptSchema({head: head, mid: mid, tail: tail, exists: true});
        emit SchemaRegistered(schemaId, head.length, mid.length, tail.length);
    }

    /// @notice The id a given set of prompt fragments will always have.
    function schemaIdOf(bytes memory head, bytes memory mid, bytes memory tail)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(head, mid, tail));
    }

    /// @notice List a new asset for appraisal.
    /// @param assetId caller-chosen identifier, conventionally keccak of the off-chain asset key
    /// @param cfg quorum, agreement band, freshness window, confidence floor and bond
    /// @param models the committee, one model id per slot, in fixed order
    function registerAsset(
        bytes32 assetId,
        AssetConfig calldata cfg,
        string[] calldata models,
        string calldata uri
    ) external {
        if (_configs[assetId].issuer != address(0)) revert AssetExists();
        if (!_schemas[cfg.schemaId].exists) revert UnknownSchema();
        if (models.length == 0 || models.length > 16) revert EmptyCommittee();
        _validate(cfg, models.length);

        AssetConfig memory c = cfg;
        c.issuer = msg.sender;
        c.active = true;
        _configs[assetId] = c;
        _setCommittee(assetId, models);
        metadataURI[assetId] = uri;
        _assetIds.push(assetId);

        emit AssetRegistered(assetId, msg.sender, cfg.schemaId);
        emit AssetConfigured(assetId, c);
        emit CommitteeSet(assetId, models);
    }

    /// @notice Update policy for an asset already listed. The schema and issuer cannot change.
    function configureAsset(bytes32 assetId, AssetConfig calldata cfg) external onlyIssuer(assetId) {
        AssetConfig storage stored = _configs[assetId];
        _validate(cfg, _committee[assetId].length);
        stored.quorum = cfg.quorum;
        stored.minDistinctSigners = cfg.minDistinctSigners;
        stored.bandBps = cfg.bandBps;
        stored.minConfidenceBps = cfg.minConfidenceBps;
        stored.maxAgeSec = cfg.maxAgeSec;
        stored.disputeBandBps = cfg.disputeBandBps;
        stored.disputeBond = cfg.disputeBond;
        emit AssetConfigured(assetId, stored);
    }

    function setCommittee(bytes32 assetId, string[] calldata models) external onlyIssuer(assetId) {
        if (models.length == 0 || models.length > 16) revert EmptyCommittee();
        _validate(_configs[assetId], models.length);
        _setCommittee(assetId, models);
        emit CommitteeSet(assetId, models);
    }

    /// @notice Commit to an evidence document ahead of any round that uses it.
    /// @param evidenceHash sha256 of the exact evidence bytes
    /// @param uri where the document can be fetched and checked against that digest
    function commitEvidence(bytes32 assetId, bytes32 evidenceHash, string calldata uri, bool allowed)
        external
        onlyIssuer(assetId)
    {
        evidenceAllowed[assetId][evidenceHash] = allowed;
        emit EvidenceCommitted(assetId, evidenceHash, uri, allowed);
    }

    function setActive(bytes32 assetId, bool active) external onlyIssuer(assetId) {
        _configs[assetId].active = active;
        emit AssetActiveSet(assetId, active);
    }

    function config(bytes32 assetId) external view returns (AssetConfig memory c) {
        c = _configs[assetId];
        if (c.issuer == address(0)) revert UnknownAsset();
    }

    function schema(bytes32 schemaId) external view returns (PromptSchema memory s) {
        s = _schemas[schemaId];
        if (!s.exists) revert UnknownSchema();
    }

    function committee(bytes32 assetId) external view returns (string[] memory) {
        return _committee[assetId];
    }

    function committeeSize(bytes32 assetId) external view returns (uint256) {
        return _committee[assetId].length;
    }

    function modelAt(bytes32 assetId, uint256 slot) external view returns (string memory) {
        return _committee[assetId][slot];
    }

    function assetCount() external view returns (uint256) {
        return _assetIds.length;
    }

    function assetAt(uint256 i) external view returns (bytes32) {
        return _assetIds[i];
    }

    /// @notice Rebuild the exact request bytes an enclave in `slot` must have been asked to answer.
    /// @dev The oracle hashes the return value of this function, never a caller-supplied request.
    function buildRequest(bytes32 assetId, uint256 slot, bytes memory evidence)
        external
        view
        returns (bytes memory)
    {
        PromptSchema storage s = _schemas[_configs[assetId].schemaId];
        return bytes.concat(s.head, bytes(_committee[assetId][slot]), s.mid, evidence, s.tail);
    }

    /// @dev Copied element by element: a calldata array of strings cannot be assigned to storage.
    function _setCommittee(bytes32 assetId, string[] calldata models) internal {
        string[] storage slots = _committee[assetId];
        while (slots.length > 0) {
            slots.pop();
        }
        for (uint256 i = 0; i < models.length; ++i) {
            slots.push(models[i]);
        }
    }

    function _validate(AssetConfig memory c, uint256 members) internal pure {
        if (c.quorum == 0 || c.quorum > members) revert BadConfig();
        if (c.minDistinctSigners > c.quorum) revert BadConfig();
        if (c.bandBps == 0 || c.bandBps > 5000) revert BadConfig();
        if (c.minConfidenceBps > 10_000) revert BadConfig();
        if (c.maxAgeSec == 0) revert BadConfig();
        if (c.disputeBandBps == 0 || c.disputeBandBps > 5000) revert BadConfig();
        // A zero bond makes challenging free, and a challenge freezes every consumer of the asset
        // until it is settled or lapses. Pricing it is what keeps that from being a free switch.
        if (c.disputeBond == 0) revert BadConfig();
    }
}
