// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IUniswapV3Pool} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";

/// @notice Read-only deployment gate for the live Robinhood Chain wiring.
contract PreflightRobinhood is Script {
    error WrongChain(uint256 actual, uint256 expected);
    error MissingCode(address target);
    error InvalidPoolPair(address token0, address token1);
    error InvalidPoolFee(uint24 actual, uint24 expected);
    error InvalidPoolFactory(address actual, address expected);
    error FactoryPoolMismatch(address actual, address expected);
    error EmptyPool();
    error InvalidTokenSupply();

    function run() external view {
        validate();
        console2.log("Laypipe Robinhood preflight passed");
        console2.log("chainId", block.chainid);
        console2.log(
            "poolManager", PipedogProtocolConfig.POOL_MANAGER
        );
        console2.log(
            "PIPEDOG", PipedogProtocolConfig.PIPEDOG
        );
        console2.log(
            "PIPEDOG/WETH v3 pool",
            PipedogProtocolConfig.PIPEDOG_WETH_V3_POOL
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
        _requireCode(PipedogProtocolConfig.WETH);
        _requireCode(PipedogProtocolConfig.PIPEDOG_WETH_V3_POOL);
        _requireCode(PipedogProtocolConfig.UNISWAP_V3_FACTORY);

        // Force an interface read on PoolManager too, rather than treating
        // non-empty bytecode as sufficient.
        IPoolManager(PipedogProtocolConfig.POOL_MANAGER).protocolFeesAccrued(
            Currency.wrap(PipedogProtocolConfig.WETH)
        );

        IUniswapV3Pool pool =
            IUniswapV3Pool(PipedogProtocolConfig.PIPEDOG_WETH_V3_POOL);
        address token0 = pool.token0();
        address token1 = pool.token1();
        bool correctPair =
            (
                token0 == PipedogProtocolConfig.WETH
                    && token1 == PipedogProtocolConfig.PIPEDOG
            )
                || (
                    token1 == PipedogProtocolConfig.WETH
                        && token0 == PipedogProtocolConfig.PIPEDOG
                );
        if (!correctPair) revert InvalidPoolPair(token0, token1);

        uint24 fee = pool.fee();
        if (fee != PipedogProtocolConfig.PIPEDOG_WETH_V3_FEE) {
            revert InvalidPoolFee(
                fee, PipedogProtocolConfig.PIPEDOG_WETH_V3_FEE
            );
        }
        address factory = pool.factory();
        if (factory != PipedogProtocolConfig.UNISWAP_V3_FACTORY) {
            revert InvalidPoolFactory(
                factory, PipedogProtocolConfig.UNISWAP_V3_FACTORY
            );
        }
        address canonical = IUniswapV3Factory(factory).getPool(
            token0, token1, fee
        );
        if (canonical != address(pool)) {
            revert FactoryPoolMismatch(canonical, address(pool));
        }
        if (pool.liquidity() == 0) revert EmptyPool();
        if (
            IERC20(PipedogProtocolConfig.PIPEDOG).totalSupply() == 0
                || IERC20(PipedogProtocolConfig.WETH).totalSupply() == 0
        ) revert InvalidTokenSupply();
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert MissingCode(target);
    }
}
