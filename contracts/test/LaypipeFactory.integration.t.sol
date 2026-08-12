// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from
    "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from
    "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "v4-core/src/test/PoolDonateTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {LaypipeFactory} from "../src/LaypipeFactory.sol";
import {LaypipeToken} from "../src/LaypipeToken.sol";
import {PipedogHook} from "../src/PipedogHook.sol";
import {LaypipeSelfBurner} from "../src/LaypipeSelfBurner.sol";
import {LaypipeSwapRouter} from "../src/LaypipeSwapRouter.sol";
import {PipedogRevenueRouter} from "../src/PipedogRevenueRouter.sol";
import {PipedogProtocolConfig} from "../src/PipedogProtocolConfig.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";
import {MockERC20} from "./mocks/RevenueRouterMocks.sol";

contract ForceNative {
    constructor() payable {}

    function force(address payable target) external {
        selfdestruct(target);
    }
}

contract LaypipeFactoryIntegrationTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant DEFAULT_FORK_BLOCK = 22_709_000;
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant LAUNCH_FEE = 0.0005 ether;
    uint256 internal constant ROUTE_CAP = 1 ether;
    uint256 internal constant SELF_BURN_CAP = 0.01 ether;
    uint16 internal constant BOUNTY_BPS = 100;
    address internal constant ARBSYS =
        0x0000000000000000000000000000000000000064;
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant BOUNDARY_START_TICK = 887_200;
    // Reference-only legacy calibration. CurveEconomics.t.sol documents why
    // this is economically unsafe as a production default.
    int24 internal constant START_TICK = 204_200;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant TRADER = address(0xB0B);
    address internal constant NEW_CREATOR = address(0xA11CE);
    address internal constant KEEPER = address(0xCA11);
    address internal constant PROTOCOL_TREASURY = address(0x7EA5);
    address internal constant OPERATIONS = address(0x0B5);

    IPoolManager internal manager;
    IERC20 internal pipedog;
    PipedogRevenueRouter internal revenueRouter;
    LaypipeFactory internal factory;
    LaypipeToken internal tokenImplementation;
    PipedogHook internal hook;
    LaypipeSelfBurner internal selfBurner;
    LaypipeSwapRouter internal swapRouter;
    PoolSwapTest internal exactOutputRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolDonateTest internal donateRouter;

    function setUp() public {
        _mockArbBlockNumber(1);
        vm.makePersistent(ARBSYS);
        vm.createSelectFork(
            vm.envOr(
                "ROBINHOOD_RPC_URL",
                string("https://rpc.mainnet.chain.robinhood.com")
            ),
            DEFAULT_FORK_BLOCK
        );
        _mockArbBlockNumber(block.number);
        manager = IPoolManager(PipedogProtocolConfig.POOL_MANAGER);
        pipedog = IERC20(PipedogProtocolConfig.PIPEDOG);

        LaypipeFactory implementation = new LaypipeFactory();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                LaypipeFactory.initialize,
                (
                    manager,
                    pipedog,
                    address(revenueRouter),
                    address(this),
                    LAUNCH_FEE
                )
            )
        );
        factory = LaypipeFactory(address(proxy));
        _setPipedogBalance(address(factory), 0);

        revenueRouter = new PipedogRevenueRouter(
            pipedog,
            address(factory),
            PROTOCOL_TREASURY,
            OPERATIONS,
            ROUTE_CAP,
            ROUTE_CAP,
            BOUNTY_BPS,
            address(this)
        );
        _setPipedogBalance(address(revenueRouter), 0);
        _setPipedogBalance(revenueRouter.SEQUESTER_SINK(), 0);
        _setPipedogBalance(PROTOCOL_TREASURY, 0);
        _setPipedogBalance(OPERATIONS, 0);
        factory.setTreasury(address(revenueRouter));

        tokenImplementation = new LaypipeToken();

        hook = _deployHook(address(revenueRouter));
        _setPipedogBalance(address(hook), 0);
        factory.setHook(hook);
        factory.setTokenImplementation(tokenImplementation);

        selfBurner = new LaypipeSelfBurner(
            manager,
            hook,
            address(factory),
            SELF_BURN_CAP,
            BOUNTY_BPS
        );
        _setPipedogBalance(address(selfBurner), 0);
        factory.setSelfBurner(selfBurner);
        swapRouter = new LaypipeSwapRouter(manager, pipedog, hook);
        exactOutputRouter = new PoolSwapTest(manager);
        _setPipedogBalance(address(swapRouter), 0);
        _setPipedogBalance(address(exactOutputRouter), 0);

        factory.addLaunchConfig(_config(false));
        factory.addLaunchConfig(_config(true));
        factory.setLaunchEnabled(true);

        liquidityRouter = new PoolModifyLiquidityTest(manager);
        donateRouter = new PoolDonateTest(manager);

        _setPipedogBalance(CREATOR, 100 ether);
        _setPipedogBalance(TRADER, 100 ether);
        _setPipedogBalance(NEW_CREATOR, 0);
        _setPipedogBalance(KEEPER, 0);
        _setPipedogAllowance(CREATOR, address(factory), 0);
        _setPipedogAllowance(TRADER, address(swapRouter), 0);
        _setPipedogAllowance(
            TRADER, address(exactOutputRouter), 0
        );
        vm.deal(CREATOR, 1 ether);
        vm.deal(address(this), 2 ether);
    }

    function testLaunchUsesPermanentPipedogPairAndLockedOneSidedSeed()
        public
    {
        uint256 managerQuoteBefore =
            pipedog.balanceOf(address(manager));
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 0, 0);

        assertEq(
            Currency.unwrap(key.currency0),
            PipedogProtocolConfig.PIPEDOG
        );
        assertEq(Currency.unwrap(key.currency1), address(token));
        assertGt(
            uint256(uint160(address(token))),
            uint256(uint160(PipedogProtocolConfig.PIPEDOG))
        );
        assertEq(uint8(uint160(address(token))), 0xcc);
        assertTrue(hook.isRegistered(poolId));

        (uint160 sqrtPriceX96, int24 tick,,) =
            manager.getSlot0(poolId);
        assertEq(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(START_TICK)
        );
        assertEq(tick, START_TICK);
        (uint128 positionLiquidity,,) = manager.getPositionInfo(
            poolId,
            address(factory),
            TickMath.minUsableTick(TICK_SPACING),
            START_TICK,
            bytes32(0)
        );
        assertGt(positionLiquidity, 0);
        assertEq(
            pipedog.balanceOf(address(manager)), managerQuoteBefore
        );
        assertEq(
            token.balanceOf(address(manager)), token.totalSupply()
        );
        assertEq(token.balanceOf(address(factory)), 0);
        assertTrue(hook.seeded(poolId));
        assertEq(pipedog.balanceOf(address(revenueRouter)), LAUNCH_FEE);

        ModifyLiquidityParams memory removeParams =
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: START_TICK,
                liquidityDelta: -1,
                salt: bytes32(0)
            });
        // PoolManager wraps hook callback errors; any successful removal
        // would violate the permanent-venue invariant asserted below.
        vm.expectRevert();
        liquidityRouter.modifyLiquidity(key, removeParams, "");

        ModifyLiquidityParams memory addParams = ModifyLiquidityParams({
            tickLower: TickMath.minUsableTick(TICK_SPACING),
            tickUpper: START_TICK,
            liquidityDelta: 1,
            salt: bytes32(uint256(1))
        });
        vm.expectRevert();
        liquidityRouter.modifyLiquidity(key, addParams, "");

        vm.expectRevert();
        donateRouter.donate(key, 0, 1, "");
    }

    function testLaunchRequiresExactAllowanceAndRejectsNativeValue()
        public
    {
        LaypipeFactory.TokenParams memory params = _params();
        (bytes32 salt,) =
            factory.mineSalt(params, 0, CREATOR, 1, 16_384);

        vm.prank(CREATOR);
        pipedog.approve(address(factory), LAUNCH_FEE - 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaypipeFactory.QuoteAllowanceMismatch.selector,
                LAUNCH_FEE,
                LAUNCH_FEE - 1
            )
        );
        vm.prank(CREATOR);
        factory.launch(params, 0, 0, 0, salt);

        vm.prank(CREATOR);
        pipedog.approve(address(factory), LAUNCH_FEE + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaypipeFactory.QuoteAllowanceMismatch.selector,
                LAUNCH_FEE,
                LAUNCH_FEE + 1
            )
        );
        vm.prank(CREATOR);
        factory.launch(params, 0, 0, 0, salt);

        vm.prank(CREATOR);
        pipedog.approve(address(factory), LAUNCH_FEE);
        vm.prank(CREATOR);
        (bool ok,) = address(factory).call{value: 1}(
            abi.encodeCall(
                LaypipeFactory.launch,
                (params, 0, 0, 0, salt)
            )
        );
        assertFalse(ok);
        assertEq(
            pipedog.allowance(CREATOR, address(factory)), LAUNCH_FEE
        );

        vm.prank(CREATOR);
        factory.launch(params, 0, 0, 0, salt);
        assertEq(pipedog.allowance(CREATOR, address(factory)), 0);
    }

    function testFirstBuyMinOutRevertsAtomicallyThenSucceeds()
        public
    {
        LaypipeFactory.TokenParams memory params = _params();
        (bytes32 salt, address predicted) =
            factory.mineSalt(params, 0, CREATOR, 20_000, 16_384);
        uint256 firstBuy = 0.01 ether;
        uint256 creatorBefore = pipedog.balanceOf(CREATOR);

        vm.prank(CREATOR);
        pipedog.approve(address(factory), LAUNCH_FEE + firstBuy);
        vm.expectRevert(LaypipeFactory.FirstBuySlippage.selector);
        vm.prank(CREATOR);
        factory.launch(
            params, 0, firstBuy, type(uint256).max, salt
        );

        assertEq(pipedog.balanceOf(CREATOR), creatorBefore);
        assertEq(
            pipedog.allowance(CREATOR, address(factory)),
            LAUNCH_FEE + firstBuy
        );

        vm.prank(CREATOR);
        (address tokenAddress,) =
            factory.launch(params, 0, firstBuy, 1, salt);
        assertEq(tokenAddress, predicted);
        assertGt(IERC20(tokenAddress).balanceOf(CREATOR), 0);
        assertEq(
            pipedog.balanceOf(CREATOR),
            creatorBefore - LAUNCH_FEE - firstBuy
        );
        assertEq(pipedog.allowance(CREATOR, address(factory)), 0);
        assertEq(pipedog.balanceOf(address(factory)), 0);
    }

    function testBuySellUseExactApprovalsAndPipedogOutput() public {
        (LaypipeToken token,, PoolKey memory key) =
            _launch(0, 0, 40_000, 0);
        uint256 quoteIn = 0.01 ether;
        uint256 traderQuoteBefore = pipedog.balanceOf(TRADER);

        vm.prank(TRADER);
        pipedog.approve(address(swapRouter), quoteIn + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaypipeSwapRouter.AllowanceMismatch.selector,
                quoteIn,
                quoteIn + 1
            )
        );
        vm.prank(TRADER);
        swapRouter.buy(key, quoteIn, 1, TRADER, type(uint256).max);
        assertEq(
            pipedog.allowance(TRADER, address(swapRouter)),
            quoteIn + 1
        );

        vm.prank(TRADER);
        pipedog.approve(address(swapRouter), quoteIn);
        vm.prank(TRADER);
        uint256 bought =
            swapRouter.buy(key, quoteIn, 1, TRADER, type(uint256).max);
        assertGt(bought, 0);
        assertEq(
            pipedog.balanceOf(TRADER),
            traderQuoteBefore - quoteIn
        );
        assertEq(pipedog.allowance(TRADER, address(swapRouter)), 0);
        assertEq(pipedog.balanceOf(address(swapRouter)), 0);
        assertEq(token.balanceOf(address(swapRouter)), 0);

        uint256 sellAmount = bought / 3;
        uint256 quoteBeforeSell = pipedog.balanceOf(TRADER);
        vm.prank(TRADER);
        token.approve(address(swapRouter), sellAmount + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaypipeSwapRouter.AllowanceMismatch.selector,
                sellAmount,
                sellAmount + 1
            )
        );
        vm.prank(TRADER);
        swapRouter.sell(key, sellAmount, 1, TRADER, type(uint256).max);
        assertEq(
            token.allowance(TRADER, address(swapRouter)),
            sellAmount + 1
        );

        vm.prank(TRADER);
        token.approve(address(swapRouter), sellAmount);
        vm.prank(TRADER);
        uint256 quoteOut =
            swapRouter.sell(key, sellAmount, 1, TRADER, type(uint256).max);
        assertGt(quoteOut, 0);
        assertEq(
            pipedog.balanceOf(TRADER),
            quoteBeforeSell + quoteOut
        );
        assertEq(token.allowance(TRADER, address(swapRouter)), 0);
        assertEq(pipedog.balanceOf(address(swapRouter)), 0);
        assertEq(token.balanceOf(address(swapRouter)), 0);
    }

    function testExactOutputBuyChargesFeeOnUnspecifiedPipedog()
        public
    {
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 50_000, 0);
        uint256 requestedTokensOut = 1_000_000 ether;
        uint256 quoteBefore = pipedog.balanceOf(TRADER);
        uint256 tokenBefore = token.balanceOf(TRADER);

        vm.prank(TRADER);
        pipedog.approve(address(exactOutputRouter), 1 ether);
        vm.prank(TRADER);
        BalanceDelta delta = exactOutputRouter.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: int256(requestedTokensOut),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({
                takeClaims: false,
                settleUsingBurn: false
            }),
            ""
        );

        assertLt(delta.amount0(), 0);
        assertEq(
            uint256(uint128(delta.amount1())),
            requestedTokensOut
        );
        uint256 totalQuoteSpent =
            uint256(uint128(-delta.amount0()));
        uint256 fee = hook.pending(poolId);
        uint256 poolQuoteInput = totalQuoteSpent - fee;
        uint256 rate = hook.currentFeeRate(poolId, TRADER);
        assertEq(
            fee,
            (
                totalQuoteSpent * rate
                    + hook.FEE_DENOMINATOR() - 1
            ) / hook.FEE_DENOMINATOR()
        );
        assertEq(totalQuoteSpent, poolQuoteInput + fee);
        assertEq(
            pipedog.balanceOf(TRADER),
            quoteBefore - totalQuoteSpent
        );
        assertEq(
            token.balanceOf(TRADER),
            tokenBefore + requestedTokensOut
        );
        _assertSweepAndCreatorClaim(poolId, fee);
    }

    function testExactOutputSellChargesFeeOnSpecifiedPipedog()
        public
    {
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 55_000, 0);
        _buy(key, 0.01 ether, TRADER);
        uint256 setupFee = hook.pending(poolId);
        _assertSweepAndCreatorClaim(poolId, setupFee);
        assertEq(hook.pending(poolId), 0);

        uint256 requestedPipedogOut = 0.001 ether;
        uint256 quoteBefore = pipedog.balanceOf(TRADER);
        uint256 tokenBefore = token.balanceOf(TRADER);
        vm.prank(TRADER);
        token.approve(
            address(exactOutputRouter), tokenBefore
        );
        vm.prank(TRADER);
        BalanceDelta delta = exactOutputRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(requestedPipedogOut),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({
                takeClaims: false,
                settleUsingBurn: false
            }),
            ""
        );

        assertEq(
            uint256(uint128(delta.amount0())),
            requestedPipedogOut
        );
        assertLt(delta.amount1(), 0);
        uint256 tokensSpent =
            uint256(uint128(-delta.amount1()));
        uint256 fee = hook.pending(poolId);
        uint256 rate = hook.currentFeeRate(poolId, TRADER);
        uint256 grossPipedogOut = requestedPipedogOut + fee;
        assertEq(
            fee,
            (
                grossPipedogOut * rate
                    + hook.FEE_DENOMINATOR() - 1
            ) / hook.FEE_DENOMINATOR()
        );
        assertEq(
            pipedog.balanceOf(TRADER),
            quoteBefore + requestedPipedogOut
        );
        assertEq(
            token.balanceOf(TRADER), tokenBefore - tokensSpent
        );
        _assertSweepAndCreatorClaim(poolId, fee);
    }

    function testBuyAndSellSlippageRevertAllTransfers() public {
        (LaypipeToken token,, PoolKey memory key) =
            _launch(0, 0, 60_000, 0);
        uint256 quoteIn = 0.005 ether;
        uint256 quoteBefore = pipedog.balanceOf(TRADER);
        vm.prank(TRADER);
        pipedog.approve(address(swapRouter), quoteIn);
        vm.expectPartialRevert(
            LaypipeSwapRouter.SlippageExceeded.selector
        );
        vm.prank(TRADER);
        swapRouter.buy(
            key,
            quoteIn,
            type(uint256).max,
            TRADER,
            type(uint256).max
        );
        assertEq(pipedog.balanceOf(TRADER), quoteBefore);
        assertEq(
            pipedog.allowance(TRADER, address(swapRouter)), quoteIn
        );

        vm.prank(TRADER);
        uint256 bought = swapRouter.buy(key, quoteIn, 1, TRADER, type(uint256).max);
        uint256 sellAmount = bought / 2;
        uint256 tokenBefore = token.balanceOf(TRADER);
        vm.prank(TRADER);
        token.approve(address(swapRouter), sellAmount);
        vm.expectPartialRevert(
            LaypipeSwapRouter.SlippageExceeded.selector
        );
        vm.prank(TRADER);
        swapRouter.sell(
            key,
            sellAmount,
            type(uint256).max,
            TRADER,
            type(uint256).max
        );
        assertEq(token.balanceOf(TRADER), tokenBefore);
        assertEq(
            token.allowance(TRADER, address(swapRouter)), sellAmount
        );
    }

    function testPublicBuyRejectsCurveBoundaryPartialFillAtomically()
        public
    {
        factory.addLaunchConfig(_boundaryConfig());
        _setPipedogBalance(TRADER, 3_000_000_000 ether);
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(2, 0, 70_000, 0);
        uint256 oversizedInput = 2_000_000_000 ether;
        uint256 quoteBefore = pipedog.balanceOf(TRADER);
        uint256 tokenBefore = token.balanceOf(TRADER);

        vm.prank(TRADER);
        pipedog.approve(address(swapRouter), oversizedInput);
        // The public router uses the full-range boundary. If the curve cannot
        // consume the complete exact input, the hook rejects the partial fill
        // and the ERC20 pull, allowance spend, fee claim, and output all roll
        // back together.
        vm.expectRevert();
        vm.prank(TRADER);
        swapRouter.buy(
            key, oversizedInput, 0, TRADER, type(uint256).max
        );

        assertEq(pipedog.balanceOf(TRADER), quoteBefore);
        assertEq(token.balanceOf(TRADER), tokenBefore);
        assertEq(
            pipedog.allowance(TRADER, address(swapRouter)),
            oversizedInput
        );
        assertEq(hook.pending(poolId), 0);
        assertEq(pipedog.balanceOf(address(swapRouter)), 0);
        assertEq(token.balanceOf(address(swapRouter)), 0);
    }

    function testFactoryFirstBuyRejectsCurveBoundaryPartialFillAtomically()
        public
    {
        factory.addLaunchConfig(_boundaryConfig());
        _setPipedogBalance(CREATOR, 3_000_000_000 ether);
        LaypipeFactory.TokenParams memory params = _params();
        (bytes32 salt, address predicted) = factory.mineSalt(
            params, 2, CREATOR, 75_000, 16_384
        );
        uint256 oversizedFirstBuy = 2_000_000_000 ether;
        uint256 totalPull = LAUNCH_FEE + oversizedFirstBuy;
        uint256 creatorBefore = pipedog.balanceOf(CREATOR);
        uint256 revenueBefore =
            pipedog.balanceOf(address(revenueRouter));

        vm.prank(CREATOR);
        pipedog.approve(address(factory), totalPull);
        vm.expectRevert();
        vm.prank(CREATOR);
        factory.launch(
            params, 2, oversizedFirstBuy, 0, salt
        );

        assertEq(pipedog.balanceOf(CREATOR), creatorBefore);
        assertEq(
            pipedog.allowance(CREATOR, address(factory)), totalPull
        );
        assertEq(
            pipedog.balanceOf(address(revenueRouter)),
            revenueBefore
        );

        // Reusing the same salt for a bounded first buy proves that clone,
        // pool registration, and initialization all reverted atomically.
        uint256 boundedFirstBuy = 0.001 ether;
        vm.prank(CREATOR);
        pipedog.approve(
            address(factory), LAUNCH_FEE + boundedFirstBuy
        );
        vm.prank(CREATOR);
        (address launched,) = factory.launch(
            params, 2, boundedFirstBuy, 1, salt
        );
        assertEq(launched, predicted);
    }

    function testFeesSweepAndClaimInPipedogThenAllocateDirectly()
        public
    {
        (, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 80_000, 0);
        uint256 quoteIn = 0.01 ether;
        _buy(key, quoteIn, TRADER);

        uint256 pending = hook.pending(poolId);
        assertEq(pending, quoteIn / 100);
        uint256 routerBefore =
            pipedog.balanceOf(address(revenueRouter));
        (uint256 creatorAmount, uint256 platformAmount) =
            hook.sweep(poolId);
        assertEq(creatorAmount + platformAmount, pending);
        assertEq(
            pipedog.balanceOf(address(revenueRouter)),
            routerBefore + platformAmount
        );
        assertEq(hook.tab(poolId), creatorAmount);
        assertEq(hook.platformTab(), 0);

        uint256 creatorBefore = pipedog.balanceOf(CREATOR);
        vm.prank(CREATOR);
        uint256 claimed = hook.claim(poolId);
        assertEq(claimed, creatorAmount);
        assertEq(
            pipedog.balanceOf(CREATOR), creatorBefore + claimed
        );
        assertEq(hook.tab(poolId), 0);

        revenueRouter.allocate();
        uint256 allocated = revenueRouter.totalRevenueAllocated();
        assertEq(
            allocated,
            LAUNCH_FEE + platformAmount
        );
        assertEq(
            revenueRouter.sequesterTank(), allocated / 4
        );
        assertEq(revenueRouter.treasuryTank(), allocated / 4);
        assertEq(
            revenueRouter.operationsTab(),
            allocated - (allocated / 4) - (allocated / 4)
        );
    }

    function testFeeStreamCanMoveButOnlyNewCreatorCanClaim() public {
        (, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 100_000, 0);
        _buy(key, 0.005 ether, TRADER);
        hook.sweep(poolId);
        uint256 tab = hook.tab(poolId);

        vm.prank(CREATOR);
        hook.updateCreator(poolId, NEW_CREATOR);
        vm.expectRevert(PipedogHook.NotCreator.selector);
        vm.prank(CREATOR);
        hook.claim(poolId);

        uint256 beforeBalance = pipedog.balanceOf(NEW_CREATOR);
        vm.prank(NEW_CREATOR);
        uint256 claimed = hook.claim(poolId);
        assertEq(claimed, tab);
        assertEq(
            pipedog.balanceOf(NEW_CREATOR), beforeBalance + tab
        );
    }

    function testSelfBurnUsesPipedogFuelPaysPipedogBountyAndBurnsToken()
        public
    {
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(1, 0, 120_000, 0);
        _buy(key, 0.01 ether, TRADER);
        uint256 supplyBefore = token.totalSupply();
        uint256 keeperBefore = pipedog.balanceOf(KEEPER);
        uint256 pendingBefore = hook.pending(poolId);
        uint256 creatorFuel = (pendingBefore * 7_000) / 10_000;
        uint256 expectedBounty =
            (creatorFuel * BOUNTY_BPS) / 10_000;

        uint256 burnBlock = block.number + 1_000;
        _mockArbBlockNumber(burnBlock);
        vm.prank(KEEPER);
        uint256 burned = selfBurner.burn(poolId);
        assertGt(burned, 0);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertEq(
            pipedog.balanceOf(KEEPER) - keeperBefore,
            expectedBounty
        );
        assertEq(selfBurner.unburned(poolId), 0);
        // The self-burn swap itself earns another PIPEDOG fee.
        assertGt(hook.pending(poolId), 0);

        // Advancing the Solidity/L1 estimate cannot bypass the L2-block gate.
        vm.roll(block.number + 1);
        vm.expectRevert(LaypipeSelfBurner.BurnedThisBlock.selector);
        vm.prank(KEEPER);
        selfBurner.burn(poolId);

        _mockArbBlockNumber(burnBlock + 1);
        vm.prank(KEEPER);
        assertGt(selfBurner.burn(poolId), 0);
    }

    function testSuffixAloneCannotBypassPipedogAddressOrdering()
        public
    {
        LaypipeFactory.TokenParams memory params = _params();
        bytes32 invalidSalt;
        address predicted;
        for (uint256 i = 1; i < 50_000; ++i) {
            bytes32 candidate = bytes32(i);
            address candidateAddress =
                _predictForSalt(params, 0, CREATOR, candidate);
            if (
                uint8(uint160(candidateAddress)) == 0xcc
                    && candidateAddress
                        < PipedogProtocolConfig.PIPEDOG
            ) {
                invalidSalt = candidate;
                predicted = candidateAddress;
                break;
            }
        }
        assertTrue(predicted != address(0));

        vm.prank(CREATOR);
        pipedog.approve(address(factory), LAUNCH_FEE);
        vm.expectRevert(
            abi.encodeWithSelector(
                LaypipeFactory.InvalidTokenOrdering.selector,
                predicted,
                PipedogProtocolConfig.PIPEDOG
            )
        );
        vm.prank(CREATOR);
        factory.launch(params, 0, 0, 0, invalidSalt);

        (bytes32 validSalt, address validToken) =
            factory.mineSalt(params, 0, CREATOR, 1, 16_384);
        assertTrue(validSalt != bytes32(0));
        assertGt(
            uint256(uint160(validToken)),
            uint256(uint160(PipedogProtocolConfig.PIPEDOG))
        );
        assertEq(uint8(uint160(validToken)), 0xcc);
    }

    function testDividendModeIsHardClosed() public {
        assertFalse(factory.dividendLaunchEnabled());
        assertEq(factory.dividendDistributor(), address(0));
        vm.expectRevert(
            LaypipeFactory.DividendModeUnderReview.selector
        );
        factory.setDividendLaunchEnabled(true);
        assertFalse(factory.dividendLaunchEnabled());
    }

    function testFactoryRecoveryRoutesPipedogOnlyToPolicyRouter()
        public
    {
        MockERC20 accidental = new MockERC20("Accidental", "OOPS");
        accidental.mint(address(factory), 123 ether);
        _setPipedogBalance(address(factory), 2 ether);
        uint256 routerBefore =
            pipedog.balanceOf(address(revenueRouter));

        factory.sweep(address(pipedog));
        assertEq(
            pipedog.balanceOf(address(revenueRouter)),
            routerBefore + 2 ether
        );
        assertEq(pipedog.balanceOf(address(factory)), 0);

        uint256 ownerTokenBefore = accidental.balanceOf(address(this));
        factory.sweep(address(accidental));
        assertEq(
            accidental.balanceOf(address(this)),
            ownerTokenBefore + 123 ether
        );

        uint256 ownerNativeBefore = address(this).balance;
        ForceNative forceSender = new ForceNative{value: 1 ether}();
        forceSender.force(payable(address(factory)));
        assertEq(address(factory).balance, 1 ether);
        factory.sweep(address(0));
        assertEq(address(factory).balance, 0);
        assertEq(address(this).balance, ownerNativeBefore);
    }

    function testRecoveryCannotReachPermanentPoolReserves() public {
        (LaypipeToken token,,) =
            _launch(0, 0, 140_000, 0);
        uint256 managerTokenBefore =
            token.balanceOf(address(manager));
        uint256 managerQuoteBefore =
            pipedog.balanceOf(address(manager));

        factory.sweep(address(token));
        assertEq(
            token.balanceOf(address(manager)), managerTokenBefore
        );
        assertEq(
            pipedog.balanceOf(address(manager)), managerQuoteBefore
        );
    }

    function testRepeatedBuySellSequenceLeavesNoRouterResidue()
        public
    {
        (LaypipeToken token,, PoolKey memory key) =
            _launch(0, 0, 160_000, 0);
        uint256 fixedSupply = pipedog.totalSupply();

        for (uint256 i; i < 8; ++i) {
            uint256 quoteIn = (i + 1) * 0.0001 ether;
            vm.prank(TRADER);
            pipedog.approve(address(swapRouter), quoteIn);
            vm.prank(TRADER);
            uint256 out =
                swapRouter.buy(key, quoteIn, 1, TRADER, type(uint256).max);

            uint256 sellAmount = out / 2;
            vm.prank(TRADER);
            token.approve(address(swapRouter), sellAmount);
            vm.prank(TRADER);
            swapRouter.sell(key, sellAmount, 1, TRADER, type(uint256).max);

            assertEq(pipedog.balanceOf(address(swapRouter)), 0);
            assertEq(token.balanceOf(address(swapRouter)), 0);
            assertEq(pipedog.balanceOf(address(factory)), 0);
        }
        assertEq(pipedog.totalSupply(), fixedSupply);
    }

    function _assertSweepAndCreatorClaim(
        PoolId poolId,
        uint256 totalFee
    ) internal {
        uint256 routerBefore =
            pipedog.balanceOf(address(revenueRouter));
        uint256 creatorBefore = pipedog.balanceOf(CREATOR);
        (uint256 creatorAmount, uint256 platformAmount) =
            hook.sweep(poolId);

        assertEq(
            creatorAmount,
            (totalFee * 7_000) / 10_000
        );
        assertEq(platformAmount, totalFee - creatorAmount);
        assertEq(
            pipedog.balanceOf(address(revenueRouter)),
            routerBefore + platformAmount
        );
        assertEq(hook.tab(poolId), creatorAmount);
        assertEq(hook.platformTab(), 0);

        vm.prank(CREATOR);
        uint256 claimed = hook.claim(poolId);
        assertEq(claimed, creatorAmount);
        assertEq(
            pipedog.balanceOf(CREATOR),
            creatorBefore + creatorAmount
        );
        assertEq(hook.pending(poolId), 0);
        assertEq(hook.tab(poolId), 0);
    }

    function _launch(
        uint256 configId,
        uint256 firstBuy,
        uint256 saltStart,
        uint256 minOut
    )
        internal
        returns (
            LaypipeToken token,
            PoolId poolId,
            PoolKey memory key
        )
    {
        LaypipeFactory.TokenParams memory params = _params();
        (bytes32 salt, address predicted) = factory.mineSalt(
            params, configId, CREATOR, saltStart + 1, 16_384
        );
        assertTrue(predicted != address(0));
        assertGt(
            uint256(uint160(predicted)),
            uint256(uint160(PipedogProtocolConfig.PIPEDOG))
        );

        vm.prank(CREATOR);
        pipedog.approve(
            address(factory), LAUNCH_FEE + firstBuy
        );
        vm.prank(CREATOR);
        (address tokenAddress, PoolId launchedPoolId) =
            factory.launch(
                params, configId, firstBuy, minOut, salt
            );
        assertEq(tokenAddress, predicted);
        assertEq(
            pipedog.allowance(CREATOR, address(factory)), 0
        );

        token = LaypipeToken(tokenAddress);
        poolId = launchedPoolId;
        key = PoolKey({
            currency0: Currency.wrap(address(pipedog)),
            currency1: Currency.wrap(tokenAddress),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        assertEq(
            PoolId.unwrap(key.toId()), PoolId.unwrap(poolId)
        );
    }

    function _buy(
        PoolKey memory key,
        uint256 amount,
        address buyer
    ) internal returns (uint256 out) {
        vm.prank(buyer);
        pipedog.approve(address(swapRouter), amount);
        vm.prank(buyer);
        out = swapRouter.buy(
            key, amount, 1, buyer, type(uint256).max
        );
    }

    function _deployHook(address hookTreasury)
        internal
        returns (PipedogHook deployed)
    {
        bytes memory args = abi.encode(
            manager,
            address(factory),
            pipedog,
            hookTreasury,
            address(this)
        );
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this),
            _requiredFlags(),
            type(PipedogHook).creationCode,
            args
        );
        deployed = new PipedogHook{salt: salt}(
            manager,
            address(factory),
            pipedog,
            hookTreasury,
            address(this)
        );
        assertEq(address(deployed), predicted);
        Hooks.validateHookPermissions(
            IHooks(address(deployed)),
            deployed.getHookPermissions()
        );
    }

    function _requiredFlags() internal pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }

    function _config(bool selfBurn)
        internal
        pure
        returns (LaypipeFactory.LaunchConfig memory)
    {
        return LaypipeFactory.LaunchConfig({
            supply: SUPPLY,
            tickSpacing: TICK_SPACING,
            startTick: START_TICK,
            creatorFeeBps: 7_000,
            baseFeeRate: 10_000,
            launchFeeRate: 10_000,
            launchFeeDecay: 0,
            enabled: true,
            selfBurn: selfBurn
        });
    }

    function _boundaryConfig()
        internal
        pure
        returns (LaypipeFactory.LaunchConfig memory)
    {
        LaypipeFactory.LaunchConfig memory config =
            _config(false);
        config.startTick = BOUNDARY_START_TICK;
        return config;
    }

    function _params()
        internal
        pure
        returns (LaypipeFactory.TokenParams memory)
    {
        return LaypipeFactory.TokenParams({
            name: "Pipe Pup",
            symbol: "PUP",
            logo: "ipfs://logo",
            description: "A test pipe dog",
            metadataURI: "ipfs://metadata",
            socials: LaypipeFactory.Socials({
                telegram: "pipedog",
                twitter: "pipedog",
                discord: "",
                website: "https://pipedog.xyz",
                extra: ""
            }),
            creator: CREATOR
        });
    }

    function _predictForSalt(
        LaypipeFactory.TokenParams memory params,
        uint256 configId,
        address sender,
        bytes32 salt
    ) internal view returns (address) {
        bytes32 derivedSalt = keccak256(
            abi.encode(
                sender,
                configId,
                salt,
                keccak256(bytes(params.name)),
                keccak256(bytes(params.symbol)),
                params.creator
            )
        );
        return Clones.predictDeterministicAddress(
            address(tokenImplementation),
            derivedSalt,
            address(factory)
        );
    }

    function _setPipedogBalance(address account, uint256 amount)
        internal
    {
        // PIPEDOG is preflight-pinned to the non-proxy OZ bytecode whose
        // balances mapping is slot zero. This local fork funding leaves the
        // canonical fixed totalSupply untouched.
        vm.store(
            address(pipedog),
            keccak256(abi.encode(account, uint256(0))),
            bytes32(amount)
        );
    }

    function _setPipedogAllowance(
        address owner,
        address spender,
        uint256 amount
    ) internal {
        bytes32 ownerSlot =
            keccak256(abi.encode(owner, uint256(1)));
        vm.store(
            address(pipedog),
            keccak256(abi.encode(spender, ownerSlot)),
            bytes32(amount)
        );
    }

    function _mockArbBlockNumber(uint256 number) internal {
        // Storage reads against custom precompiles are not ordinary RPC
        // account reads. Install a storage-free runtime that returns the
        // requested number, then persist it across the fork boundary.
        vm.etch(
            ARBSYS,
            abi.encodePacked(
                hex"7f", bytes32(number), hex"60005260206000f3"
            )
        );
    }

    receive() external payable {}
}
