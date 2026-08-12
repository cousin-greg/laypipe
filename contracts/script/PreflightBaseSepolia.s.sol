// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BaseSepoliaConfig} from "./BaseSepoliaConfig.sol";

/// @notice Read-only gate for the isolated Base Sepolia rehearsal path.
contract PreflightBaseSepolia is Script {
    error WrongChain(uint256 actual, uint256 expected);
    error MissingCode(address target);
    error InvalidCodehash(address target, bytes32 actual, bytes32 expected);

    function run() external view {
        validate();
        console2.log("LayPipe Base Sepolia TEST-ONLY preflight passed");
        console2.log("chainId", block.chainid);
        console2.log("poolManager", BaseSepoliaConfig.POOL_MANAGER);
    }

    function validate() public view {
        if (block.chainid != BaseSepoliaConfig.CHAIN_ID) {
            revert WrongChain(block.chainid, BaseSepoliaConfig.CHAIN_ID);
        }
        _requireCode(BaseSepoliaConfig.POOL_MANAGER);
        _requireCode(BaseSepoliaConfig.CREATE2_DEPLOYER);
        _requireCodehash(BaseSepoliaConfig.POOL_MANAGER, BaseSepoliaConfig.POOL_MANAGER_CODEHASH);
        _requireCodehash(BaseSepoliaConfig.CREATE2_DEPLOYER, BaseSepoliaConfig.CREATE2_DEPLOYER_CODEHASH);

        // Exercise the exact PoolManager interface LayPipe uses. The mock
        // quote does not exist until the deployment sequence begins, so the
        // native currency id is sufficient for this read-only interface gate.
        IPoolManager(BaseSepoliaConfig.POOL_MANAGER).protocolFeesAccrued(Currency.wrap(address(0)));
    }

    function _requireCode(address target) private view {
        if (target.code.length == 0) revert MissingCode(target);
    }

    function _requireCodehash(address target, bytes32 expectedCodehash) private view {
        bytes32 actualCodehash;
        assembly ("memory-safe") {
            actualCodehash := extcodehash(target)
        }
        if (actualCodehash != expectedCodehash) {
            revert InvalidCodehash(target, actualCodehash, expectedCodehash);
        }
    }
}
