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
    error InvalidArbSysResponse();
    error InvalidCodehash(
        address target,
        bytes32 actual,
        bytes32 expected
    );

    function run() external {
        validate();
        validateArbSysRpc();
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
        _requireCode(PipedogProtocolConfig.CREATE2_DEPLOYER);
        _requireCodehash(
            PipedogProtocolConfig.POOL_MANAGER,
            PipedogProtocolConfig.POOL_MANAGER_CODEHASH
        );
        _requireCodehash(
            PipedogProtocolConfig.CREATE2_DEPLOYER,
            PipedogProtocolConfig.CREATE2_DEPLOYER_CODEHASH
        );

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

    /// @notice Checks ArbSys through the configured RPC rather than Foundry's
    ///         local fork EVM, which does not emulate Robinhood precompiles.
    /// @dev This is a script-only cheatcode gate and is called before any
    ///      deployment broadcast begins.
    function validateArbSysRpc()
        public
        returns (uint256 arbBlockNumber)
    {
        bytes memory result = vm.rpc(
            "eth_call",
            '[{"to":"0x0000000000000000000000000000000000000064","data":"0xa3b1b31d"},"latest"]'
        );
        if (result.length != 32) revert InvalidArbSysResponse();
        arbBlockNumber = abi.decode(result, (uint256));
        if (arbBlockNumber == 0) revert InvalidArbSysResponse();
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _requireCodehash(
        address target,
        bytes32 expectedCodehash
    ) private view {
        bytes32 actualCodehash;
        assembly ("memory-safe") {
            actualCodehash := extcodehash(target)
        }
        if (actualCodehash != expectedCodehash) {
            revert InvalidCodehash(
                target, actualCodehash, expectedCodehash
            );
        }
    }
}
