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
    error DeploymentInputsNotApproved();
    error DeploymentInputsMismatch();
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

    struct ReviewedInputs {
        address deployer;
        address finalOwner;
        address treasuryWallet;
        address operationsWallet;
        uint256 supply;
        int256 tickSpacing;
        int256 startTick;
        uint256 launchFee;
        uint256 sequesterCap;
        uint256 treasuryCap;
        uint256 selfBurnCap;
        uint256 routerBountyBps;
        uint256 selfBurnBountyBps;
    }

    bytes32 private constant DEPLOYMENT_INPUTS_KIND_HASH =
        0x21b1662a0d9416874507f0d5ec266f5dc2dc6b8c3b7d5b024a52d1accd7f8750;
    bytes32 private constant APPROVED_STATUS_HASH =
        0x2b29265fc125740ae6bbc5035ae7af720b6932f4a3e44ba5ac02955c21ca9a05;

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

        _requireApprovedDeploymentInputs(
            ReviewedInputs({
                deployer: deployer,
                finalOwner: finalOwner,
                treasuryWallet: treasuryWallet,
                operationsWallet: operationsWallet,
                supply: supply,
                tickSpacing: rawTickSpacing,
                startTick: rawStartTick,
                launchFee: launchFee,
                sequesterCap: sequesterCap,
                treasuryCap: treasuryCap,
                selfBurnCap: selfBurnCap,
                routerBountyBps: routerBountyRaw,
                selfBurnBountyBps: selfBurnBountyRaw
            })
        );

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

    /// @dev The reviewed script enforces the approved values and its own exact
    ///      compiled runtime before `startBroadcast`. Git/source identity is
    ///      established separately by the clean-checkout rehearsal wrapper.
    function _requireApprovedDeploymentInputs(ReviewedInputs memory inputs)
        private
        view
    {
        string memory manifest = vm.readFile(
            vm.envString("LAYPIPE_DEPLOYMENT_INPUTS_PATH")
        );
        bytes32 approvedDigest =
            vm.envBytes32("LAYPIPE_APPROVED_DEPLOYMENT_INPUTS_HASH");
        _validateApprovedDeploymentInputs(
            manifest,
            approvedDigest,
            address(this).codehash,
            inputs
        );
    }

    function _validateApprovedDeploymentInputs(
        string memory manifest,
        bytes32 approvedDigest,
        bytes32 runningScriptCodehash,
        ReviewedInputs memory inputs
    ) private pure {
        string memory manifestDigest = vm.parseJsonString(
            manifest, ".approval.deploymentInputsHash"
        );
        string memory expectedDigest =
            _sha256PrefixedHex(approvedDigest);
        bytes32 computedDigest = deploymentInputsDigest(manifest);

        if (
            vm.parseJsonUint(manifest, ".schemaVersion") != 1
                || keccak256(bytes(vm.parseJsonString(manifest, ".kind")))
                    != DEPLOYMENT_INPUTS_KIND_HASH
                || keccak256(
                    bytes(vm.parseJsonString(manifest, ".approval.status"))
                ) != APPROVED_STATUS_HASH
                || keccak256(bytes(manifestDigest))
                    != keccak256(bytes(expectedDigest))
                || computedDigest != approvedDigest
                || approvedDigest == bytes32(0)
        ) revert DeploymentInputsNotApproved();

        if (
            vm.parseJsonUint(manifest, ".chain.chainId")
                != PipedogProtocolConfig.CHAIN_ID
                || vm.parseJsonAddress(manifest, ".chain.pipedog")
                    != PipedogProtocolConfig.PIPEDOG
                || vm.parseJsonAddress(manifest, ".chain.poolManager")
                    != PipedogProtocolConfig.POOL_MANAGER
                || vm.parseJsonAddress(manifest, ".chain.create2Deployer")
                    != PipedogProtocolConfig.CREATE2_DEPLOYER
                || vm.parseJsonBytes32(
                    manifest,
                    ".candidate.deployScriptRuntimeCodehash"
                ) != runningScriptCodehash
                || vm.parseJsonAddress(manifest, ".addresses.deployer")
                    != inputs.deployer
                || vm.parseJsonAddress(manifest, ".addresses.finalOwner")
                    != inputs.finalOwner
                || vm.parseJsonAddress(manifest, ".addresses.treasuryWallet")
                    != inputs.treasuryWallet
                || vm.parseJsonAddress(
                    manifest, ".addresses.operationsWallet"
                ) != inputs.operationsWallet
                || vm.parseJsonUint(manifest, ".economics.supplyWei")
                    != inputs.supply
                || vm.parseJsonInt(manifest, ".economics.tickSpacing")
                    != inputs.tickSpacing
                || vm.parseJsonInt(manifest, ".economics.startTick")
                    != inputs.startTick
                || vm.parseJsonUint(
                    manifest, ".economics.launchFeePipedogWei"
                ) != inputs.launchFee
                || vm.parseJsonUint(
                    manifest,
                    ".economics.maxSequesterPerCallPipedogWei"
                ) != inputs.sequesterCap
                || vm.parseJsonUint(
                    manifest,
                    ".economics.maxTreasuryRoutePerCallPipedogWei"
                ) != inputs.treasuryCap
                || vm.parseJsonUint(
                    manifest,
                    ".economics.maxSelfBurnPerCallPipedogWei"
                ) != inputs.selfBurnCap
                || vm.parseJsonUint(manifest, ".economics.routerBountyBps")
                    != inputs.routerBountyBps
                || vm.parseJsonUint(
                    manifest, ".economics.selfBurnBountyBps"
                ) != inputs.selfBurnBountyBps
                || vm.parseJsonBool(
                    manifest, ".stagedSafety.globalLaunchEnabled"
                )
                || !vm.parseJsonBool(
                    manifest, ".stagedSafety.creatorConfigEnabled"
                )
                || vm.parseJsonBool(
                    manifest, ".stagedSafety.selfBurnConfigEnabled"
                )
        ) revert DeploymentInputsMismatch();
    }

    /// @dev Test/review surface for the exact guard invoked by `run` before
    ///      `startBroadcast`. It reads no environment and deploys nothing.
    function validateApprovedDeploymentInputs(
        string memory manifest,
        bytes32 approvedDigest,
        ReviewedInputs memory inputs
    ) external view {
        _validateApprovedDeploymentInputs(
            manifest,
            approvedDigest,
            address(this).codehash,
            inputs
        );
    }

    function deploymentInputsDigest(string memory manifest)
        public
        pure
        returns (bytes32)
    {
        bytes32 candidateDigest = sha256(
            abi.encode(
                sha256(
                    bytes(
                        vm.parseJsonString(
                            manifest, ".candidate.sourceCommit"
                        )
                    )
                ),
                vm.parseJsonBytes32(
                    manifest, ".candidate.abiBundleSha256"
                ),
                vm.parseJsonBytes32(
                    manifest, ".candidate.artifactBundleSha256"
                ),
                vm.parseJsonBytes32(
                    manifest,
                    ".candidate.deployScriptRuntimeCodehash"
                ),
                sha256(
                    bytes(
                        vm.parseJsonString(
                            manifest,
                            ".candidate.deploymentSourceBundleSha256"
                        )
                    )
                ),
                sha256(
                    bytes(
                        vm.parseJsonString(
                            manifest, ".curveReview.configHash"
                        )
                    )
                )
            )
        );
        bytes32 chainDigest = sha256(
            abi.encode(
                vm.parseJsonUint(manifest, ".chain.chainId"),
                vm.parseJsonAddress(manifest, ".chain.pipedog"),
                vm.parseJsonAddress(manifest, ".chain.poolManager"),
                vm.parseJsonAddress(manifest, ".chain.create2Deployer")
            )
        );
        bytes32 addressesDigest = sha256(
            abi.encode(
                vm.parseJsonAddress(manifest, ".addresses.deployer"),
                vm.parseJsonAddress(manifest, ".addresses.finalOwner"),
                vm.parseJsonAddress(
                    manifest, ".addresses.treasuryWallet"
                ),
                vm.parseJsonAddress(
                    manifest, ".addresses.operationsWallet"
                )
            )
        );
        bytes32 economicsDigest = sha256(
            abi.encode(
                vm.parseJsonUint(manifest, ".economics.supplyWei"),
                vm.parseJsonInt(manifest, ".economics.tickSpacing"),
                vm.parseJsonInt(manifest, ".economics.startTick"),
                vm.parseJsonUint(
                    manifest, ".economics.launchFeePipedogWei"
                ),
                vm.parseJsonUint(
                    manifest,
                    ".economics.maxSequesterPerCallPipedogWei"
                ),
                vm.parseJsonUint(
                    manifest,
                    ".economics.maxTreasuryRoutePerCallPipedogWei"
                ),
                vm.parseJsonUint(
                    manifest,
                    ".economics.maxSelfBurnPerCallPipedogWei"
                ),
                vm.parseJsonUint(manifest, ".economics.routerBountyBps"),
                vm.parseJsonUint(
                    manifest, ".economics.selfBurnBountyBps"
                )
            )
        );
        bytes32 safetyDigest = sha256(
            abi.encode(
                vm.parseJsonBool(
                    manifest, ".stagedSafety.globalLaunchEnabled"
                ),
                vm.parseJsonBool(
                    manifest, ".stagedSafety.creatorConfigEnabled"
                ),
                vm.parseJsonBool(
                    manifest, ".stagedSafety.selfBurnConfigEnabled"
                )
            )
        );
        return sha256(
            abi.encode(
                vm.parseJsonUint(manifest, ".schemaVersion"),
                sha256(bytes(vm.parseJsonString(manifest, ".kind"))),
                candidateDigest,
                chainDigest,
                addressesDigest,
                economicsDigest,
                safetyDigest
            )
        );
    }

    function _sha256PrefixedHex(bytes32 digest)
        private
        pure
        returns (string memory)
    {
        bytes memory digestHex = bytes(vm.toString(digest));
        bytes memory digestWithoutPrefix =
            new bytes(digestHex.length - 2);
        for (uint256 i; i < digestWithoutPrefix.length; ++i) {
            digestWithoutPrefix[i] = digestHex[i + 2];
        }
        return string.concat(
            "sha256:", string(digestWithoutPrefix)
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
            enabled: !selfBurn,
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
        LaypipeFactory.LaunchConfig memory standardConfig =
            factory.getLaunchConfig(0);
        LaypipeFactory.LaunchConfig memory selfBurnConfig =
            factory.getLaunchConfig(1);

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
                || factory.launchConfigCount() != 2
                || !standardConfig.enabled || standardConfig.selfBurn
                || selfBurnConfig.enabled || !selfBurnConfig.selfBurn
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
        console2.log("standard config staged; self-burn config DISABLED");
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
