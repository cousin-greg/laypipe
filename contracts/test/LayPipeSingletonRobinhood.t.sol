// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {LayPipeHybridToken} from "../src/LayPipeHybridToken.sol";
import {PipeDogRewards} from "../src/PipeDogRewards.sol";
import {PipeDogFeeHook} from "../src/PipeDogFeeHook.sol";
import {LayPipeSingletonLauncher} from "../src/LayPipeSingletonLauncher.sol";
import {LayPipeSingletonSwapRouter} from "../src/LayPipeSingletonSwapRouter.sol";
import {ILayPipeRewardVault} from "../src/interfaces/ILayPipeRewardVault.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";

contract ForkCreate2Deployer {
    function deploy(bytes32 salt, bytes memory creationCode) external returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        require(deployed != address(0));
    }

    function compute(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}

contract LayPipeSingletonRobinhoodTest is Test {
    address internal constant ARBSYS = 0x0000000000000000000000000000000000000064;
    address internal constant TRADER = address(0xB0B);
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant START_TICK = 204_200;

    IPoolManager internal manager;
    IERC20 internal pipedog;
    LayPipeHybridToken internal token;
    PipeDogRewards internal vault;
    PipeDogFeeHook internal hook;
    LayPipeSingletonLauncher internal launcher;
    LayPipeSingletonSwapRouter internal router;
    DN404Mirror internal mirror;

    function setUp() public {
        _mockArbBlockNumber(1);
        vm.makePersistent(ARBSYS);
        vm.createSelectFork(vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com")));
        _mockArbBlockNumber(block.number);

        manager = IPoolManager(PipedogProtocolConfig.POOL_MANAGER);
        pipedog = IERC20(PipedogProtocolConfig.PIPEDOG);
        token = _deployOrderedHybrid();
        vault = token.rewardVault();
        mirror = DN404Mirror(payable(token.mirrorERC721()));
        hook = _deployHook();
        launcher =
            new LayPipeSingletonLauncher(manager, pipedog, IERC20(address(token)), hook, TICK_SPACING, START_TICK);
        hook.setLauncher(address(launcher));
        router = new LayPipeSingletonSwapRouter(launcher);
        hook.setCanonicalRouter(address(router));
        vault.setRewardNotifier(address(hook));
        token.configureSystemExclusions(address(launcher), address(hook), address(manager), address(router));
    }

    function testActualV4LaunchBuyFeeAndClaim() public {
        token.approve(address(launcher), token.INITIAL_SUPPLY());
        (PoolId launchedPoolId, uint128 liquidity) = launcher.launch();
        assertEq(PoolId.unwrap(launchedPoolId), PoolId.unwrap(hook.poolId()));
        assertGt(liquidity, 0);
        assertGt(launcher.launchDust(), 0);
        assertLt(launcher.launchDust(), launcher.launchDustLimit());
        assertEq(launcher.launchDust(), 12_264);
        assertEq(token.balanceOf(address(launcher)), 0);
        assertEq(token.balanceOf(address(this)), launcher.launchDust());
        assertEq(token.balanceOf(address(manager)), token.INITIAL_SUPPLY() - launcher.launchDust());
        assertEq(token.balanceOf(address(manager)) + token.balanceOf(address(this)), token.INITIAL_SUPPLY());
        assertEq(
            (token.balanceOf(address(manager)) + token.balanceOf(address(this))) / token.NFT_UNIT(),
            token.MAX_NFT_SUPPLY()
        );
        token.releaseInitialSupplyOwner();
        assertFalse(token.isExcluded(address(this)));
        assertEq(vault.eligibleUnitsOf(address(this)), 0);

        uint256 pipedogIn = 0.001 ether;
        uint256 minLaypipeOut = token.NFT_UNIT();
        _setPipedogBalance(TRADER, 1 ether);
        vm.prank(TRADER);
        pipedog.approve(address(router), pipedogIn);
        vm.prank(TRADER);
        uint256 bought = router.buy(pipedogIn, minLaypipeOut, TRADER, type(uint256).max);
        assertGe(bought, minLaypipeOut);
        assertGe(mirror.balanceOf(TRADER), 1);
        assertGe(vault.eligibleUnitsOf(TRADER), 1);

        uint256 expectedFee = pipedogIn / 100;
        assertEq(vault.totalRewardsNotified(), expectedFee);
        assertEq(manager.balanceOf(address(vault), vault.pipedogClaimId()), expectedFee);
        uint256 reward = vault.claimable(TRADER);
        assertLe(reward, expectedFee);
        assertLt(expectedFee - reward, vault.totalEligibleUnits());
        uint256 beforeClaim = pipedog.balanceOf(TRADER);
        vm.prank(TRADER);
        assertEq(vault.claim(), reward);
        assertEq(pipedog.balanceOf(TRADER), beforeClaim + reward);
        assertEq(manager.balanceOf(address(vault), vault.pipedogClaimId()), expectedFee - reward);
    }

    function _deployOrderedHybrid() private returns (LayPipeHybridToken deployed) {
        ForkCreate2Deployer create2Deployer = new ForkCreate2Deployer();
        bytes memory creationCode = abi.encodePacked(
            type(LayPipeHybridToken).creationCode,
            abi.encode(address(this), pipedog, manager, address(this), "ipfs://pipedogs/")
        );
        bytes32 hash = keccak256(creationCode);
        for (uint256 i; i < 20_000; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = create2Deployer.compute(salt, hash);
            if (predicted > address(pipedog)) {
                deployed = LayPipeHybridToken(payable(create2Deployer.deploy(salt, creationCode)));
                assertEq(address(deployed), predicted);
                return deployed;
            }
        }
        revert("ordered hybrid salt not found");
    }

    function _deployHook() private returns (PipeDogFeeHook deployed) {
        bytes memory args = abi.encode(manager, address(this), pipedog, ILayPipeRewardVault(address(vault)));
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), _requiredFlags(), type(PipeDogFeeHook).creationCode, args);
        deployed = new PipeDogFeeHook{salt: salt}(manager, address(this), pipedog, vault);
        assertEq(address(deployed), predicted);
        Hooks.validateHookPermissions(IHooks(address(deployed)), deployed.getHookPermissions());
    }

    function _requiredFlags() private pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }

    function _setPipedogBalance(address account, uint256 amount) private {
        vm.store(address(pipedog), keccak256(abi.encode(account, uint256(0))), bytes32(amount));
    }

    function _mockArbBlockNumber(uint256 number) private {
        vm.etch(ARBSYS, abi.encodePacked(hex"7f", bytes32(number), hex"60005260206000f3"));
    }
}
