// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoUSD
/// @notice Six-decimal settlement token for networks where no canonical stablecoin exists.
/// @dev Test networks have no real USDC, so subscriptions there settle in this. Mainnet vaults are
///      deployed against the canonical USDC contract instead; this is never part of that path.
contract DemoUSD is ERC20 {
    constructor() ERC20("Assay Demo USD", "dUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet. Only ever deployed to test networks.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
