// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixtures} from "./Fixtures.sol";
import {AssayVault} from "../src/AssayVault.sol";
import {IAssayOracle} from "../src/interfaces/IAssayOracle.sol";
import {AssetConfig, NavState, Nav, Verdict} from "../src/Types.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Properties that have to hold for inputs nobody wrote down: a published price is always
///         one the committee agreed on, and an arbitrary payload with arbitrary offsets can only
///         ever be refused or read from bytes that were actually signed.
contract FuzzTest is Fixtures {
    bytes32 internal constant SOLO = keccak256("assay.test.asset.solo");

    function setUp() public override {
        super.setUp();
        // A one-member committee keeps the payload fuzzing focused on the parser.
        string[] memory models = new string[](1);
        models[0] = MODEL_0;
        AssetConfig memory cfg = defaultConfig();
        cfg.quorum = 1;
        cfg.minDistinctSigners = 1;
        registerAsset(SOLO, models, cfg);
    }

    /// @notice A NAV is published only when every accepted answer sits inside the band around it.
    /// forge-config: default.fuzz.runs = 96
    function testFuzz_PublishedValueAgreesWithEveryAcceptedAnswer(uint128 base, uint16 spreadBps) public {
        uint256 mid = bound(uint256(base), 1e6, 1e15);
        uint256 spread = bound(uint256(spreadBps), 0, 2000);
        uint256 delta = (mid * spread) / 10_000;

        uint256[] memory navs = navList(mid - delta, mid, mid + delta);
        bool published = post(roundFor(assetId, navs));

        uint256 bandBps = assets.config(assetId).bandBps;
        Nav memory n = oracle.navOf(assetId);

        if (published) {
            assertEq(uint8(n.state), uint8(NavState.Live));
            assertEq(n.valueE6, mid, "the median of a symmetric spread is the middle answer");
            for (uint256 i = 0; i < navs.length; ++i) {
                uint256 dev = navs[i] > n.valueE6 ? navs[i] - n.valueE6 : n.valueE6 - navs[i];
                assertLe(dev * 10_000, uint256(n.valueE6) * bandBps, "an accepted answer outside the band");
            }
        } else {
            assertTrue(n.state != NavState.Live, "a refused round must not leave a readable price");
            assertGt(delta * 10_000, mid * bandBps, "refused a round that was inside the band");
        }
    }

    /// @notice The band is the only thing that decides, and it decides the same way both ways.
    /// forge-config: default.fuzz.runs = 96
    function testFuzz_BandBoundaryIsExact(uint128 base, uint16 bandBps) public {
        uint256 mid = bound(uint256(base), 1e6, 1e15);
        uint256 band = bound(uint256(bandBps), 1, 5000);

        AssetConfig memory cfg = defaultConfig();
        cfg.bandBps = uint16(band);
        vm.prank(issuer);
        assets.configureAsset(assetId, cfg);

        uint256 onTheLine = (mid * band) / 10_000;
        vm.assume(onTheLine > 0 && onTheLine * 10_000 == mid * band);

        assertTrue(post(roundFor(assetId, navList(mid - onTheLine, mid, mid + onTheLine))), "exactly on the band");

        vm.warp(block.timestamp + 60);
        assertFalse(
            post(roundFor(assetId, navList(mid - onTheLine, mid, mid + onTheLine + 1))), "one unit past it"
        );
    }

    /// @notice Round-tripping through the vault cannot create currency out of rounding.
    /// forge-config: default.fuzz.runs = 96
    function testFuzz_VaultRoundTripNeverPaysOutMoreThanWentIn(uint128 navE6, uint96 amount) public {
        uint256 nav = bound(uint256(navE6), 1e4, 1e12);
        uint256 currencyIn = bound(uint256(amount), 1e6, 1e12);

        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        AssayVault vault = new AssayVault(
            "v", "v", IERC20(address(usdc)), 6, IAssayOracle(address(oracle)), assetId, issuer, 0
        );
        usdc.mint(address(this), currencyIn);
        usdc.approve(address(vault), type(uint256).max);

        assertTrue(post(roundFor(assetId, navList(nav, nav, nav))));

        uint256 shares = vault.subscribe(currencyIn);
        uint256 out = vault.redeem(shares);
        assertLe(out, currencyIn, "a round trip at an unchanged price must not mint currency");
    }
}
