// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssetConfig, HaltReason, NavState, Verdict} from "../src/Types.sol";

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
        uint256 issuerBefore = issuer.balance;
        uint256 challengerBefore = challenger.balance;

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.DisputeResolved(assetId, 2, false, 1_020_000);
        assertFalse(oracle.resolveDispute(assetId, evidence, _freshRound(1_020_000)));

        assertEq(issuer.balance, issuerBefore + BOND, "the challenger pays the issuer for the trouble");
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
        uint256 challengerBefore = challenger.balance;

        vm.expectEmit(true, true, false, true, address(oracle));
        emit AssayOracle.DisputeResolved(assetId, 2, true, 1_200_000);
        assertTrue(oracle.resolveDispute(assetId, evidence, _freshRound(1_200_000)));

        assertEq(challenger.balance, challengerBefore + BOND, "a correct challenger is made whole");
        assertEq(issuer.balance, issuerBefore);

        assertEq(uint8(oracle.navOf(assetId).state), uint8(NavState.Voided));
        assertEq(oracle.haltCount(assetId), 1);
        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.OracleHalted.selector, assetId, HaltReason.Disagreement)
        );
        oracle.requireFreshNav(assetId);
    }

    function test_ResolveDispute_CommitteeDisagreementUpholdsTheChallenge() public {
        _open();
        uint256 challengerBefore = challenger.balance;

        // The committee answered and could not agree, which is evidence the value is not knowable.
        Verdict[] memory vs = roundFor(assetId, navList(1_000_000, 1_000_000, 5_000_000));
        assertTrue(oracle.resolveDispute(assetId, evidence, vs));

        assertEq(challenger.balance, challengerBefore + BOND);
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
                signature: new bytes(65),
                contentOffset: 0,
                finishOffset: 0,
                createdOffset: 0
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
        uint256 issuerBefore = issuer.balance;
        uint256 challengerBefore = challenger.balance;

        vm.warp(block.timestamp + oracle.challengeWindow() + 1);
        oracle.lapseDispute(assetId);

        assertEq(issuer.balance, issuerBefore + BOND, "a challenger who will not back the claim pays");
        assertEq(challenger.balance, challengerBefore);
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

    /// @dev The whole griefing path in one test: open a dispute, try to close it for free, fail,
    ///      and lose the bond when the window runs out.
    function test_Challenger_CannotSettleTheirOwnDisputeForFree() public {
        Verdict[] memory firstRound = agreeingRound(1_000_000);
        assertTrue(post(firstRound));

        vm.prank(challenger);
        oracle.challenge{value: BOND}(assetId);
        uint256 challengerBefore = challenger.balance;
        uint256 issuerBefore = issuer.balance;
        vm.warp(block.timestamp + 60);

        // Re-posting the round that produced the contested value: every signature is genuine.
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.UnauthenticatedRound.selector, uint8(0)));
        oracle.resolveDispute(assetId, evidence, firstRound);

        vm.warp(block.timestamp + oracle.challengeWindow() + 1);
        oracle.lapseDispute(assetId);

        assertEq(challenger.balance, challengerBefore, "the bond is gone");
        assertEq(issuer.balance, issuerBefore + BOND);
    }
}
