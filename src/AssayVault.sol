// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IAssayOracle} from "./interfaces/IAssayOracle.sol";

/// @title AssayVault
/// @notice A tokenised claim on a real-world basket whose unit price comes from {AssayOracle}.
/// @dev This contract exists to make the refusal expensive to ignore. Subscription and redemption
///      both price off `requireFreshNav`, which reverts whenever the committee failed to agree, the
///      valuation aged out, a challenge is open, or the sequencer is unhealthy. There is no cached
///      price to fall back on and no operator override: when the oracle will not speak, the vault
///      does not move money. That is the intended behaviour, not an outage.
contract AssayVault is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Settlement currency subscriptions and redemptions are denominated in.
    IERC20 public immutable currency;

    /// @notice Decimals of {currency}, cached to convert between price and share units.
    uint8 public immutable currencyDecimals;

    /// @notice Oracle consulted for every value-moving operation.
    IAssayOracle public immutable oracle;

    /// @notice Asset this vault tracks inside the oracle.
    bytes32 public immutable assetId;

    /// @notice Party responsible for the underlying basket and for funding redemptions.
    address public issuer;

    /// @notice Upper bound on shares outstanding, in share units.
    uint256 public supplyCap;

    /// @notice When true, new subscriptions are refused. Redemptions stay open.
    bool public subscriptionsPaused;

    event Subscribed(address indexed who, uint256 currencyIn, uint256 sharesOut, uint256 navE6);
    event Redeemed(address indexed who, uint256 sharesIn, uint256 currencyOut, uint256 navE6);
    event LiquidityAdded(address indexed from, uint256 amount);
    event LiquidityRemoved(address indexed to, uint256 amount);
    event SupplyCapSet(uint256 cap);
    event SubscriptionsPaused(bool paused);
    event IssuerSet(address indexed issuer);

    error NotIssuer();
    error SubscriptionsClosed();
    error ZeroAmount();
    error CapExceeded(uint256 wouldBe, uint256 cap);
    error InsufficientLiquidity(uint256 needed, uint256 available);

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        IERC20 currency_,
        uint8 currencyDecimals_,
        IAssayOracle oracle_,
        bytes32 assetId_,
        address issuer_,
        uint256 supplyCap_
    ) ERC20(name_, symbol_) {
        currency = currency_;
        currencyDecimals = currencyDecimals_;
        oracle = oracle_;
        assetId = assetId_;
        issuer = issuer_;
        supplyCap = supplyCap_;
    }

    /// @notice Buy shares at the current attested unit price.
    /// @dev Reverts inside the oracle when there is no usable price. Nothing here catches that.
    function subscribe(uint256 currencyIn) external nonReentrant returns (uint256 sharesOut) {
        if (subscriptionsPaused) revert SubscriptionsClosed();
        if (currencyIn == 0) revert ZeroAmount();

        uint256 navE6 = oracle.requireFreshNav(assetId);
        sharesOut = (currencyIn * 1e18) / _scalePrice(navE6);
        if (sharesOut == 0) revert ZeroAmount();

        uint256 wouldBe = totalSupply() + sharesOut;
        if (supplyCap != 0 && wouldBe > supplyCap) revert CapExceeded(wouldBe, supplyCap);

        currency.safeTransferFrom(msg.sender, address(this), currencyIn);
        _mint(msg.sender, sharesOut);
        emit Subscribed(msg.sender, currencyIn, sharesOut, navE6);
    }

    /// @notice Sell shares back at the current attested unit price.
    function redeem(uint256 sharesIn) external nonReentrant returns (uint256 currencyOut) {
        if (sharesIn == 0) revert ZeroAmount();

        uint256 navE6 = oracle.requireFreshNav(assetId);
        currencyOut = (sharesIn * _scalePrice(navE6)) / 1e18;
        if (currencyOut == 0) revert ZeroAmount();

        uint256 available = currency.balanceOf(address(this));
        if (currencyOut > available) revert InsufficientLiquidity(currencyOut, available);

        _burn(msg.sender, sharesIn);
        currency.safeTransfer(msg.sender, currencyOut);
        emit Redeemed(msg.sender, sharesIn, currencyOut, navE6);
    }

    /// @notice Current unit price, or a revert explaining why there is not one.
    function unitPriceE6() external view returns (uint256) {
        return oracle.requireFreshNav(assetId);
    }

    /// @notice Non-reverting health probe for user interfaces.
    function canTransact() external view returns (bool ok) {
        try oracle.requireFreshNav(assetId) returns (uint256) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    // ---------------------------------------------------------------------------------------
    // Issuer operations
    // ---------------------------------------------------------------------------------------

    function addLiquidity(uint256 amount) external onlyIssuer {
        currency.safeTransferFrom(msg.sender, address(this), amount);
        emit LiquidityAdded(msg.sender, amount);
    }

    function removeLiquidity(uint256 amount, address to) external onlyIssuer {
        currency.safeTransfer(to, amount);
        emit LiquidityRemoved(to, amount);
    }

    function setSupplyCap(uint256 cap) external onlyIssuer {
        supplyCap = cap;
        emit SupplyCapSet(cap);
    }

    function setSubscriptionsPaused(bool paused) external onlyIssuer {
        subscriptionsPaused = paused;
        emit SubscriptionsPaused(paused);
    }

    function setIssuer(address newIssuer) external onlyIssuer {
        issuer = newIssuer;
        emit IssuerSet(newIssuer);
    }

    /// @dev The oracle quotes in units of 1e6 USD. When the settlement currency uses a different
    ///      scale the price is rescaled once here, so the share maths stays in one place.
    function _scalePrice(uint256 navE6) internal view returns (uint256) {
        if (currencyDecimals == 6) return navE6;
        if (currencyDecimals > 6) return navE6 * (10 ** (currencyDecimals - 6));
        return navE6 / (10 ** (6 - currencyDecimals));
    }
}
