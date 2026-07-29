// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IUniswapV3Pool} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {PreflightRobinhood} from "../script/PreflightRobinhood.s.sol";
import {
    PipedogRevenueRouter,
    IPipedogWETH9
} from "../src/PipedogRevenueRouter.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";

interface ILiveLetsCashFactory {
    struct LaunchConfig {
        uint256 supply;
        int24 tickSpacing;
        int24 startTick;
        uint16 creatorFeeBps;
        uint24 baseFeeRate;
        uint24 launchFeeRate;
        uint32 launchFeeDecay;
        bool enabled;
        bool selfBurn;
    }

    function launchFee() external view returns (uint256);
    function launchEnabled() external view returns (bool);
    function dividendLaunchEnabled() external view returns (bool);
    function launchConfigCount() external view returns (uint256);
    function getLaunchConfig(uint256 id)
        external
        view
        returns (LaunchConfig memory);
    function hook() external view returns (address);
    function poolManager() external view returns (IPoolManager);
    function selfBurner() external view returns (address);
    function dividendDistributor() external view returns (address);
    function treasury() external view returns (address);
}

interface ILiveLetsCashHook {
    function factory() external view returns (address);
    function poolManager() external view returns (IPoolManager);
    function treasury() external view returns (address);
}

contract RobinhoodPreflightTest is Test {
    uint256 internal constant DEFAULT_FORK_BLOCK = 22_642_189;
    address internal constant LIVE_FACTORY =
        0x5bd1Fbe78a78fe8236fa00CF48fbEBA74ae34661;
    address internal constant LIVE_HOOK =
        0xEfe669814e5Eec33406Bd50ffa8331618D076aEc;
    address internal constant LIVE_SELF_BURNER =
        0x580C70D2234a579B2631593693c66caE3886A98E;
    address internal constant LIVE_DIVIDEND_DISTRIBUTOR =
        0xCa8B8e3ffE1f48A3555059AacBb962BFB668f522;
    address internal constant LIVE_REVENUE_SPLITTER =
        0x6D3d822F6e625c59804F47cf2Cc1d53B8301016F;
    address internal constant POOL_MANAGER =
        0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function setUp() public {
        vm.createSelectFork(
            vm.envOr(
                "ROBINHOOD_RPC_URL",
                string("https://rpc.mainnet.chain.robinhood.com")
            ),
            vm.envOr("ROBINHOOD_FORK_BLOCK", DEFAULT_FORK_BLOCK)
        );
    }

    function testCanonicalPipedogPoolPreflightPasses() public {
        new PreflightRobinhood().validate();
    }

    function testLiveFactoryObservablePolicyMatchesCleanRoomTarget()
        public
        view
    {
        ILiveLetsCashFactory live = ILiveLetsCashFactory(LIVE_FACTORY);
        assertEq(live.launchFee(), 0.0005 ether);
        assertTrue(live.launchEnabled());
        assertFalse(live.dividendLaunchEnabled());
        assertGe(live.launchConfigCount(), 18);
        assertEq(live.hook(), LIVE_HOOK);
        assertEq(address(live.poolManager()), POOL_MANAGER);
        assertEq(live.selfBurner(), LIVE_SELF_BURNER);
        assertEq(
            live.dividendDistributor(), LIVE_DIVIDEND_DISTRIBUTOR
        );
        assertEq(live.treasury(), LIVE_REVENUE_SPLITTER);

        _assertConfig(live.getLaunchConfig(16), false);
        _assertConfig(live.getLaunchConfig(17), true);

        ILiveLetsCashHook liveHook = ILiveLetsCashHook(LIVE_HOOK);
        assertEq(liveHook.factory(), LIVE_FACTORY);
        assertEq(address(liveHook.poolManager()), POOL_MANAGER);
        assertEq(liveHook.treasury(), LIVE_REVENUE_SPLITTER);

        uint160 expectedFlags = Hooks.BEFORE_INITIALIZE_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        assertEq(
            uint160(LIVE_HOOK) & Hooks.ALL_HOOK_MASK, expectedFlags
        );
    }

    function testRevenueRouterBuysCanonicalPipedogIntoDeadSinkWithoutBurningSupply()
        public
    {
        address keeper = address(0xCA11);
        PipedogRevenueRouter router = new PipedogRevenueRouter(
            IUniswapV3Pool(
                PipedogProtocolConfig.PIPEDOG_WETH_V3_POOL
            ),
            IUniswapV3Factory(
                PipedogProtocolConfig.UNISWAP_V3_FACTORY
            ),
            PipedogProtocolConfig.PIPEDOG_WETH_V3_FEE,
            IERC20(PipedogProtocolConfig.PIPEDOG),
            IPipedogWETH9(PipedogProtocolConfig.WETH),
            address(0xA11CE),
            address(0xB0B),
            0.001 ether,
            0.001 ether,
            address(this)
        );

        vm.deal(address(this), 0.004 ether);
        (bool funded,) =
            address(router).call{value: 0.004 ether}("");
        assertTrue(funded);

        IERC20 pipedog = IERC20(PipedogProtocolConfig.PIPEDOG);
        uint256 sinkBefore =
            pipedog.balanceOf(router.SEQUESTER_SINK());
        uint256 supplyBefore = pipedog.totalSupply();
        uint256 keeperBefore = keeper.balance;

        vm.prank(keeper);
        uint256 bought = router.buyAndSequester();

        assertGt(bought, 0);
        assertEq(
            pipedog.balanceOf(router.SEQUESTER_SINK()) - sinkBefore,
            bought
        );
        assertEq(pipedog.totalSupply(), supplyBefore);
        assertEq(router.totalPipedogSequestered(), bought);
        assertGt(router.totalEthSequestered(), 0);
        assertEq(pipedog.balanceOf(address(router)), 0);
        assertGt(keeper.balance - keeperBefore, 0);
        assertEq(
            address(router).balance,
            router.sequesterTank() + router.treasuryBuyTank()
                + router.operationsTab()
        );
    }

    function _assertConfig(
        ILiveLetsCashFactory.LaunchConfig memory config,
        bool selfBurn
    ) private pure {
        assertEq(config.supply, 1_000_000_000 ether);
        assertEq(config.tickSpacing, 200);
        assertEq(config.startTick, 204_200);
        assertEq(config.creatorFeeBps, 7_000);
        assertEq(config.baseFeeRate, 10_000);
        assertEq(config.launchFeeRate, 10_000);
        assertEq(config.launchFeeDecay, 0);
        assertTrue(config.enabled);
        assertEq(config.selfBurn, selfBurn);
    }
}
