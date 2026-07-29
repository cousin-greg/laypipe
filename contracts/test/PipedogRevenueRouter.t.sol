// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {
    PipedogRevenueRouter,
    IPipedogWETH9
} from "../src/PipedogRevenueRouter.sol";
import {
    MockERC20,
    MockWETH,
    MockV3Factory,
    MockV3Pool,
    RejectNative
} from "./mocks/RevenueRouterMocks.sol";

contract PipedogRevenueRouterTest is Test {
    uint24 internal constant FEE = 10_000;
    address internal constant TREASURY = address(0xA11CE);
    address internal constant OPERATIONS = address(0xB0B);
    address internal constant KEEPER = address(0xCA11);

    MockERC20 internal pipedog;
    MockWETH internal weth;
    MockV3Factory internal factory;
    MockV3Pool internal pool;
    PipedogRevenueRouter internal router;

    function setUp() public {
        pipedog = new MockERC20("Pipedog", "PIPEDOG");
        weth = new MockWETH();
        factory = new MockV3Factory();
        pool = new MockV3Pool(
            address(weth),
            address(pipedog),
            FEE,
            address(factory),
            pipedog,
            true
        );
        factory.configure(address(weth), address(pipedog), FEE, address(pool));
        pipedog.mint(address(pool), 1_000_000_000 ether);

        router = new PipedogRevenueRouter(
            IUniswapV3Pool(address(pool)),
            IUniswapV3Factory(address(factory)),
            FEE,
            IERC20(address(pipedog)),
            IPipedogWETH9(address(weth)),
            TREASURY,
            OPERATIONS,
            0.1 ether,
            0.1 ether,
            address(this)
        );
        vm.deal(address(this), 100 ether);
    }

    function testAllocateUsesImmutable252550PolicyAndEveryWei() public {
        _fund(1 ether + 3);
        router.allocate();

        assertEq(router.sequesterTank(), 0.25 ether);
        assertEq(router.treasuryBuyTank(), 0.25 ether);
        assertEq(router.operationsTab(), 0.5 ether + 3);
        assertEq(router.totalRevenueAllocated(), 1 ether + 3);
        assertEq(router.unallocated(), 0);
    }

    function testBuyLanesPayBountyAndDoNotReducePipedogSupply() public {
        _fund(1 ether);
        uint256 supplyBefore = pipedog.totalSupply();

        vm.prank(KEEPER);
        uint256 sequestered = router.buyAndSequester();
        assertEq(sequestered, 0.198 ether);
        assertEq(
            pipedog.balanceOf(router.SEQUESTER_SINK()), 0.198 ether
        );
        assertEq(KEEPER.balance, 0.001 ether);
        assertEq(router.sequesterTank(), 0.15 ether);
        assertEq(router.totalEthSequestered(), 0.099 ether);

        vm.prank(KEEPER);
        uint256 treasuryBought = router.buyForTreasury();
        assertEq(treasuryBought, 0.198 ether);
        assertEq(pipedog.balanceOf(TREASURY), 0.198 ether);
        assertEq(KEEPER.balance, 0.002 ether);
        assertEq(router.treasuryBuyTank(), 0.15 ether);

        // The sink grows, but PIPEDOG itself has no burn() in this path.
        assertEq(pipedog.totalSupply(), supplyBefore);
        assertEq(router.totalKeeperBounties(), 0.002 ether);
    }

    function testBountyBoundaryChunkEndingInNinetyNineCannotOverdraw()
        public
    {
        router.setMaxSequesterPerCall(199);
        _fund(796); // 25% lane is exactly the 199-wei boundary chunk
        vm.prank(KEEPER);
        assertEq(router.buyAndSequester(), 396);
        assertEq(router.totalEthSequestered(), 198);
        assertEq(router.totalKeeperBounties(), 1);
        assertEq(router.sequesterTank(), 0);
    }

    function testFuzzFullFillBountyNeverExceedsGrossChunk(uint96 seed)
        public
    {
        uint256 chunk = bound(uint256(seed), 1, 10 ether);
        router.setMaxSequesterPerCall(chunk);
        _fund(chunk * 4);

        vm.prank(KEEPER);
        router.buyAndSequester();

        assertLe(
            router.totalEthSequestered()
                + router.totalKeeperBounties(),
            chunk
        );
        assertEq(
            address(router).balance,
            router.sequesterTank() + router.treasuryBuyTank()
                + router.operationsTab()
        );
    }

    function testEachBuyLaneCanRunOnlyOncePerBlock() public {
        _fund(2 ether);
        vm.prank(KEEPER);
        router.buyAndSequester();
        vm.expectRevert(
            PipedogRevenueRouter.AlreadyProcessedThisBlock.selector
        );
        vm.prank(KEEPER);
        router.buyAndSequester();

        // The independent treasury lane is still available in this block.
        vm.prank(KEEPER);
        router.buyForTreasury();
        vm.expectRevert(
            PipedogRevenueRouter.AlreadyProcessedThisBlock.selector
        );
        vm.prank(KEEPER);
        router.buyForTreasury();

        vm.roll(block.number + 1);
        vm.prank(KEEPER);
        router.buyAndSequester();
    }

    function testOperationsCollectionIsPermissionlessButDestinationFixed()
        public
    {
        _fund(1 ether);
        uint256 beforeBalance = OPERATIONS.balance;
        vm.prank(KEEPER);
        uint256 paid = router.collectOperations();
        assertEq(paid, 0.5 ether);
        assertEq(OPERATIONS.balance - beforeBalance, 0.5 ether);
        assertEq(router.totalOperationsCollected(), 0.5 ether);
    }

    function testPauseStopsMarketOrdersButNotOperationsCollection() public {
        _fund(1 ether);
        router.pause();
        vm.expectRevert();
        router.buyAndSequester();
        assertEq(router.collectOperations(), 0.5 ether);
        router.unpause();
        router.buyAndSequester();
    }

    function testOnlyOwnerCanChangeDestinationsCapsAndMigrate() public {
        vm.startPrank(KEEPER);
        vm.expectRevert();
        router.setTreasury(address(1));
        vm.expectRevert();
        router.setOperationsWallet(address(1));
        vm.expectRevert();
        router.setMaxSequesterPerCall(1);
        vm.expectRevert();
        router.migrate(address(1));
        vm.stopPrank();

        router.setTreasury(address(0x1234));
        router.setOperationsWallet(address(0x5678));
        router.setMaxSequesterPerCall(0.2 ether);
        router.setMaxTreasuryBuyPerCall(0.3 ether);
        assertEq(router.treasury(), address(0x1234));
        assertEq(router.operationsWallet(), address(0x5678));
    }

    function testCallbackRejectsOutsiderAndCanonicalPoolOutsideSwap()
        public
    {
        vm.expectRevert(PipedogRevenueRouter.NotPool.selector);
        router.uniswapV3SwapCallback(1, -1, "");

        vm.prank(address(pool));
        vm.expectRevert(PipedogRevenueRouter.NotActiveSwap.selector);
        router.uniswapV3SwapCallback(1, -1, "");
    }

    function testMaliciousPoolCannotOverdrawOrDoubleCallback() public {
        _fund(2 ether);
        pool.setMode(MockV3Pool.Mode.OVERCHARGE);
        vm.expectRevert(PipedogRevenueRouter.SwapInputTooHigh.selector);
        router.buyAndSequester();

        pool.setMode(MockV3Pool.Mode.DOUBLE_CALLBACK);
        vm.roll(block.number + 1);
        vm.expectRevert(PipedogRevenueRouter.SwapInputTooHigh.selector);
        router.buyAndSequester();
    }

    function testWrongDeltaReturnMismatchAndEmptyOutputRevert() public {
        _fund(3 ether);

        pool.setMode(MockV3Pool.Mode.WRONG_SIGN);
        vm.expectRevert(PipedogRevenueRouter.InvalidSwapDelta.selector);
        router.buyAndSequester();

        pool.setMode(MockV3Pool.Mode.RETURN_MISMATCH);
        vm.roll(block.number + 1);
        vm.expectRevert(PipedogRevenueRouter.InvalidSwapDelta.selector);
        router.buyAndSequester();

        pool.setMode(MockV3Pool.Mode.EMPTY_OUTPUT);
        vm.roll(block.number + 1);
        vm.expectRevert(PipedogRevenueRouter.InvalidSwapDelta.selector);
        router.buyAndSequester();
    }

    function testConstructorRejectsNonCanonicalPool() public {
        MockV3Factory wrongFactory = new MockV3Factory();
        wrongFactory.configure(
            address(weth), address(pipedog), FEE, address(0xBAD)
        );
        vm.expectRevert(PipedogRevenueRouter.InvalidPool.selector);
        new PipedogRevenueRouter(
            IUniswapV3Pool(address(pool)),
            IUniswapV3Factory(address(wrongFactory)),
            FEE,
            IERC20(address(pipedog)),
            IPipedogWETH9(address(weth)),
            TREASURY,
            OPERATIONS,
            1,
            1,
            address(this)
        );
    }

    function testRevertingOperationsWalletDoesNotBlockBuyLanes() public {
        RejectNative rejector = new RejectNative();
        router.setOperationsWallet(address(rejector));
        _fund(1 ether);
        vm.expectRevert(PipedogRevenueRouter.NativeTransferFailed.selector);
        router.collectOperations();

        router.buyAndSequester();
        assertEq(
            pipedog.balanceOf(router.SEQUESTER_SINK()), 0.198 ether
        );
    }

    function _fund(uint256 amount) internal {
        (bool ok,) = address(router).call{value: amount}("");
        assertTrue(ok);
    }

    receive() external payable {}
}

