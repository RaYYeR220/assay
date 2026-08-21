// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetConfig, HaltReason, NavState, Verdict} from "../src/Types.sol";
import {ValueRejector} from "./mocks/ValueRejector.sol";

/// @notice A price nobody can argue with is just a different kind of trusted feed. These cover both
///         halves of that: a challenge bites the moment it is opened, and it costs the challenger
///         something to be wrong. Balances are asserted, not just states.
contract DisputeTest is Fixtures {
    address internal challenger;
    uint256 internal constant BOND = 0.01 ether;

    function setUp() public override {
        super.setUp();
        challenger = makeAddr("challenger");
        vm.deal(challenger, 1 ether);
    }

    function _open() internal {
        publish(1_000_000);
        vm.prank(challenger);
        oracle.challenge{value: BOND}(assetId);
        vm.warp(block.timestamp + 60);
    }

    function _freshRound(uint256 nav) internal view returns (Verdict[] memory) {
        return roundFor(assetId, navList(nav, nav, nav));
    }

    /// @dev Bonds are credited rather than sent, so the assertion is that the credit exists and
    ///      that claiming it actually moves the ether.
    function _assertPaid(address who, uint256 amount) internal {
        assertEq(oracle.pendingWithdrawals(who), amount, "bond credited");
        uint256 before = who.balance;
        vm.prank(who);
        assertEq(oracle.withdraw(), amount);
        assertEq(who.balance, before + amount, "bond withdrawn");
        assertEq(oracle.pendingWithdrawals(who), 0);
    }

    // -----------------------------------------------------------------------------------
    // Opening
    // -----------------------------------------------------------------------------------

    function test_Challenge_StopsConsumersImmediately() public {
        publish(1_000_000);

        vm.expectEmit(true, true, true, true, address(oracle));
        emit AssayOracle.Challenged(assetId, 1, challenger, BOND);
        vm.prank(challenger);
        oracle.challenge{value: BOND}(assetId);

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Disputed));
        assertEq(address(oracle).balance, BOND, "the bond is held by the oracle, not the issuer");
        assertEq(challenger.balance, 1 ether - BOND);

        (address who, uint96 bond, uint32 epoch,, bool open) = oracle.disputes(assetId);
        assertEq(who, challenger);
        assertEq(bond, BOND);
        assertEq(epoch, 1);
        assertTrue(open);

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NavDisputed.selector, assetId));
        oracle.requireFreshNav(assetId);
        (, bool usable) = oracle.peekNav(assetId);
        assertFalse(usable);
    }

    function test_Challenge_RevertsWhenBondIsTooSmall() public {
        publish(1_000_000);
        vm.prank(challenger);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.BondTooSmall.selector, BOND - 1, BOND));
        oracle.challenge{value: BOND - 1}(assetId);
    }

    function test_Challenge_RevertsWhenThereIsNothingLive() public {
        vm.prank(challenger);
        vm.expectRevert(AssayOracle.NothingToChallenge.selector);
        oracle.challenge{value: BOND}(assetId);
    }

    function test_Challenge_RevertsWhenOneIsAlreadyOpen() public {
        publish(1_000_000);
        vm.prank(challenger);
        oracle.challenge{value: BOND}(assetId);

        vm.prank(challenger);
        vm.expectRevert(AssayOracle.DisputeAlreadyOpen.selector);
        oracle.challenge{value: BOND}(assetId);
    }

    /// @dev A challenge that could be stepped over by posting another round would not bite at all.
    function test_PostAppraisal_CannotStepOverAnOpenDispute() public {
        _open();
        Verdict[] memory vs = _freshRound(1_000_000);

        vm.expectRevert(AssayOracle.DisputeAlreadyOpen.selector);
        post(vs);
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Disputed));
    }

    // -----------------------------------------------------------------------------------
    // Resolving
    // -----------------------------------------------------------------------------------

    function test_ResolveDispute_ConfirmedValuationPaysTheBondToTheIssuer() public {
        _open();
        uint256 challengerBefore = challenger.balance;

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.DisputeResolved(assetId, 2, false, 1_020_000);
        assertFalse(oracle.resolveDispute(assetId, evidence, _freshRound(1_020_000)));

        assertEq(oracle.pendingWithdrawals(challenger), 0, "a wrong challenger gets nothing back");
        _assertPaid(issuer, BOND);
        assertEq(challenger.balance, challengerBefore);
        assertEq(address(oracle).balance, 0);

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live));
        assertEq(oracle.navOf(assetId).valueE6, 1_020_000, "the re-appraisal becomes the new price");
        assertEq(oracle.requireFreshNav(assetId), 1_020_000);

        (,,,, bool open) = oracle.disputes(assetId);
        assertFalse(open);
    }

    function test_ResolveDispute_ValuationOutsideTheBandVoidsTheNavAndRefundsTheBond() public {
        _open();
        uint256 issuerBefore = issuer.balance;

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.DisputeResolved(assetId, 2, true, 1_200_000);
        assertTrue(oracle.resolveDispute(assetId, evidence, _freshRound(1_200_000)));

        _assertPaid(challenger, BOND);
        assertEq(issuer.balance, issuerBefore);
        assertEq(oracle.pendingWithdrawals(issuer), 0);

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Voided));
        assertEq(oracle.haltCount(assetId), 1);
        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.OracleHalted.selector, assetId, HaltReason.Disagreement)
        );
        oracle.requireFreshNav(assetId);
    }

    function test_ResolveDispute_CommitteeDisagreementUpholdsTheChallenge() public {
        _open();

        // The committee answered and could not agree, which is evidence the value is not knowable.
        Verdict[] memory vs = roundFor(assetId, navList(1_000_000, 1_000_000, 5_000_000));
        assertTrue(oracle.resolveDispute(assetId, evidence, vs));

        _assertPaid(challenger, BOND);
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Voided));
    }

    /// @dev Opening a dispute and closing it with junk would void a valuation and refund the bond
    ///      for the price of gas.
    function test_ResolveDispute_RevertsOnAnUnauthenticatedRound() public {
        _open();
        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = Verdict({
                slot: i,
                responseBody: goodBody(assetId, i, 500_000, 9000, block.timestamp),
                signature: new bytes(65)
            });
        }

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.UnauthenticatedRound.selector, uint8(0)));
        oracle.resolveDispute(assetId, evidence, vs);
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Disputed), "still contested");
    }

    /// @dev The same hole one step further in: the verdicts are supplied by whoever calls this, so a
    ///      round that is authentic but produces no usable answers is equally manufacturable. Only a
    ///      committee that answered and disagreed settles a dispute in the challenger's favour.
    function test_ResolveDispute_RevertsWhenTheRoundReachesNoQuorum() public {
        _open();
        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = goodVerdict(pkAt(i), assetId, i, 1_000_000, 100, block.timestamp);
        }

        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.InconclusiveRound.selector, HaltReason.InsufficientQuorum)
        );
        oracle.resolveDispute(assetId, evidence, vs);
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Disputed));
    }

    function test_ResolveDispute_RevertsWithoutAnOpenDispute() public {
        publish(1_000_000);
        vm.warp(block.timestamp + 60);
        Verdict[] memory vs = _freshRound(1_000_000);
        vm.expectRevert(AssayOracle.NoOpenDispute.selector);
        oracle.resolveDispute(assetId, evidence, vs);
    }

    function test_ResolveDispute_AdvancesTheWatermark() public {
        _open();
        assertTrue(oracle.resolveDispute(assetId, evidence, _freshRound(1_020_000)) == false);
        assertEq(oracle.observationWatermark(assetId), uint64(block.timestamp));
    }

    // -----------------------------------------------------------------------------------
    // Lapsing
    // -----------------------------------------------------------------------------------

    function test_LapseDispute_RevertsBeforeTheWindowCloses() public {
        _open();
        uint64 until = uint64(block.timestamp - 60) + oracle.challengeWindow();
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.DisputeStillOpen.selector, until));
        oracle.lapseDispute(assetId);
    }

    function test_LapseDispute_ReturnsTheValuationToServiceAndPaysTheIssuer() public {
        // A window longer than the freshness window would leave nothing to return to, so this
        // asset keeps its valuation usable for a day.
        AssetConfig memory cfg = defaultConfig();
        cfg.maxAgeSec = 1 days;
        vm.prank(issuer);
        assets.configureAsset(assetId, cfg);

        _open();
        uint256 challengerBefore = challenger.balance;

        vm.warp(block.timestamp + oracle.challengeWindow() + 1);
        oracle.lapseDispute(assetId);

        _assertPaid(issuer, BOND);
        assertEq(challenger.balance, challengerBefore, "a challenger who will not back the claim pays");
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Live));
        assertEq(oracle.requireFreshNav(assetId), 1_000_000);

        (,,,, bool open) = oracle.disputes(assetId);
        assertFalse(open);
    }

    function test_LapseDispute_RevertsWithoutAnOpenDispute() public {
        publish(1_000_000);
        vm.expectRevert(AssayOracle.NoOpenDispute.selector);
        oracle.lapseDispute(assetId);
    }

    /// @dev Bonds are credited, not sent. An issuer is usually a multisig or a vault contract, and
    ///      pushing value at one that cannot accept it would have reverted the settlement itself,
    ///      leaving the asset frozen in dispute for as long as that stayed true.
    function test_ResolveDispute_SettlesEvenWhenTheIssuerCannotReceiveValue() public {
        ValueRejector stubborn = new ValueRejector();
        bytes32 id = keccak256("assay.test.asset.stubborn-issuer");

        AssetConfig memory cfg = defaultConfig();
        vm.prank(address(stubborn));
        assets.registerAsset(id, cfg, committee3(), "ipfs://assay/test");
        bytes32 evidenceHash = sha256(evidence);
        vm.prank(address(stubborn));
        assets.commitEvidence(id, evidenceHash, "ipfs://assay/test/evidence", true);

        Verdict[] memory first = roundFor(id, navList(1_000_000, 1_000_000, 1_000_000));
        assertTrue(oracle.postAppraisal(id, evidence, first));

        vm.prank(challenger);
        oracle.challenge{value: BOND}(id);
        vm.warp(block.timestamp + 60);

        Verdict[] memory fresh = roundFor(id, navList(1_020_000, 1_020_000, 1_020_000));
        assertFalse(oracle.resolveDispute(id, evidence, fresh), "settles rather than reverting");
        assertEq(uint8(oracle.navOf(id).state), uint8(NavState.Live));
        assertEq(oracle.pendingWithdrawals(address(stubborn)), BOND, "the bond waits to be claimed");

        // Claiming it is the issuer's problem, and it still reverts for them until they can accept
        // value. What matters is that it never became everyone else's problem.
        vm.prank(address(stubborn));
        vm.expectRevert(AssayOracle.BondTransferFailed.selector);
        oracle.withdraw();
        assertEq(oracle.pendingWithdrawals(address(stubborn)), BOND, "and it is not lost");
    }

    /// @dev Evidence commitments are the issuer's to make and to withdraw, and a dispute is about
    ///      a valuation that has already been published. If withdrawing the commitment blocked the
    ///      resolution, an issuer could answer every challenge by taking the document off the
    ///      allow-list and waiting for the window to lapse in their favour.
    function test_ResolveDispute_SurvivesTheIssuerWithdrawingTheCommitment() public {
        _open();
        assertEq(oracle.navOf(assetId).evidenceHash, sha256(evidence));

        bytes32 h = sha256(evidence);
        vm.prank(issuer);
        assets.commitEvidence(assetId, h, "ipfs://evidence", false);
        assertFalse(assets.evidenceAllowed(assetId, h), "the issuer has withdrawn it");

        // The challenger is right, and can still prove it.
        assertTrue(oracle.resolveDispute(assetId, evidence, _freshRound(1_200_000)));
        _assertPaid(challenger, BOND);
        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Voided));
    }

    /// @dev The exception is narrow: only the document the contested valuation carries. Anything
    ///      else still has to be committed, so a dispute cannot be used to smuggle in a round about
    ///      something the issuer never stood behind.
    function test_ResolveDispute_StillRefusesEvidenceNobodyStoodBehind() public {
        _open();
        bytes memory invented = "schema=assay.test.v1;asset_id=carbon-001;credits=5;vintage=2024";
        Verdict[] memory vs = new Verdict[](3);
        for (uint8 i = 0; i < 3; ++i) {
            vs[i] = verdictOf(pkAt(i), assetId, i, invented, goodBody(assetId, i, 1_000_000, 9000, block.timestamp));
        }

        vm.expectRevert(abi.encodeWithSelector(AssayOracle.EvidenceNotCommitted.selector, sha256(invented)));
        oracle.resolveDispute(assetId, invented, vs);
    }

    function test_Withdraw_IsANoOpWithNothingCredited() public {
        vm.prank(challenger);
        assertEq(oracle.withdraw(), 0);
        assertEq(challenger.balance, 1 ether);
    }

    function test_Withdraw_CannotBeClaimedTwice() public {
        _open();
        assertTrue(oracle.resolveDispute(assetId, evidence, _freshRound(1_200_000)));

        vm.prank(challenger);
        assertEq(oracle.withdraw(), BOND);
        vm.prank(challenger);
        assertEq(oracle.withdraw(), 0, "the credit is cleared before the transfer");
    }

    /// @dev The whole griefing path in one test: open a dispute, try to close it for free, fail,
    ///      and lose the bond when the window runs out.
    function test_Challenger_CannotSettleTheirOwnDisputeForFree() public {
        Verdict[] memory firstRound = agreeingRound(1_000_000);
        assertTrue(post(firstRound));

        vm.prank(challenger);
        oracle.challenge{value: BOND}(assetId);
        uint256 challengerBefore = challenger.balance;
        vm.warp(block.timestamp + 60);

        // Re-posting the round that produced the contested value: every signature is genuine.
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.UnauthenticatedRound.selector, uint8(0)));
        oracle.resolveDispute(assetId, evidence, firstRound);

        vm.warp(block.timestamp + oracle.challengeWindow() + 1);
        oracle.lapseDispute(assetId);

        assertEq(challenger.balance, challengerBefore, "the bond is gone");
        assertEq(oracle.pendingWithdrawals(challenger), 0);
        _assertPaid(issuer, BOND);
    }
}
