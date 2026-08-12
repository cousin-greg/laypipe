// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {LaypipeFactory} from "../src/LaypipeFactory.sol";
import {LaypipeToken} from "../src/LaypipeToken.sol";
import {PipedogHook} from "../src/PipedogHook.sol";
import {LaypipeSelfBurner} from "../src/LaypipeSelfBurner.sol";
import {LaypipeSwapRouter} from "../src/LaypipeSwapRouter.sol";
import {PipedogRevenueRouter} from "../src/PipedogRevenueRouter.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";
import {CurveEconomics} from "../src/lib/CurveEconomics.sol";
import {PreflightRobinhood} from "./PreflightRobinhood.s.sol";

/// @notice Deploys the fresh PIPEDOG-quote stack and leaves launch disabled.
contract DeployLaypipe is Script {
    error InvalidDeploymentConfig();
    error HookAddressMismatch(address expected, address actual);
    error HookFlagsMismatch(uint160 expected, uint160 actual);
    error WiringMismatch();

    struct Deployment {
        address factoryImplementation;
        address factoryProxy;
        address tokenImplementation;
        address hook;
        address selfBurner;
        address swapRouter;
        address revenueRouter;
    }

    function run() external returns (Deployment memory deployed) {
        PreflightRobinhood preflight = new PreflightRobinhood();
        preflight.validate();
        preflight.validateArbSysRpc();

        address finalOwner = vm.envAddress("FINAL_OWNER");
        address treasuryWallet = vm.envAddress("TREASURY_WALLET");
        address operationsWallet = vm.envAddress("OPERATIONS_WALLET");
        uint256 launchFee =
            vm.envUint("LAYPIPE_LAUNCH_FEE_PIPEDOG_WEI");
        uint256 supply = vm.envUint("LAYPIPE_SUPPLY_WEI");
        int256 rawStartTick = vm.envInt("LAYPIPE_START_TICK");
        int256 rawTickSpacing = vm.envInt("LAYPIPE_TICK_SPACING");
        uint256 sequesterCap =
            vm.envUint("MAX_SEQUESTER_PER_CALL_PIPEDOG_WEI");
        uint256 treasuryCap =
            vm.envUint("MAX_TREASURY_ROUTE_PER_CALL_PIPEDOG_WEI");
        uint256 selfBurnCap =
            vm.envUint("MAX_SELF_BURN_PER_CALL_PIPEDOG_WEI");
        uint256 routerBountyRaw = vm.envUint("ROUTER_BOUNTY_BPS");
        uint256 selfBurnBountyRaw =
            vm.envUint("SELF_BURN_BOUNTY_BPS");
        uint256 deployerPrivateKey =
            vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        if (
            finalOwner == address(0) || treasuryWallet == address(0)
                || operationsWallet == address(0)
                || deployer == address(0) || supply == 0
                || launchFee == 0 || sequesterCap == 0
                || treasuryCap == 0 || selfBurnCap == 0
                || routerBountyRaw > type(uint16).max
                || selfBurnBountyRaw > type(uint16).max
                || rawStartTick < type(int24).min
                || rawStartTick > type(int24).max
                || rawTickSpacing < type(int24).min
                || rawTickSpacing > type(int24).max
        ) revert InvalidDeploymentConfig();
        int24 startTick = int24(rawStartTick);
        int24 tickSpacing = int24(rawTickSpacing);
        if (
            tickSpacing < TickMath.MIN_TICK_SPACING
                || tickSpacing > TickMath.MAX_TICK_SPACING
                || startTick <= TickMath.minUsableTick(tickSpacing)
                || startTick > TickMath.maxUsableTick(tickSpacing)
                || startTick % tickSpacing != 0
        ) revert InvalidDeploymentConfig();

        IERC20 pipedog = IERC20(PipedogProtocolConfig.PIPEDOG);
        IPoolManager poolManager =
            IPoolManager(PipedogProtocolConfig.POOL_MANAGER);

        vm.startBroadcast(deployerPrivateKey);

        PipedogRevenueRouter revenueRouter =
            new PipedogRevenueRouter(
                pipedog,
                treasuryWallet,
                operationsWallet,
                sequesterCap,
                treasuryCap,
                uint16(routerBountyRaw),
                deployer
            );
        deployed.revenueRouter = address(revenueRouter);

        LaypipeFactory implementation = new LaypipeFactory();
        deployed.factoryImplementation = address(implementation);
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                LaypipeFactory.initialize,
                (
                    poolManager,
                    pipedog,
                    address(revenueRouter),
                    deployer,
                    launchFee
                )
            )
        );
        LaypipeFactory factory = LaypipeFactory(address(proxy));
        deployed.factoryProxy = address(factory);

        LaypipeToken tokenImplementation = new LaypipeToken();
        deployed.tokenImplementation = address(tokenImplementation);

        uint160 flags = requiredHookFlags();
        bytes memory constructorArgs = abi.encode(
            poolManager,
            address(factory),
            pipedog,
            address(revenueRouter),
            deployer
        );
        (address predictedHook, bytes32 hookSalt) = HookMiner.find(
            PipedogProtocolConfig.CREATE2_DEPLOYER,
            flags,
            type(PipedogHook).creationCode,
            constructorArgs
        );
        PipedogHook hook = new PipedogHook{salt: hookSalt}(
            poolManager,
            address(factory),
            pipedog,
            address(revenueRouter),
            deployer
        );
        if (address(hook) != predictedHook) {
            revert HookAddressMismatch(predictedHook, address(hook));
        }
        uint160 actualFlags =
            uint160(address(hook)) & Hooks.ALL_HOOK_MASK;
        if (actualFlags != flags) {
            revert HookFlagsMismatch(flags, actualFlags);
        }
        Hooks.validateHookPermissions(
            IHooks(address(hook)), hook.getHookPermissions()
        );
        deployed.hook = address(hook);

        factory.setHook(hook);
        factory.setTokenImplementation(tokenImplementation);

        LaypipeSelfBurner selfBurner = new LaypipeSelfBurner(
            poolManager,
            hook,
            address(factory),
            selfBurnCap,
            uint16(selfBurnBountyRaw)
        );
        factory.setSelfBurner(selfBurner);
        deployed.selfBurner = address(selfBurner);

        LaypipeSwapRouter swapRouter =
            new LaypipeSwapRouter(poolManager, pipedog, hook);
        deployed.swapRouter = address(swapRouter);

        factory.addLaunchConfig(
            _standardConfig(supply, tickSpacing, startTick, false)
        );
        factory.addLaunchConfig(
            _standardConfig(supply, tickSpacing, startTick, true)
        );

        factory.transferOwnership(finalOwner);
        hook.transferOwnership(finalOwner);
        revenueRouter.transferOwnership(finalOwner);

        vm.stopBroadcast();

        _assertWiring(deployed, finalOwner);
        _logDeployment(
            deployed, finalOwner, supply, tickSpacing, startTick
        );
    }

    function requiredHookFlags() public pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }

    function _standardConfig(
        uint256 supply,
        int24 tickSpacing,
        int24 startTick,
        bool selfBurn
    ) private pure returns (LaypipeFactory.LaunchConfig memory) {
        return LaypipeFactory.LaunchConfig({
            supply: supply,
            tickSpacing: tickSpacing,
            startTick: startTick,
            creatorFeeBps: 7_000,
            baseFeeRate: 10_000,
            launchFeeRate: 10_000,
            launchFeeDecay: 0,
            enabled: true,
            selfBurn: selfBurn
        });
    }

    function _assertWiring(
        Deployment memory deployed,
        address finalOwner
    ) private view {
        LaypipeFactory factory =
            LaypipeFactory(deployed.factoryProxy);
        PipedogHook hook = PipedogHook(deployed.hook);
        LaypipeSelfBurner selfBurner =
            LaypipeSelfBurner(deployed.selfBurner);
        LaypipeSwapRouter swapRouter =
            LaypipeSwapRouter(deployed.swapRouter);
        PipedogRevenueRouter revenueRouter =
            PipedogRevenueRouter(deployed.revenueRouter);

        if (
            address(factory.poolManager())
                != PipedogProtocolConfig.POOL_MANAGER
                || address(factory.quoteToken())
                    != PipedogProtocolConfig.PIPEDOG
                || address(factory.hook()) != deployed.hook
                || address(factory.tokenImplementation())
                    != deployed.tokenImplementation
                || address(factory.selfBurner())
                    != deployed.selfBurner
                || factory.dividendDistributor() != address(0)
                || factory.treasury() != deployed.revenueRouter
                || factory.launchEnabled()
                || factory.dividendLaunchEnabled()
                || factory.pendingOwner() != finalOwner
                || hook.factory() != deployed.factoryProxy
                || address(hook.poolManager())
                    != PipedogProtocolConfig.POOL_MANAGER
                || address(hook.quoteToken())
                    != PipedogProtocolConfig.PIPEDOG
                || hook.treasury() != deployed.revenueRouter
                || hook.pendingOwner() != finalOwner
                || selfBurner.factory() != deployed.factoryProxy
                || address(selfBurner.hook()) != deployed.hook
                || address(selfBurner.quoteToken())
                    != PipedogProtocolConfig.PIPEDOG
                || address(swapRouter.hook()) != deployed.hook
                || address(swapRouter.pipedog())
                    != PipedogProtocolConfig.PIPEDOG
                || address(revenueRouter.pipedog())
                    != PipedogProtocolConfig.PIPEDOG
                || revenueRouter.pendingOwner() != finalOwner
        ) revert WiringMismatch();
    }

    function _logDeployment(
        Deployment memory deployed,
        address finalOwner,
        uint256 supply,
        int24 tickSpacing,
        int24 startTick
    ) private pure {
        console2.log("Laypipe PIPEDOG-quote stack wired; launch DISABLED");
        console2.log("factory implementation", deployed.factoryImplementation);
        console2.log("factory proxy", deployed.factoryProxy);
        console2.log("token implementation", deployed.tokenImplementation);
        console2.log("hook", deployed.hook);
        console2.log("self burner", deployed.selfBurner);
        console2.log("swap router", deployed.swapRouter);
        console2.log("revenue router", deployed.revenueRouter);
        console2.log("pending owner (must accept)", finalOwner);
        console2.log("configured supply", supply);
        console2.log("configured tick spacing");
        console2.logInt(tickSpacing);
        console2.log("configured start tick");
        console2.logInt(startTick);
        console2.log(
            "implied initial FDV (PIPEDOG wei)",
            CurveEconomics.impliedInitialFdvPipedog(supply, startTick)
        );
        console2.log(
            "ECONOMIC WARNING: calibrate curve before any broadcast"
        );
        console2.log("dividend mode quarantined and unavailable");
    }
}