contract RevenueRouterHandler {
    PipedogRevenueRouter public immutable router;

    constructor(PipedogRevenueRouter router_) {
        router = router_;
    }

    function deposit(uint96 seed) external {
        uint256 amount = uint256(seed) % 2 ether;
        if (amount == 0 || address(this).balance < amount) return;
        (bool ok,) = address(router).call{value: amount}("");
        require(ok);
    }

    function allocate() external {
        router.allocate();
    }

    function sequester() external {
        try router.buyAndSequester() {} catch {}
    }

    function treasuryBuy() external {
        try router.buyForTreasury() {} catch {}
    }

    function collectOperations() external {
        try router.collectOperations() {} catch {}
    }

    receive() external payable {}
}

contract PipedogRevenueRouterInvariantTest is StdInvariant, Test {
    PipedogRevenueRouter internal router;
    RevenueRouterHandler internal handler;

    function setUp() public {
        MockERC20 pipedog = new MockERC20("Pipedog", "PIPEDOG");
        MockWETH weth = new MockWETH();
        MockV3Factory factory = new MockV3Factory();
        MockV3Pool pool = new MockV3Pool(
            address(weth),
            address(pipedog),
            10_000,
            address(factory),
            pipedog,
            true
        );
        factory.configure(
            address(weth), address(pipedog), 10_000, address(pool)
        );
        pipedog.mint(address(pool), type(uint128).max);

        router = new PipedogRevenueRouter(
            IUniswapV3Pool(address(pool)),
            IUniswapV3Factory(address(factory)),
            10_000,
            IERC20(address(pipedog)),
            IPipedogWETH9(address(weth)),
            address(0xA11CE),
            address(0xB0B),
            0.1 ether,
            0.1 ether,
            address(this)
        );
        handler = new RevenueRouterHandler(router);
        vm.deal(address(handler), 10_000 ether);
        targetContract(address(handler));
    }

    function invariantEveryAllocatedWeiIsPresentOrAccountedAsOutflow()
        public
        view
    {
        uint256 left =
            router.totalRevenueAllocated() + router.unallocated();
        uint256 right = address(router).balance
            + router.totalEthSequestered()
            + router.totalEthTreasuryBought()
            + router.totalOperationsCollected()
            + router.totalKeeperBounties() + router.totalMigrated();
        assertEq(left, right);
    }

    function invariantPotsNeverExceedBalance() public view {
        uint256 pots = router.sequesterTank() + router.treasuryBuyTank()
            + router.operationsTab();
        assertLe(pots, address(router).balance);
    }

    function invariantRevenueSharesAreImmutable() public view {
        assertEq(router.SEQUESTER_SHARE_BPS(), 2_500);
        assertEq(router.TREASURY_BUY_SHARE_BPS(), 2_500);
        assertEq(router.OPERATIONS_SHARE_BPS(), 5_000);
    }
}
