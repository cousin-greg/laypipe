// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PreflightRobinhood} from
    "../script/PreflightRobinhood.s.sol";
import {PipedogRevenueRouter} from
    "../src/PipedogRevenueRouter.sol";
import {PipedogProtocolConfig} from
    "../src/PipedogProtocolConfig.sol";

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

    address internal constant DEPOSITOR = address(0xD3F0517);
    address internal constant KEEPER = address(0xCA11);
    address internal constant TREASURY = address(0x7EA5);
    address internal constant OPERATIONS = address(0x0B5);

    function setUp() public {
        vm.createSelectFork(
            vm.envOr(
                "ROBINHOOD_RPC_URL",
                string("https://rpc.mainnet.chain.robinhood.com")
            ),
            vm.envOr("ROBINHOOD_FORK_BLOCK", DEFAULT_FORK_BLOCK)
        );
    }

    function testCanonicalPipedogPreflightPasses() public {
        new PreflightRobinhood().validate();
    }

    function testCanonicalPipedogExactAllowanceAndDirectRouting()
        public
    {
        IERC20 pipedog = IERC20(PipedogProtocolConfig.PIPEDOG);
        uint256 supplyBefore = pipedog.totalSupply();
        // The preflight pins the exact non-proxy PIPEDOG bytecode. Its OZ
        // balances mapping is slot zero; direct fork storage avoids this
        // public RPC's broken response to Foundry's slot-discovery probes.
        vm.store(
            address(pipedog),
            keccak256(abi.encode(DEPOSITOR, uint256(0))),
            bytes32(uint256(1 ether))
        );

        PipedogRevenueRouter router =
            new PipedogRevenueRouter(
                pipedog,
                TREASURY,
                OPERATIONS,
                1 ether,
                1 ether,
                100,
                address(this)
            );
        _setPipedogBalance(address(router), 0);
        _setPipedogBalance(router.SEQUESTER_SINK(), 0);
        _setPipedogBalance(KEEPER, 0);
        _setPipedogBalance(TREASURY, 0);
        _setPipedogBalance(OPERATIONS, 0);
        _setPipedogAllowance(DEPOSITOR, address(router), 0);
        vm.prank(DEPOSITOR);
        pipedog.approve(address(router), 1 ether);
        vm.prank(DEPOSITOR);
        router.deposit(1 ether);
        assertEq(pipedog.allowance(DEPOSITOR, address(router)), 0);

        uint256 sinkBefore =
            pipedog.balanceOf(router.SEQUESTER_SINK());
        vm.prank(KEEPER);
        uint256 sequestered = router.sequesterPipedog();
        vm.prank(KEEPER);
        uint256 treasuryRouted =
            router.routeTreasuryPipedog();
        uint256 operationsPaid = router.collectOperations();

        assertEq(sequestered, 0.2475 ether);
        assertEq(treasuryRouted, 0.2475 ether);
        assertEq(operationsPaid, 0.5 ether);
        assertEq(
            pipedog.balanceOf(router.SEQUESTER_SINK())
                - sinkBefore,
            sequestered
        );
        assertEq(pipedog.balanceOf(TREASURY), treasuryRouted);
        assertEq(pipedog.balanceOf(OPERATIONS), operationsPaid);
        assertEq(pipedog.balanceOf(KEEPER), 0.005 ether);
        assertEq(pipedog.balanceOf(address(router)), 0);
        assertEq(pipedog.totalSupply(), supplyBefore);
    }

    /// @dev Differential reference only. These deployed LetsCash contracts
    /// still describe the original native-asset system; they are not Laypipe
    /// deployment dependencies and their 204200 tick is not endorsed.
    function testReferenceLetsCashObservablePolicySnapshot()
        public
        view
    {
        ILiveLetsCashFactory live = ILiveLetsCashFactory(LIVE_FACTORY);
        assertEq(live.launchFee(), 0.0005 ether);
        assertTrue(live.launchEnabled());
        assertFalse(live.dividendLaunchEnabled());
        assertGe(live.launchConfigCount(), 18);
        assertEq(live.hook(), LIVE_HOOK);
        assertEq(
            address(live.poolManager()),
            PipedogProtocolConfig.POOL_MANAGER
        );
        assertEq(live.selfBurner(), LIVE_SELF_BURNER);
        assertEq(
            live.dividendDistributor(),
            LIVE_DIVIDEND_DISTRIBUTOR
        );
        assertEq(live.treasury(), LIVE_REVENUE_SPLITTER);

        _assertReferenceConfig(live.getLaunchConfig(16), false);
        _assertReferenceConfig(live.getLaunchConfig(17), true);

        ILiveLetsCashHook liveHook = ILiveLetsCashHook(LIVE_HOOK);
        assertEq(liveHook.factory(), LIVE_FACTORY);
        assertEq(
            address(liveHook.poolManager()),
            PipedogProtocolConfig.POOL_MANAGER
        );
        assertEq(liveHook.treasury(), LIVE_REVENUE_SPLITTER);

        uint160 expectedFlags = Hooks.BEFORE_INITIALIZE_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
        assertEq(
            uint160(LIVE_HOOK) & Hooks.ALL_HOOK_MASK,
            expectedFlags
        );
    }

    function _assertReferenceConfig(
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

    function _setPipedogBalance(address account, uint256 amount)
        private
    {
        vm.store(
            PipedogProtocolConfig.PIPEDOG,
            keccak256(abi.encode(account, uint256(0))),
            bytes32(amount)
        );
    }

    function _setPipedogAllowance(
        address owner,
        address spender,
        uint256 amount
    ) private {
        bytes32 ownerSlot =
            keccak256(abi.encode(owner, uint256(1)));
        vm.store(
            PipedogProtocolConfig.PIPEDOG,
            keccak256(abi.encode(spender, ownerSlot)),
            bytes32(amount)
        );
    }
}
