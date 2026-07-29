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
import {IUniswapV3Pool} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {LaypipeFactory} from "../src/LaypipeFactory.sol";
import {LaypipeToken} from "../src/LaypipeToken.sol";
import {PipedogHook} from "../src/PipedogHook.sol";
import {LaypipeSelfBurner} from "../src/LaypipeSelfBurner.sol";
import {
    PipedogRevenueRouter,
    IPipedogWETH9
} from "../src/PipedogRevenueRouter.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";
import {PreflightRobinhood} from "./PreflightRobinhood.s.sol";

/// @notice Deploys and wires the Laypipe protocol, but deliberately leaves
/// global launch disabled. The final Safe must accept ownership on the
/// factory, hook, and revenue router, review the emitted addresses, then
/// explicitly enable launch.
contract DeployLaypipe is Script {
    address internal constant CREATE2_DEPLOYER =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;

    error InvalidFinalOwner();
    error HookAddressMismatch(address expected, address actual);
    error HookFlagsMismatch(uint160 expected, uint160 actual);
    error WiringMismatch();

    struct Deployment {
        address factoryImplementation;
        address factoryProxy;
        address tokenImplementation;
        address hook;
        address selfBurner;
        address revenueRouter;
    }

    function run() external returns (Deployment memory deployed) {
        new PreflightRobinhood().validate();

        address finalOwner = vm.envAddress("FINAL_OWNER");
        address treasuryWallet = vm.envAddress("TREASURY_WALLET");
        address operationsWallet = vm.envAddress("OPERATIONS_WALLET");
        uint256 launchFee =
            vm.envOr("LAYPIPE_LAUNCH_FEE_WEI", uint256(0.0005 ether));
        uint256 sequesterCap =
            vm.envOr("MAX_SEQUESTER_PER_CALL_WEI", uint256(0.1 ether));
        uint256 treasuryBuyCap =
            vm.envOr("MAX_TREASURY_BUY_PER_CALL_WEI", uint256(0.1 ether));
        // Loaded by Foundry from an ignored .env file. The key is never
        // accepted as a CLI argument, serialized, emitted, or logged.
        uint256 deployerPrivateKey =
            vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        if (
            finalOwner == address(0) || treasuryWallet == address(0)
                || operationsWallet == address(0)
                || deployer == address(0)
        ) revert InvalidFinalOwner();

        vm.startBroadcast(deployerPrivateKey);

        PipedogRevenueRouter revenueRouter = new PipedogRevenueRouter(
            IUniswapV3Pool(
                PipedogProtocolConfig.PIPEDOG_WETH_V3_POOL
            ),
            IUniswapV3Factory(
                PipedogProtocolConfig.UNISWAP_V3_FACTORY
            ),
            PipedogProtocolConfig.PIPEDOG_WETH_V3_FEE,
            IERC20(PipedogProtocolConfig.PIPEDOG),
            IPipedogWETH9(PipedogProtocolConfig.WETH),
            treasuryWallet,
            operationsWallet,
            sequesterCap,
            treasuryBuyCap,
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
                    IPoolManager(PipedogProtocolConfig.POOL_MANAGER),
                    payable(address(revenueRouter)),
                    deployer,
                    launchFee
                )
            )
        );
        LaypipeFactory factory = LaypipeFactory(payable(address(proxy)));
        deployed.factoryProxy = address(factory);

        LaypipeToken tokenImplementation = new LaypipeToken();
        deployed.tokenImplementation = address(tokenImplementation);

        uint160 flags = requiredHookFlags();
        bytes memory constructorArgs = abi.encode(
            IPoolManager(PipedogProtocolConfig.POOL_MANAGER),
            address(factory),
            address(revenueRouter),
            deployer
        );
        (address predictedHook, bytes32 hookSalt) = HookMiner.find(
            CREATE2_DEPLOYER,
            flags,
            type(PipedogHook).creationCode,
            constructorArgs
        );
        PipedogHook hook = new PipedogHook{salt: hookSalt}(
            IPoolManager(PipedogProtocolConfig.POOL_MANAGER),
            address(factory),
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
            IPoolManager(PipedogProtocolConfig.POOL_MANAGER),
            hook,
            address(factory)
        );
        factory.setSelfBurner(selfBurner);
        deployed.selfBurner = address(selfBurner);

        factory.addLaunchConfig(_standardConfig(false));
        factory.addLaunchConfig(_standardConfig(true));

        // No contract is live yet. Ownership transfer is two-step; the Safe
        // accepts each contract, reviews wiring, then enables launch.
        factory.transferOwnership(finalOwner);
        hook.transferOwnership(finalOwner);
        revenueRouter.transferOwnership(finalOwner);

        vm.stopBroadcast();

        _assertWiring(deployed, finalOwner);
        _logDeployment(deployed, finalOwner);
    }

    function requiredHookFlags() public pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }

    function _standardConfig(bool selfBurn)
        private
        pure
        returns (LaypipeFactory.LaunchConfig memory)
    {
        return LaypipeFactory.LaunchConfig({
            supply: 1_000_000_000 ether,
            tickSpacing: 200,
            startTick: 204_200,
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
            LaypipeFactory(payable(deployed.factoryProxy));
        PipedogHook hook = PipedogHook(payable(deployed.hook));
        LaypipeSelfBurner selfBurner =
            LaypipeSelfBurner(payable(deployed.selfBurner));

        if (
            address(factory.poolManager())
                != PipedogProtocolConfig.POOL_MANAGER
                || address(factory.hook()) != deployed.hook
                || address(factory.tokenImplementation())
                    != deployed.tokenImplementation
                || address(factory.selfBurner()) != deployed.selfBurner
                || address(factory.dividendDistributor()) != address(0)
                || factory.treasury() != deployed.revenueRouter
                || factory.launchEnabled()
                || factory.dividendLaunchEnabled()
                || factory.pendingOwner() != finalOwner
                || hook.factory() != deployed.factoryProxy
                || address(hook.poolManager())
                    != PipedogProtocolConfig.POOL_MANAGER
                || hook.treasury() != deployed.revenueRouter
                || hook.pendingOwner() != finalOwner
                || selfBurner.factory() != deployed.factoryProxy
                || address(selfBurner.hook()) != deployed.hook
                || PipedogRevenueRouter(
                    payable(deployed.revenueRouter)
                ).pendingOwner() != finalOwner
        ) revert WiringMismatch();
    }

    function _logDeployment(
        Deployment memory deployed,
        address finalOwner
    ) private pure {
        console2.log("Laypipe deployment wired; launch remains DISABLED");
        console2.log("factory implementation", deployed.factoryImplementation);
        console2.log("factory proxy", deployed.factoryProxy);
        console2.log("token implementation", deployed.tokenImplementation);
        console2.log("hook", deployed.hook);
        console2.log("self burner", deployed.selfBurner);
        console2.log("dividend distributor", address(0));
        console2.log("dividend launches", "DISABLED: mode under review");
        console2.log("revenue router", deployed.revenueRouter);
        console2.log("pending owner (must accept)", finalOwner);
    }
}
