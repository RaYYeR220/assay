// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {MockQuoteAdapter} from "./mocks/MockQuoteAdapter.sol";

/// @notice The registry decides which keys the oracle will listen to at all, so every way a key can
///         fail to be live has to be exercised: never attested, wrong image, wrong TCB, wrong
///         model, withdrawn, and simply too old.
contract AttestationRegistryTest is Test {
    MockQuoteAdapter internal adapter;
    AttestationRegistry internal registry;

    bytes32 internal constant MEASUREMENT = keccak256("assay.test.image.v1");
    bytes32 internal constant OTHER_MEASUREMENT = keccak256("assay.test.image.rogue");
    string internal constant MODEL_A = "vendor-a/model-alpha";
    string internal constant MODEL_B = "vendor-b/model-beta";
    bytes32 internal constant MODEL_A_HASH = keccak256(bytes(MODEL_A));
    bytes32 internal constant MODEL_B_HASH = keccak256(bytes(MODEL_B));

    address internal enclave = address(0xE0C1A5E);
    address internal stranger = address(0x5747A6E5);

    function setUp() public {
        vm.warp(1_800_000_000);
        adapter = new MockQuoteAdapter();
        registry = new AttestationRegistry(adapter, address(this));
        registry.setAllowedImage(MEASUREMENT, true);
    }

    function _register(address signer, string memory modelId) internal returns (address) {
        adapter.setAccepting(MEASUREMENT, signer, 0);
        return registry.registerSigner(hex"deadbeef", modelId);
    }

    function test_RegisterSigner_BindsSignerAndModel() public {
        address signer = _register(enclave, MODEL_A);
        assertEq(signer, enclave, "signer comes out of the verified report data");

        AttestationRegistry.Signer memory s = registry.signerInfo(enclave);
        assertTrue(s.known);
        assertFalse(s.revoked);
        assertEq(s.measurement, MEASUREMENT);
        assertEq(s.attestedAt, uint64(block.timestamp));
        assertEq(s.tcbStatus, 0);
        assertTrue(registry.servesModel(enclave, MODEL_A_HASH));

        (bool live, bool revoked, bool expired) = registry.status(enclave, MODEL_A_HASH);
        assertTrue(live);
        assertFalse(revoked);
        assertFalse(expired);
    }

    function test_RegisterSigner_RevertsWhenQuoteRejected() public {
        adapter.set(false, MEASUREMENT, adapter.reportDataFor(enclave), 0);
        vm.expectRevert(AttestationRegistry.QuoteRejected.selector);
        registry.registerSigner(hex"deadbeef", MODEL_A);
    }

    function test_RegisterSigner_RevertsWhenImageNotAllowed() public {
        adapter.setAccepting(OTHER_MEASUREMENT, enclave, 0);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.ImageNotAllowed.selector, OTHER_MEASUREMENT));
        registry.registerSigner(hex"deadbeef", MODEL_A);
    }

    function test_RegisterSigner_RevertsWhenTcbNotAllowed() public {
        adapter.setAccepting(MEASUREMENT, enclave, 3);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.TcbNotAllowed.selector, uint8(3)));
        registry.registerSigner(hex"deadbeef", MODEL_A);

        registry.setAllowedTcbStatus(3, true);
        assertEq(registry.registerSigner(hex"deadbeef", MODEL_A), enclave);
    }

    function test_RegisterSigner_RevertsWhenReportDataTooShort() public {
        adapter.set(true, MEASUREMENT, new bytes(19), 0);
        vm.expectRevert(AttestationRegistry.ReportDataTooShort.selector);
        registry.registerSigner(hex"deadbeef", MODEL_A);
    }

    function test_RegisterSigner_ReadsSignerAtConfiguredOffset() public {
        registry.setSignerOffset(12);
        adapter.set(true, MEASUREMENT, bytes.concat(new bytes(12), bytes20(enclave), new bytes(32)), 0);
        assertEq(registry.registerSigner(hex"deadbeef", MODEL_A), enclave);

        // The default layout no longer parses to the same address once the offset moved.
        adapter.setAccepting(MEASUREMENT, enclave, 0);
        assertTrue(registry.registerSigner(hex"deadbeef", MODEL_A) != enclave);
    }

    function test_Status_IsFalseForUnknownSigner() public view {
        (bool live, bool revoked, bool expired) = registry.status(stranger, MODEL_A_HASH);
        assertFalse(live);
        assertFalse(revoked);
        assertFalse(expired);
    }

    function test_Status_IsFalseAfterRevocation() public {
        _register(enclave, MODEL_A);
        registry.revoke(enclave);

        (bool live, bool revoked, bool expired) = registry.status(enclave, MODEL_A_HASH);
        assertFalse(live);
        assertTrue(revoked);
        assertFalse(expired);
    }

    function test_Status_IsFalseAfterTtlElapses() public {
        _register(enclave, MODEL_A);
        uint64 ttl = registry.attestationTtl();

        vm.warp(block.timestamp + ttl);
        (bool liveAtEdge,,) = registry.status(enclave, MODEL_A_HASH);
        assertTrue(liveAtEdge, "the last second of the window still counts");

        vm.warp(block.timestamp + 1);
        (bool live,, bool expired) = registry.status(enclave, MODEL_A_HASH);
        assertFalse(live);
        assertTrue(expired);
    }

    function test_Status_IsFalseForAnotherModel() public {
        _register(enclave, MODEL_A);

        (bool live, bool revoked, bool expired) = registry.status(enclave, MODEL_B_HASH);
        assertFalse(live, "an attested key answers only for the model it attested to");
        assertFalse(revoked);
        assertFalse(expired);
        assertFalse(registry.servesModel(enclave, MODEL_B_HASH));
    }

    function test_RegisterSigner_AddsModelsWithoutDroppingEarlierOnes() public {
        _register(enclave, MODEL_A);
        _register(enclave, MODEL_B);
        (bool liveA,,) = registry.status(enclave, MODEL_A_HASH);
        (bool liveB,,) = registry.status(enclave, MODEL_B_HASH);
        assertTrue(liveA);
        assertTrue(liveB);
    }

    /// @dev A quote is a static blob anyone can replay. If re-attesting cleared the revocation
    ///      flag, withdrawing a compromised key would be undone by resubmitting the very quote it
    ///      was withdrawn for, and `revoke` would be decorative.
    function test_Revoke_SurvivesQuoteReplay() public {
        _register(enclave, MODEL_A);
        registry.revoke(enclave);

        adapter.setAccepting(MEASUREMENT, enclave, 0);
        vm.expectRevert(abi.encodeWithSelector(AttestationRegistry.SignerIsRevoked.selector, enclave));
        registry.registerSigner(hex"deadbeef", MODEL_A);

        (bool live, bool revoked,) = registry.status(enclave, MODEL_A_HASH);
        assertFalse(live);
        assertTrue(revoked);
    }

    function test_Curation_IsOwnerOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(AttestationRegistry.NotOwner.selector);
        registry.setAllowedImage(MEASUREMENT, false);
        vm.expectRevert(AttestationRegistry.NotOwner.selector);
        registry.revoke(enclave);
        vm.expectRevert(AttestationRegistry.NotOwner.selector);
        registry.setAttestationTtl(1 days);
        vm.expectRevert(AttestationRegistry.NotOwner.selector);
        registry.setAdapter(adapter);
        vm.expectRevert(AttestationRegistry.NotOwner.selector);
        registry.setSignerOffset(4);
        vm.expectRevert(AttestationRegistry.NotOwner.selector);
        registry.transferOwnership(stranger);
        vm.stopPrank();

        // Registration itself stays permissionless: it is the quote that grants the right.
        vm.prank(stranger);
        assertEq(_register(enclave, MODEL_A), enclave);
    }

    function test_SetAttestationTtl_ShortensExistingWindows() public {
        _register(enclave, MODEL_A);
        vm.warp(block.timestamp + 2 days);
        (bool live,,) = registry.status(enclave, MODEL_A_HASH);
        assertTrue(live);

        registry.setAttestationTtl(1 days);
        (bool stillLive,, bool expired) = registry.status(enclave, MODEL_A_HASH);
        assertFalse(stillLive);
        assertTrue(expired);
    }
}
