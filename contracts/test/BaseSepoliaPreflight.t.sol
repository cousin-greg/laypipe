// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PreflightBaseSepolia} from "../script/PreflightBaseSepolia.s.sol";
import {BaseSepoliaConfig} from "../script/BaseSepoliaConfig.sol";

contract BaseSepoliaPreflightTest is Test {
    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://sepolia.base.org")));
    }

    function testOfficialUniswapV4BaseSepoliaPreflightPasses() public {
        new PreflightBaseSepolia().validate();
        assertEq(block.chainid, BaseSepoliaConfig.CHAIN_ID);
    }

    function testPreflightRejectsUnexpectedPoolManagerRuntime() public {
        PreflightBaseSepolia preflight = new PreflightBaseSepolia();
        bytes memory unexpectedRuntime = hex"60006000fd";
        vm.etch(BaseSepoliaConfig.POOL_MANAGER, unexpectedRuntime);

        vm.expectRevert(
            abi.encodeWithSelector(
                PreflightBaseSepolia.InvalidCodehash.selector,
                BaseSepoliaConfig.POOL_MANAGER,
                keccak256(unexpectedRuntime),
                BaseSepoliaConfig.POOL_MANAGER_CODEHASH
            )
        );
        preflight.validate();
    }
}
