// SPDX-License-Identifier: BSD-3-Clause
pragma solidity ^0.7.0;

import "@openzeppelin/contracts/token/ERC20/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Simple ERC20 contract to act as a stand-in for the old ERC20 Loom token in tests.
 */
contract TestToken is ERC20Burnable {
    uint256 public constant INITIAL_SUPPLY = 1000000000; // 1 billion

    constructor() ERC20("Test Token", "TEST") {
        // fund the token swap contract
        _mint(msg.sender, INITIAL_SUPPLY * 1e18);
    }
}
