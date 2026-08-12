// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply, exact-transfer PIPEDOG stand-in for Base Sepolia.
/// @dev Testnet only. There is no owner, tax, rebasing, permit, or post-deploy
///      mint path. The complete rehearsal supply is minted once to `recipient`.
contract MockPipedogBaseSepolia is ERC20 {
    error InvalidMockConfig();

    constructor(address recipient, uint256 supply)
        ERC20("Mock Pipedog", "tPIPEDOG")
    {
        if (recipient == address(0) || supply == 0) {
            revert InvalidMockConfig();
        }
        _mint(recipient, supply);
    }
}
