// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IVaultEntryPoints {
    function subscribe(uint256 currencyIn) external returns (uint256);
    function redeem(uint256 sharesIn) external returns (uint256);
}

/// @notice Test double for a settlement token with a transfer hook, the ERC-777 / ERC-1363 shape.
/// @dev Real USDC has no callback, but a vault that accepts an arbitrary currency has to survive
///      one. When armed, the token re-enters the vault from inside the transfer it was asked to
///      perform, which is the window a reentrancy guard exists to close.
contract ReentrantERC20 is ERC20 {
    address public vault;
    bool public armedOnSubscribe;
    bool public armedOnRedeem;

    constructor() ERC20("Reentrant USD", "rUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address vault_, bool onSubscribe, bool onRedeem) external {
        vault = vault_;
        armedOnSubscribe = onSubscribe;
        armedOnRedeem = onRedeem;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armedOnSubscribe) {
            armedOnSubscribe = false;
            IVaultEntryPoints(vault).subscribe(1_000_000);
        }
        return super.transferFrom(from, to, value);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (armedOnRedeem) {
            armedOnRedeem = false;
            IVaultEntryPoints(vault).redeem(1e18);
        }
        return super.transfer(to, value);
    }
}
