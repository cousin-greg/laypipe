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
import {PipedogRevenueRouter} from
    "../src/PipedogRevenueRouter.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";
import {CurveEconomics} from "../src/lib/CurveEconomics.sol";
import {BaseSepoliaConfig} from "./BaseSepoliaConfig.sol";
import {PreflightBaseSepolia} from
    "./PreflightBaseSepolia.s.sol";
import {MockPipedogBaseSepolia} from
    "./mocks/MockPipedogBaseSepolia.sol";

/// @notice Deploys an isolated LayPipe rehearsal stack on Base Sepolia with a
///         fixed-supply mock quote token and leaves launches disabled.
/// @dev TESTNET ONLY. This script never references canonical Robinhood
///      PIPEDOG or modifies the production deployment path. Omitting
///      `--broadcast` performs a complete simulation without sending a tx.
contract DeployLaypipeBaseSepolia is Script {
    uint256 internal constant MOCK_SALT_ROUNDS = 4_096;

    error InvalidDeploymentConfig();
    error MockQuoteSaltNotFound();
    error MockQuoteAddressMismatch(address expected, address actual);
    error HookAddressMismatch(address expected, address actual);
    error HookFlagsMismatch(uint160 expected, uint160 actual);
    error WiringMismatch();

    struct Deployment {
        address mockPipedog;
        address factoryImplementation;
        address factoryProxy;
        address tokenImplementation;
        address hook;
        address selfBurner;
        address swapRouter;
        address revenueRouter;
    }

    struct Inputs {
        uint256 deployerPrivateKey;
        address deployer;
        address finalOwner;
        address treasuryWallet;
        address operationsWallet;
        uint256 mockPipedogSupply;
        uint256 launchTokenSupply;
        uint256 launchFee;
        uint256 sequesterCap;
        uint256 treasuryCap;
        uint256 selfBurnCap;
        uint16 routerBountyBps;
        uint16 selfBurnBountyBps;
        int24 tickSpacing;
        int24 startTick;
    }

    function run() external returns (Deployment memory deployed) {
        new PreflightBaseSepolia().validate();
        Inputs memory inputs = _readInputs();

        (address predictedMock, bytes32 mockSalt) =
            _findMockQuote(inputs.deployer, inputs.mockPipedogSupply);

        vm.startBroadcast(inputs.deployerPrivateKey);

        MockPipedogBaseSepolia mockPipedog =
            new MockPipedogBaseSepolia{salt: mockSalt}(
                inputs.deployer, inputs.mockPipedogSupply
            );
        if (address(mockPipedog) != predictedMock) {
            revert MockQuoteAddressMismatch(
                predictedMock, address(mockPipedog)
            );
        }
        deployed.mockPipedog = address(mockPipedog);
        IERC20 quoteToken = IERC20(address(mockPipedog));
        IPoolManager poolManager =
            IPoolManager(BaseSepoliaConfig.POOL_MANAGER);

        PipedogRevenueRouter revenueRouter =
            new PipedogRevenueRouter(
                quoteToken,
                inputs.treasuryWallet,
                inputs.operationsWallet,
                inputs.sequesterCap,
                inputs.treasuryCap,
                inputs.routerBountyBps,
                inputs.deployer
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
                    quoteToken,
                    address(revenueRouter),
                    inputs.deployer,
                    inputs.launchFee
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
            quoteToken,
            address(revenueRouter),
            inputs.deployer
        );
        (address predictedHook, bytes32 hookSalt) = HookMiner.find(
            BaseSepoliaConfig.CREATE2_DEPLOYER,
            flags,
            type(PipedogHook).creationCode,
            constructorArgs
        );
        PipedogHook hook = new PipedogHook{salt: hookSalt}(
            poolManager,
            address(factory),
            quoteToken,
            address(revenueRouter),
            inputs.deployer
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
            inputs.selfBurnCap,
            inputs.selfBurnBountyBps
        );
        factory.setSelfBurner(selfBurner);
        deployed.selfBurner = address(selfBurner);

        LaypipeSwapRouter swapRouter =
            new LaypipeSwapRouter(poolManager, quoteToken, hook);
        deployed.swapRouter = address(swapRouter);

        factory.addLaunchConfig(
            _standardConfig(
                inputs.launchTokenSupply,
                inputs.tickSpacing,
                inputs.startTick,
                false
            )
        );
        factory.addLaunchConfig(
            _standardConfig(
                inputs.launchTokenSupply,
                inputs.tickSpacing,
                inputs.startTick,
                true
            )
        );

        factory.transferOwnership(inputs.finalOwner);
        hook.transferOwnership(inputs.finalOwner);
        revenueRouter.transferOwnership(inputs.finalOwner);

        vm.stopBroadcast();

        _assertWiring(deployed, inputs);
        _logDeployment(deployed, inputs);
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

    function _readInputs() private view returns (Inputs memory inputs) {
        inputs.deployerPrivateKey =
            vm.envUint("BASE_SEPOLIA_DEPLOYER_PRIVATE_KEY");
        inputs.deployer = vm.addr(inputs.deployerPrivateKey);
        inputs.finalOwner = vm.envOr(
            "BASE_SEPOLIA_FINAL_OWNER", inputs.deployer
        );
        inputs.treasuryWallet = vm.envOr(
            "BASE_SEPOLIA_TREASURY_WALLET", inputs.deployer
        );
        inputs.operationsWallet = vm.envOr(
            "BASE_SEPOLIA_OPERATIONS_WALLET", inputs.deployer
        );
        inputs.mockPipedogSupply = vm.envUint(
            "BASE_SEPOLIA_MOCK_PIPEDOG_SUPPLY_WEI"
        );
        inputs.launchTokenSupply = vm.envUint(
            "BASE_SEPOLIA_LAYPIPE_SUPPLY_WEI"
        );
        inputs.launchFee = vm.envUint(
            "BASE_SEPOLIA_LAUNCH_FEE_MOCK_PIPEDOG_WEI"
        );
        inputs.sequesterCap = vm.envUint(
            "BASE_SEPOLIA_MAX_SEQUESTER_PER_CALL_WEI"
        );
        inputs.treasuryCap = vm.envUint(
            "BASE_SEPOLIA_MAX_TREASURY_ROUTE_PER_CALL_WEI"
        );
        inputs.selfBurnCap = vm.envUint(
            "BASE_SEPOLIA_MAX_SELF_BURN_PER_CALL_WEI"
        );

        uint256 routerBountyRaw = vm.envUint(
            "BASE_SEPOLIA_ROUTER_BOUNTY_BPS"
        );
        uint256 selfBurnBountyRaw = vm.envUint(
            "BASE_SEPOLIA_SELF_BURN_BOUNTY_BPS"
        );
        int256 rawStartTick =
            vm.envInt("BASE_SEPOLIA_LAYPIPE_START_TICK");
        int256 rawTickSpacing =
            vm.envInt("BASE_SEPOLIA_LAYPIPE_TICK_SPACING");

        if (
            inputs.deployer == address(0)
                || inputs.finalOwner == address(0)
                || inputs.treasuryWallet == address(0)
                || inputs.operationsWallet == address(0)
                || inputs.mockPipedogSupply == 0
                || inputs.launchTokenSupply == 0
                || inputs.launchFee == 0
                || inputs.sequesterCap == 0
                || inputs.treasuryCap == 0
                || inputs.selfBurnCap == 0
                || routerBountyRaw > 1_000
                || selfBurnBountyRaw > 1_000
                || rawStartTick < type(int24).min
                || rawStartTick > type(int24).max
                || rawTickSpacing < type(int24).min
                || rawTickSpacing > type(int24).max
        ) revert InvalidDeploymentConfig();

        inputs.routerBountyBps = uint16(routerBountyRaw);
        inputs.selfBurnBountyBps = uint16(selfBurnBountyRaw);
        inputs.startTick = int24(rawStartTick);
        inputs.tickSpacing = int24(rawTickSpacing);
        if (
            inputs.tickSpacing < TickMath.MIN_TICK_SPACING
                || inputs.tickSpacing > TickMath.MAX_TICK_SPACING
                || inputs.startTick
                    <= TickMath.minUsableTick(inputs.tickSpacing)
                || inputs.startTick
                    > TickMath.maxUsableTick(inputs.tickSpacing)
                || inputs.startTick % inputs.tickSpacing != 0
        ) revert InvalidDeploymentConfig();
    }

    function _findMockQuote(address recipient, uint256 supply)
        private
        view
        returns (address predicted, bytes32 salt)
    {
        bytes memory initCode = abi.encodePacked(
            type(MockPipedogBaseSepolia).creationCode,
            abi.encode(recipient, supply)
        );
        uint160 midpoint = uint160(1) << 159;
        for (uint256 i; i < MOCK_SALT_ROUNDS; ++i) {
            salt = bytes32(i);
            predicted = HookMiner.computeAddress(
                BaseSepoliaConfig.CREATE2_DEPLOYER, salt, initCode
            );
            // Keep the mock quote in the lower half of the address space so
            // client-side vanity mining can reliably find launched tokens
            // above it while preserving quote-token currency0 ordering.
            if (
                uint160(predicted) < midpoint
                    && predicted.code.length == 0
            ) return (predicted, salt);
        }
        revert MockQuoteSaltNotFound();
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
            enabled: !selfBurn,
            selfBurn: selfBurn
        });
    }

    function _assertWiring(
        Deployment memory deployed,
        Inputs memory inputs
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
        LaypipeFactory.LaunchConfig memory standardConfig =
            factory.getLaunchConfig(0);
        LaypipeFactory.LaunchConfig memory selfBurnConfig =
            factory.getLaunchConfig(1);

        if (
            address(factory.poolManager())
                != BaseSepoliaConfig.POOL_MANAGER
                || address(factory.quoteToken())
                    != deployed.mockPipedog
                || address(factory.hook()) != deployed.hook
                || address(factory.tokenImplementation())
                    != deployed.tokenImplementation
                || address(factory.selfBurner())
                    != deployed.selfBurner
                || factory.dividendDistributor() != address(0)
                || factory.treasury() != deployed.revenueRouter
                || factory.launchEnabled()
                || factory.dividendLaunchEnabled()
                || factory.launchConfigCount() != 2
                || !standardConfig.enabled || standardConfig.selfBurn
                || selfBurnConfig.enabled || !selfBurnConfig.selfBurn
                || factory.pendingOwner() != inputs.finalOwner
                || hook.factory() != deployed.factoryProxy
                || address(hook.poolManager())
                    != BaseSepoliaConfig.POOL_MANAGER
                || address(hook.quoteToken())
                    != deployed.mockPipedog
                || hook.treasury() != deployed.revenueRouter
                || hook.pendingOwner() != inputs.finalOwner
                || selfBurner.factory() != deployed.factoryProxy
                || address(selfBurner.hook()) != deployed.hook
                || address(selfBurner.quoteToken())
                    != deployed.mockPipedog
                || address(swapRouter.hook()) != deployed.hook
                || address(swapRouter.pipedog())
                    != deployed.mockPipedog
                || address(revenueRouter.pipedog())
                    != deployed.mockPipedog
                || revenueRouter.pendingOwner()
                    != inputs.finalOwner
                || IERC20(deployed.mockPipedog).totalSupply()
                    != inputs.mockPipedogSupply
                || IERC20(deployed.mockPipedog).balanceOf(
                    inputs.deployer
                ) != inputs.mockPipedogSupply
        ) revert WiringMismatch();
    }

    function _logDeployment(
        Deployment memory deployed,
        Inputs memory inputs
    ) private pure {
        console2.log(
            "LayPipe Base Sepolia TEST-ONLY stack wired; launch DISABLED"
        );
        console2.log("standard config staged; self-burn config DISABLED");
        console2.log("mock tPIPEDOG", deployed.mockPipedog);
        console2.log(
            "factory implementation", deployed.factoryImplementation
        );
        console2.log("factory proxy", deployed.factoryProxy);
        console2.log(
            "token implementation", deployed.tokenImplementation
        );
        console2.log("hook", deployed.hook);
        console2.log("self burner", deployed.selfBurner);
        console2.log("swap router", deployed.swapRouter);
        console2.log("revenue router", deployed.revenueRouter);
        console2.log(
            "pending owner (must accept)", inputs.finalOwner
        );
        console2.log(
            "mock tPIPEDOG minted to deployer",
            inputs.mockPipedogSupply
        );
        console2.log(
            "implied test FDV (mock PIPEDOG wei)",
            CurveEconomics.impliedInitialFdvPipedog(
                inputs.launchTokenSupply, inputs.startTick
            )
        );
        console2.log(
            "TEST VALUES ONLY: do not copy into Robinhood production"
        );
    }
}
