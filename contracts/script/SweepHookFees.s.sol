// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PipedogHook} from "../src/PipedogHook.sol";

/// @notice Permissionless keeper entrypoint for converting a Laypipe pool's
/// pending Uniswap v4 claims into creator credit and an exact best-effort
/// platform route. A failed route is conserved for `collectPlatform()` retry.
/// @dev This script intentionally reads no private key. Use a hardware wallet,
/// a named Foundry keystore, or an explicitly unlocked keeper account through
/// Forge's standard wallet flags when broadcasting.
contract SweepHookFees is Script {
    error InvalidHook(address hook);

    function run() external returns (uint256 creatorAmount, uint256 platformAmount) {
        address hookAddress = vm.envAddress("LAYPIPE_HOOK");
        if (hookAddress.code.length == 0) revert InvalidHook(hookAddress);

        PoolId poolId = PoolId.wrap(vm.envBytes32("POOL_ID"));
        uint256 minimumPending = vm.envOr("MIN_PENDING_PIPEDOG_WEI", uint256(0));
        PipedogHook hook = PipedogHook(hookAddress);
        uint256 amount = hook.pending(poolId);

        console2.log("hook", hookAddress);
        console2.logBytes32(PoolId.unwrap(poolId));
        console2.log("pending PIPEDOG fee claims", amount);
        console2.log("minimum pending PIPEDOG threshold", minimumPending);

        if (amount == 0 || amount < minimumPending) {
            console2.log("nothing above threshold; no transaction created");
            return (0, 0);
        }

        vm.startBroadcast();
        (creatorAmount, platformAmount) = hook.sweep(poolId);
        vm.stopBroadcast();

        console2.log("creator amount credited", creatorAmount);
        console2.log("platform amount swept", platformAmount);
        console2.log("total platform tab", hook.platformTab());
        console2.log("pending after sweep", hook.pending(poolId));
    }
}
