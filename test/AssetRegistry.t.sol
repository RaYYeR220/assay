// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {AssetConfig} from "../src/Types.sol";

/// @notice The registry fixes the question the committee is asked and the policy a price must meet.
///         Both have to be exactly reproducible, so the request bytes are asserted against a
///         concatenation written out by hand rather than against the function's own output shape.
contract AssetRegistryTest is Test {
    AssetRegistry internal assets;

    bytes internal constant HEAD = '{"model":"';
    bytes internal constant MID = '","messages":[{"role":"user","content":"EVIDENCE: ';
    bytes internal constant TAIL = '"}]}';

    bytes32 internal schemaId;
    bytes32 internal constant ASSET = keccak256("asset.one");
    address internal issuer = address(0x155);
    address internal stranger = address(0x5747);

    function setUp() public {
        assets = new AssetRegistry();
        schemaId = assets.registerSchema(HEAD, MID, TAIL);
    }

    function _models(uint256 n) internal pure returns (string[] memory m) {
        m = new string[](n);
        for (uint256 i = 0; i < n; ++i) {
            m[i] = string.concat("vendor/model-", vm.toString(i));
        }
    }

    function _cfg() internal view returns (AssetConfig memory) {
        return AssetConfig({
            issuer: address(0),
            quorum: 3,
            minDistinctSigners: 2,
            bandBps: 500,
            minConfidenceBps: 5000,
            maxAgeSec: 3600,
            disputeBandBps: 500,
            disputeBond: 0.01 ether,
            schemaId: schemaId,
            active: true,
            requireAllowedEvidence: false
        });
    }

    function _register(AssetConfig memory cfg, uint256 members) internal {
        vm.prank(issuer);
        assets.registerAsset(ASSET, cfg, _models(members), "ipfs://asset");
    }

    function _expectBadConfig(AssetConfig memory cfg) internal {
        vm.prank(issuer);
        vm.expectRevert(AssetRegistry.BadConfig.selector);
        assets.registerAsset(keccak256(abi.encode(cfg)), cfg, _models(5), "ipfs://asset");
    }

    // -----------------------------------------------------------------------------------
    // Schemas
    // -----------------------------------------------------------------------------------

    function test_SchemaId_IsContentAddressed() public view {
        assertEq(schemaId, assets.schemaIdOf(HEAD, MID, TAIL));
        assertEq(schemaId, keccak256(abi.encode(HEAD, MID, TAIL)));

        AssetRegistry.PromptSchema memory s = assets.schema(schemaId);
        assertEq(s.head, HEAD);
        assertEq(s.mid, MID);
        assertEq(s.tail, TAIL);
        assertTrue(s.exists);
    }

    function test_RegisterSchema_RevertsOnDuplicateFragments() public {
        vm.expectRevert(AssetRegistry.SchemaExists.selector);
        assets.registerSchema(HEAD, MID, TAIL);
    }

    function test_RegisterSchema_DifferentFragmentsGetDifferentIds() public {
        bytes32 other = assets.registerSchema(HEAD, MID, '"}],"stream":false}');
        assertTrue(other != schemaId);
        assertEq(other, assets.schemaIdOf(HEAD, MID, '"}],"stream":false}'));

        // The split between fragments is part of the identity, not just their concatenation.
        bytes32 shifted = assets.registerSchema('{"model":', '""," ,"messages":[{"role":"user","content":"EVIDENCE: ', TAIL);
        assertTrue(shifted != schemaId);
    }

    function test_Schema_RevertsForUnregisteredId() public {
        vm.expectRevert(AssetRegistry.UnknownSchema.selector);
        assets.schema(keccak256("never registered"));
    }

    function test_RegisterAsset_RevertsForUnknownSchema() public {
        AssetConfig memory cfg = _cfg();
        cfg.schemaId = keccak256("never registered");
        vm.prank(issuer);
        vm.expectRevert(AssetRegistry.UnknownSchema.selector);
        assets.registerAsset(ASSET, cfg, _models(3), "ipfs://asset");
    }

    // -----------------------------------------------------------------------------------
    // Listing and policy
    // -----------------------------------------------------------------------------------

    function test_RegisterAsset_StoresPolicyAndForcesIssuer() public {
        AssetConfig memory cfg = _cfg();
        cfg.issuer = stranger; // ignored: the caller is the issuer
        cfg.active = false; // ignored: a listing starts active
        _register(cfg, 3);

        AssetConfig memory stored = assets.config(ASSET);
        assertEq(stored.issuer, issuer);
        assertTrue(stored.active);
        assertEq(stored.quorum, 3);
        assertEq(stored.bandBps, 500);
        assertEq(assets.committeeSize(ASSET), 3);
        assertEq(assets.assetCount(), 1);
        assertEq(assets.assetAt(0), ASSET);
        assertEq(assets.metadataURI(ASSET), "ipfs://asset");
    }

    function test_RegisterAsset_RevertsOnDuplicate() public {
        _register(_cfg(), 3);
        vm.prank(issuer);
        vm.expectRevert(AssetRegistry.AssetExists.selector);
        assets.registerAsset(ASSET, _cfg(), _models(3), "ipfs://asset");
    }

    function test_RegisterAsset_RevertsOnEmptyOrOversizedCommittee() public {
        vm.prank(issuer);
        vm.expectRevert(AssetRegistry.EmptyCommittee.selector);
        assets.registerAsset(ASSET, _cfg(), _models(0), "ipfs://asset");

        vm.prank(issuer);
        vm.expectRevert(AssetRegistry.EmptyCommittee.selector);
        assets.registerAsset(ASSET, _cfg(), _models(17), "ipfs://asset");
    }

    function test_RegisterAsset_RevertsOnBadConfig() public {
        AssetConfig memory cfg = _cfg();

        cfg = _cfg();
        cfg.quorum = 0;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.quorum = 6; // committee is 5
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.minDistinctSigners = 4;
        cfg.quorum = 3;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.bandBps = 0;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.bandBps = 5001;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.minConfidenceBps = 10_001;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.maxAgeSec = 0;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.disputeBandBps = 0;
        _expectBadConfig(cfg);

        cfg = _cfg();
        cfg.disputeBandBps = 5001;
        _expectBadConfig(cfg);

        // A free challenge is a free freeze: every consumer of the asset stops until it settles.
        cfg = _cfg();
        cfg.disputeBond = 0;
        _expectBadConfig(cfg);
    }

    function test_ConfigureAsset_IsIssuerOnly() public {
        _register(_cfg(), 3);
        AssetConfig memory cfg = _cfg();
        cfg.bandBps = 100;

        vm.prank(stranger);
        vm.expectRevert(AssetRegistry.NotIssuer.selector);
        assets.configureAsset(ASSET, cfg);

        vm.prank(issuer);
        assets.configureAsset(ASSET, cfg);
        assertEq(assets.config(ASSET).bandBps, 100);
    }

    function test_ConfigureAsset_CannotChangeIssuerSchemaOrActive() public {
        _register(_cfg(), 3);
        AssetConfig memory cfg = _cfg();
        cfg.issuer = stranger;
        cfg.schemaId = keccak256("something else");
        cfg.active = false;

        vm.prank(issuer);
        assets.configureAsset(ASSET, cfg);

        AssetConfig memory stored = assets.config(ASSET);
        assertEq(stored.issuer, issuer);
        assertEq(stored.schemaId, schemaId);
        assertTrue(stored.active);
    }

    function test_ConfigureAsset_TogglesEvidenceCommitment() public {
        _register(_cfg(), 3);
        assertFalse(assets.config(ASSET).requireAllowedEvidence);

        AssetConfig memory cfg = _cfg();
        cfg.requireAllowedEvidence = true;
        vm.prank(issuer);
        assets.configureAsset(ASSET, cfg);
        assertTrue(assets.config(ASSET).requireAllowedEvidence);

        cfg.requireAllowedEvidence = false;
        vm.prank(issuer);
        assets.configureAsset(ASSET, cfg);
        assertFalse(assets.config(ASSET).requireAllowedEvidence);
    }

    function test_SetActive_IsIssuerOnly() public {
        _register(_cfg(), 3);
        vm.prank(stranger);
        vm.expectRevert(AssetRegistry.NotIssuer.selector);
        assets.setActive(ASSET, false);

        vm.prank(issuer);
        assets.setActive(ASSET, false);
        assertFalse(assets.config(ASSET).active);
    }

    function test_CommitEvidence_IsIssuerOnly() public {
        _register(_cfg(), 3);
        bytes32 h = sha256("evidence bytes");

        vm.prank(stranger);
        vm.expectRevert(AssetRegistry.NotIssuer.selector);
        assets.commitEvidence(ASSET, h, "ipfs://ev", true);

        vm.prank(issuer);
        assets.commitEvidence(ASSET, h, "ipfs://ev", true);
        assertTrue(assets.evidenceAllowed(ASSET, h));

        vm.prank(issuer);
        assets.commitEvidence(ASSET, h, "ipfs://ev", false);
        assertFalse(assets.evidenceAllowed(ASSET, h));
    }

    function test_Config_RevertsForUnknownAsset() public {
        vm.expectRevert(AssetRegistry.UnknownAsset.selector);
        assets.config(keccak256("nothing here"));
    }

    // -----------------------------------------------------------------------------------
    // Committee
    // -----------------------------------------------------------------------------------

    function test_SetCommittee_ShrinksCleanly() public {
        _register(_cfg(), 5);
        assertEq(assets.committeeSize(ASSET), 5);

        vm.prank(issuer);
        assets.setCommittee(ASSET, _models(3));

        assertEq(assets.committeeSize(ASSET), 3);
        string[] memory c = assets.committee(ASSET);
        assertEq(c.length, 3);
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(c[i], string.concat("vendor/model-", vm.toString(i)));
            assertEq(assets.modelAt(ASSET, i), c[i]);
        }

        vm.expectRevert();
        assets.modelAt(ASSET, 3);
    }

    function test_SetCommittee_RefusesToShrinkBelowQuorum() public {
        _register(_cfg(), 5); // quorum 3
        vm.prank(issuer);
        vm.expectRevert(AssetRegistry.BadConfig.selector);
        assets.setCommittee(ASSET, _models(2));
    }

    function test_SetCommittee_IsIssuerOnly() public {
        _register(_cfg(), 5);
        vm.prank(stranger);
        vm.expectRevert(AssetRegistry.NotIssuer.selector);
        assets.setCommittee(ASSET, _models(3));
    }

    // -----------------------------------------------------------------------------------
    // Request rebuilding
    // -----------------------------------------------------------------------------------

    function test_BuildRequest_IsExactlyHeadModelMidEvidenceTail() public {
        _register(_cfg(), 3);
        bytes memory ev = "asset_id=carbon-001;credits=1000";

        for (uint256 slot = 0; slot < 3; ++slot) {
            bytes memory expected =
                bytes.concat(HEAD, bytes(assets.modelAt(ASSET, slot)), MID, ev, TAIL);
            assertEq(assets.buildRequest(ASSET, slot, ev), expected);
        }

        // Written out once by hand as well, so the assertion above cannot be satisfied by a
        // concatenation that merely agrees with itself.
        bytes memory literal = bytes(
            '{"model":"vendor/model-0","messages":[{"role":"user","content":"EVIDENCE: '
            'asset_id=carbon-001;credits=1000"}]}'
        );
        assertEq(assets.buildRequest(ASSET, 0, ev), literal);
    }

    function test_BuildRequest_ChangesWithSlotAndEvidence() public {
        _register(_cfg(), 3);
        bytes memory a = assets.buildRequest(ASSET, 0, "e");
        bytes memory b = assets.buildRequest(ASSET, 1, "e");
        bytes memory c = assets.buildRequest(ASSET, 0, "f");
        assertTrue(keccak256(a) != keccak256(b));
        assertTrue(keccak256(a) != keccak256(c));
    }
}
