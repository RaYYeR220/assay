// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayOracle} from "../src/AssayOracle.sol";
import {AssayVault} from "../src/AssayVault.sol";
import {IAssayOracle} from "../src/interfaces/IAssayOracle.sol";
import {AssetConfig, HaltReason, Verdict} from "../src/Types.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {ReentrantERC20} from "./mocks/ReentrantERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice The vault is where a refusal has to cost something. Nothing here catches an oracle
///         revert, so every value-moving path stops dead when the committee will not speak.
contract AssayVaultTest is Fixtures {
    MockERC20 internal usdc;
    AssayVault internal vault;

    address internal alice = address(0xA11CE);
    address internal challenger;

    uint256 internal constant DEPOSIT = 1000e6;

    function setUp() public override {
        super.setUp();
        challenger = makeAddr("challenger");
        vm.deal(challenger, 1 ether);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        vault = new AssayVault(
            "Assay Carbon Basket", "aCARB", IERC20(address(usdc)), 6, IAssayOracle(address(oracle)), assetId, issuer, 0
        );

        usdc.mint(alice, 10_000e6);
        usdc.mint(issuer, 10_000e6);
        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
        vm.prank(issuer);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _subscribe(uint256 amount) internal returns (uint256) {
        vm.prank(alice);
        return vault.subscribe(amount);
    }

    // -----------------------------------------------------------------------------------
    // Share maths
    // -----------------------------------------------------------------------------------

    function test_Subscribe_MintsAtTheAttestedUnitPrice() public {
        publish(1_000_000);

        vm.expectEmit(true, false, false, true, address(vault));
        emit AssayVault.Subscribed(alice, DEPOSIT, 1000e18, 1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        assertEq(shares, (DEPOSIT * 1e18) / 1_000_000);
        assertEq(vault.balanceOf(alice), 1000e18, "a dollar of NAV buys one share");
        assertEq(vault.totalSupply(), 1000e18);
        assertEq(usdc.balanceOf(address(vault)), DEPOSIT);
        assertEq(usdc.balanceOf(alice), 9000e6);
        assertTrue(vault.canTransact());
        assertEq(vault.unitPriceE6(), 1_000_000);
    }

    function test_Subscribe_FollowsThePriceUpAndDown() public {
        publish(2_500_000);
        assertEq(_subscribe(DEPOSIT), 400e18, "a $2.50 unit price buys 400 shares for $1000");

        vm.warp(block.timestamp + 60);
        publish(500_000);
        assertEq(_subscribe(DEPOSIT), 2000e18);
    }

    function test_Redeem_ReturnsCurrencyAtTheAttestedUnitPrice() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        vm.expectEmit(true, false, false, true, address(vault));
        emit AssayVault.Redeemed(alice, shares, DEPOSIT, 1_000_000);
        vm.prank(alice);
        uint256 out = vault.redeem(shares);

        assertEq(out, DEPOSIT, "a round trip at an unchanged price is a no-op");
        assertEq(vault.balanceOf(alice), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(usdc.balanceOf(alice), 10_000e6);
    }

    function test_Redeem_RealisesAPriceMove() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        vm.warp(block.timestamp + 60);
        publish(1_050_000);
        vm.prank(issuer);
        vault.addLiquidity(1000e6);

        vm.prank(alice);
        assertEq(vault.redeem(shares), 1050e6, "the holder keeps the gain the committee attested to");
    }

    /// @dev A wrong branch here silently misprices every share, and the error is invisible on a
    ///      six-decimal demo chain. The same dollar amount must buy the same shares at every scale.
    function test_ScalePrice_IsConsistentAcrossCurrencyDecimals() public {
        publish(1_000_000);

        uint256 sharesAtSix = _subscribe(1000e6);

        MockERC20 dai = new MockERC20("Dai", "DAI", 18);
        AssayVault vault18 = new AssayVault(
            "v18", "v18", IERC20(address(dai)), 18, IAssayOracle(address(oracle)), assetId, issuer, 0
        );
        dai.mint(alice, 10_000e18);
        vm.startPrank(alice);
        dai.approve(address(vault18), type(uint256).max);
        uint256 sharesAtEighteen = vault18.subscribe(1000e18);
        vm.stopPrank();

        MockERC20 cents = new MockERC20("Cents", "CENT", 2);
        AssayVault vault2 = new AssayVault(
            "v2", "v2", IERC20(address(cents)), 2, IAssayOracle(address(oracle)), assetId, issuer, 0
        );
        cents.mint(alice, 10_000e2);
        vm.startPrank(alice);
        cents.approve(address(vault2), type(uint256).max);
        uint256 sharesAtTwo = vault2.subscribe(1000e2);
        vm.stopPrank();

        assertEq(sharesAtSix, 1000e18);
        assertEq(sharesAtEighteen, 1000e18, "eighteen-decimal currency must not mint 1e12 times more");
        assertEq(sharesAtTwo, 1000e18);

        // And back the other way.
        vm.prank(alice);
        assertEq(vault18.redeem(sharesAtEighteen), 1000e18);
        vm.prank(alice);
        assertEq(vault2.redeem(sharesAtTwo), 1000e2);
    }

    function test_Subscribe_RevertsWhenTheDepositBuysNoShares() public {
        publish(MAX_NAV_E6);
        vm.prank(alice);
        vm.expectRevert(AssayVault.ZeroAmount.selector);
        vault.subscribe(1);

        vm.prank(alice);
        vm.expectRevert(AssayVault.ZeroAmount.selector);
        vault.subscribe(0);
    }

    // -----------------------------------------------------------------------------------
    // What the oracle refuses, the vault refuses
    // -----------------------------------------------------------------------------------

    function _haltTheOracle() internal {
        vm.warp(block.timestamp + 60);
        assertFalse(post(roundFor(assetId, navList(1_000_000, 1_000_000, 9_000_000))));
        assertEq(uint8(oracle.lastHaltReason(assetId)), uint8(HaltReason.Disagreement));
    }

    function test_BothSidesStopWhenTheCommitteeCannotAgree() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);
        _haltTheOracle();

        assertFalse(vault.canTransact());

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.OracleHalted.selector, assetId, HaltReason.Disagreement)
        );
        vault.subscribe(DEPOSIT);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(AssayOracle.OracleHalted.selector, assetId, HaltReason.Disagreement)
        );
        vault.redeem(shares);
    }

    function test_BothSidesStopWhenTheValuationHasAgedOut() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        vm.warp(START_TIME + 3601);
        assertFalse(vault.canTransact());

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NavStale.selector, assetId, uint64(START_TIME)));
        vault.subscribe(DEPOSIT);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NavStale.selector, assetId, uint64(START_TIME)));
        vault.redeem(shares);
    }

    function test_BothSidesStopWhileAChallengeIsOpen() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        vm.prank(challenger);
        oracle.challenge{value: 0.01 ether}(assetId);

        assertFalse(vault.canTransact());

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NavDisputed.selector, assetId));
        vault.subscribe(DEPOSIT);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssayOracle.NavDisputed.selector, assetId));
        vault.redeem(shares);
    }

    function test_CanTransact_MirrorsTheOracleWithoutReverting() public {
        assertFalse(vault.canTransact(), "no valuation yet");
        publish(1_000_000);
        assertTrue(vault.canTransact());
        _haltTheOracle();
        assertFalse(vault.canTransact());
    }

    // -----------------------------------------------------------------------------------
    // Issuer controls and liquidity
    // -----------------------------------------------------------------------------------

    function test_SupplyCap_IsEnforced() public {
        publish(1_000_000);
        vm.prank(issuer);
        vault.setSupplyCap(1500e18);

        _subscribe(1000e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssayVault.CapExceeded.selector, 2000e18, 1500e18));
        vault.subscribe(1000e6);

        assertEq(_subscribe(500e6), 500e18, "right up to the cap is fine");
    }

    function test_Redeem_RevertsWhenThePoolIsShort() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        vm.prank(issuer);
        vault.removeLiquidity(400e6, issuer);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AssayVault.InsufficientLiquidity.selector, DEPOSIT, 600e6));
        vault.redeem(shares);

        vm.prank(issuer);
        vault.addLiquidity(400e6);
        vm.prank(alice);
        assertEq(vault.redeem(shares), DEPOSIT);
    }

    function test_IssuerOperations_AreIssuerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(AssayVault.NotIssuer.selector);
        vault.addLiquidity(1);
        vm.expectRevert(AssayVault.NotIssuer.selector);
        vault.removeLiquidity(1, alice);
        vm.expectRevert(AssayVault.NotIssuer.selector);
        vault.setSupplyCap(1);
        vm.expectRevert(AssayVault.NotIssuer.selector);
        vault.setSubscriptionsPaused(true);
        vm.expectRevert(AssayVault.NotIssuer.selector);
        vault.setIssuer(alice);
        vm.stopPrank();
    }

    function test_PausingClosesSubscriptionsButNotRedemptions() public {
        publish(1_000_000);
        uint256 shares = _subscribe(DEPOSIT);

        vm.prank(issuer);
        vault.setSubscriptionsPaused(true);

        vm.prank(alice);
        vm.expectRevert(AssayVault.SubscriptionsClosed.selector);
        vault.subscribe(DEPOSIT);

        vm.prank(alice);
        assertEq(vault.redeem(shares), DEPOSIT, "holders can always get out");
    }

    // -----------------------------------------------------------------------------------
    // Reentrancy
    // -----------------------------------------------------------------------------------

    function test_Reentrancy_IsBlockedOnSubscribe() public {
        ReentrantERC20 token = new ReentrantERC20();
        AssayVault hostile = new AssayVault(
            "hostile", "H", IERC20(address(token)), 6, IAssayOracle(address(oracle)), assetId, issuer, 0
        );
        token.mint(alice, 10_000e6);
        vm.prank(alice);
        token.approve(address(hostile), type(uint256).max);
        publish(1_000_000);

        token.arm(address(hostile), true, false);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hostile.subscribe(DEPOSIT);

        assertEq(hostile.totalSupply(), 0, "no shares were minted on the way out");
    }

    function test_Reentrancy_IsBlockedOnRedeem() public {
        ReentrantERC20 token = new ReentrantERC20();
        AssayVault hostile = new AssayVault(
            "hostile", "H", IERC20(address(token)), 6, IAssayOracle(address(oracle)), assetId, issuer, 0
        );
        token.mint(alice, 10_000e6);
        vm.prank(alice);
        token.approve(address(hostile), type(uint256).max);
        publish(1_000_000);

        vm.prank(alice);
        uint256 shares = hostile.subscribe(DEPOSIT);

        token.arm(address(hostile), false, true);
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        hostile.redeem(shares);

        assertEq(hostile.balanceOf(alice), shares, "the burn was rolled back with the transfer");
    }
}
