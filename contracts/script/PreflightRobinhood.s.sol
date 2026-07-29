// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";

/// @notice Read-only gate for the canonical PIPEDOG quote deployment.
contract PreflightRobinhood is Script {
    error WrongChain(uint256 actual, uint256 expected);
    error MissingCode(address target);
    error InvalidPipedogMetadata();
    error InvalidPipedogCodehash(bytes32 actual, bytes32 expected);

    function run() external view {
        validate();
        console2.log("Laypipe PIPEDOG-quote preflight passed");
        console2.log("chainId", block.chainid);
        console2.log(
            "poolManager", PipedogProtocolConfig.POOL_MANAGER
        );
        console2.log("quote token", PipedogProtocolConfig.PIPEDOG);
        console2.log(
            "quote totalSupply",
            PipedogProtocolConfig.PIPEDOG_TOTAL_SUPPLY
        );
    }

    function validate() public view {
        if (block.chainid != PipedogProtocolConfig.CHAIN_ID) {
            revert WrongChain(
                block.chainid, PipedogProtocolConfig.CHAIN_ID
            );
        }
        _requireCode(PipedogProtocolConfig.POOL_MANAGER);
        _requireCode(PipedogProtocolConfig.PIPEDOG);

        bytes32 actualCodehash;
        address tokenAddress = PipedogProtocolConfig.PIPEDOG;
        assembly ("memory-safe") {
            actualCodehash := extcodehash(tokenAddress)
        }
        if (actualCodehash != PipedogProtocolConfig.PIPEDOG_CODEHASH) {
            revert InvalidPipedogCodehash(
                actualCodehash, PipedogProtocolConfig.PIPEDOG_CODEHASH
            );
        }

        IERC20Metadata token = IERC20Metadata(tokenAddress);
        if (
            token.decimals() != PipedogProtocolConfig.PIPEDOG_DECIMALS
                || keccak256(bytes(token.symbol()))
                    != keccak256(bytes("PIPEDOG"))
                || keccak256(bytes(token.name()))
                    != keccak256(bytes("pipedog"))
                || token.totalSupply()
                    != PipedogProtocolConfig.PIPEDOG_TOTAL_SUPPLY
                || IERC20(tokenAddress).balanceOf(address(0)) != 0
        ) revert InvalidPipedogMetadata();

        // Exercise the PoolManager interface against the actual quote
        // currency rather than accepting bytecode presence alone.
        IPoolManager(PipedogProtocolConfig.POOL_MANAGER)
            .protocolFeesAccrued(Currency.wrap(tokenAddress));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert MissingCode(target);
    }
}
