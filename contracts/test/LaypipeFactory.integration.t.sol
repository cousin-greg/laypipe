// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {
    ModifyLiquidityParams,
    SwapParams
} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from
    "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolDonateTest} from "v4-core/src/test/PoolDonateTest.sol";
import {IUniswapV3Factory} from
    "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {LaypipeFactory} from "../src/LaypipeFactory.sol";
import {LaypipeToken} from "../src/LaypipeToken.sol";
import {PipedogHook} from "../src/PipedogHook.sol";
import {LaypipeSelfBurner} from "../src/LaypipeSelfBurner.sol";
import {
    LaypipeDividendDistributor,
    IWETH9
} from "../src/LaypipeDividendDistributor.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";
import {
    MockERC20,
    MockWETH,
    MockV3Factory,
    RejectNative
} from "./mocks/RevenueRouterMocks.sol";

contract ForceEther {
    constructor() payable {}

    function force(address payable target) external {
        selfdestruct(target);
    }
}

contract TreasuryReceiver {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

contract LaypipeFactoryIntegrationTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant LAUNCH_FEE = 0.0005 ether;
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant START_TICK = 204_200;

    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant TRADER = address(0xB0B);
    address internal constant NEW_CREATOR = address(0xA11CE);
    address internal constant KEEPER = address(0xCA11);

    event Swept(address indexed asset, address indexed recipient, uint256 amount);

    IPoolManager internal manager;
    TreasuryReceiver internal treasury;
    LaypipeFactory internal factory;
    LaypipeToken internal tokenImplementation;
    PipedogHook internal hook;
    LaypipeSelfBurner internal selfBurner;
    LaypipeDividendDistributor internal distributor;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolDonateTest internal donateRouter;
    MockWETH internal weth;
    MockV3Factory internal v3Factory;

    function setUp() public {
        vm.createSelectFork(
            vm.envOr(
                "ROBINHOOD_RPC_URL",
                string("https://rpc.mainnet.chain.robinhood.com")
            )
        );
        manager =
            IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
        treasury = new TreasuryReceiver();

        LaypipeFactory implementation = new LaypipeFactory();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(
                LaypipeFactory.initialize,
                (
                    manager,
                    payable(address(treasury)),
                    address(this),
                    LAUNCH_FEE
                )
            )
        );
        factory = LaypipeFactory(payable(address(proxy)));
        tokenImplementation = new LaypipeToken();

        hook = _deployHook(address(treasury));
        factory.setHook(hook);
        factory.setTokenImplementation(tokenImplementation);

        selfBurner = new LaypipeSelfBurner(
            manager, hook, address(factory)
        );
        factory.setSelfBurner(selfBurner);

        weth = new MockWETH();
        v3Factory = new MockV3Factory();
        distributor = new LaypipeDividendDistributor(
            manager,
            hook,
            address(factory),
            IWETH9(address(weth)),
            // Only ETH-route registration is exercised locally. Direct v3
            // routes independently authenticate pools at registration.
            IUniswapV3Factory(address(v3Factory))
        );
        factory.setDividendDistributor(distributor);

        factory.addLaunchConfig(_config(false));
        factory.addLaunchConfig(_config(true));
        factory.setLaunchEnabled(true);

        swapRouter = new PoolSwapTest(manager);
        liquidityRouter =
            new PoolModifyLiquidityTest(manager);
        donateRouter = new PoolDonateTest(manager);

        vm.deal(CREATOR, 100 ether);
        vm.deal(TRADER, 100 ether);
    }

    function testLaunchSeedsRealV4PoolAndLocksLiquidity() public {
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 0);

        (uint160 sqrtPriceX96, int24 tick,,) =
            manager.getSlot0(poolId);
        assertEq(sqrtPriceX96, TickMath.getSqrtPriceAtTick(START_TICK));
        assertEq(tick, START_TICK);
        (uint128 positionLiquidity,,) = manager.getPositionInfo(
            poolId,
            address(factory),
            TickMath.minUsableTick(TICK_SPACING),
            START_TICK,
            bytes32(0)
        );
        assertGt(positionLiquidity, 0);

        assertEq(token.factory(), address(factory));
        assertEq(token.deployer(), CREATOR);
        assertEq(token.poolId(), PoolId.unwrap(poolId));
        assertEq(address(token.hook()), address(hook));
        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(
            token.balanceOf(address(manager)), token.totalSupply()
        );
        assertLe(token.totalSupply(), SUPPLY);
        assertGt(token.totalSupply(), SUPPLY - 1 ether);
        assertEq(treasury.received(), LAUNCH_FEE);

        (
            address feeOwner,
            ,
            uint16 creatorFeeBps,
            uint24 baseFeeRate,
            uint24 launchFeeRate,
            uint32 launchFeeDecay,
            bool exists
        ) = hook.poolConfigs(poolId);
        assertEq(feeOwner, CREATOR);
        assertEq(creatorFeeBps, 7_000);
        assertEq(baseFeeRate, 10_000);
        assertEq(launchFeeRate, 10_000);
        assertEq(launchFeeDecay, 0);
        assertTrue(exists);
        assertTrue(hook.seeded(poolId));

        ModifyLiquidityParams memory removeParams =
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: START_TICK,
                liquidityDelta: -1,
                salt: bytes32(0)
            });
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
        donateRouter.donate(key, 1, 0, "");
    }

    function testFirstBuyIsAtomicAndInitialCheckpointIsRecorded() public {
        uint256 launchBlock = block.number;
        (LaypipeToken token,,) = _launch(0, 0.05 ether, 1);
        uint256 firstBalance = token.balanceOf(CREATOR);
        uint256 firstSupply = token.totalSupply();
        assertGt(firstBalance, 0);
        assertEq(token.balanceOfAt(CREATOR, uint64(launchBlock)), firstBalance);
        assertEq(token.totalSupplyAt(uint64(launchBlock)), firstSupply);
        assertTrue(token.supportsBlockCheckpoints());
    }

    function testBuySellFeeSweepClaimAndFeeOwnershipTransfer() public {
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(0, 0, 2);

        _buy(key, 0.1 ether, TRADER);
        uint256 afterBuyPending = hook.pending(poolId);
        assertEq(afterBuyPending, 0.001 ether);

        uint256 sellAmount = token.balanceOf(TRADER) / 10;
        vm.prank(TRADER);
        token.approve(address(swapRouter), sellAmount);
        vm.prank(TRADER);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(sellAmount),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({
                takeClaims: false,
                settleUsingBurn: false
            }),
            ""
        );
        assertGt(hook.pending(poolId), afterBuyPending);

        uint256 platformBefore = treasury.received();
        hook.sweep(poolId);
        uint256 creatorTab = hook.tab(poolId);
        assertGt(creatorTab, 0);
        assertGt(treasury.received(), platformBefore);

        vm.prank(CREATOR);
        hook.updateCreator(poolId, NEW_CREATOR);
        vm.expectRevert(PipedogHook.NotCreator.selector);
        vm.prank(CREATOR);
        hook.claim(poolId);

        uint256 newCreatorBefore = NEW_CREATOR.balance;
        vm.prank(NEW_CREATOR);
        uint256 claimed = hook.claim(poolId);
        assertEq(NEW_CREATOR.balance - newCreatorBefore, claimed);
        assertEq(claimed, creatorTab);
        assertEq(hook.tab(poolId), 0);
    }

    function testSelfBurnModeClaimsFeesAndActuallyReducesLaunchedSupply()
        public
    {
        (LaypipeToken token, PoolId poolId, PoolKey memory key) =
            _launch(1, 0, 3);
        _buy(key, 0.1 ether, TRADER);
        uint256 supplyBefore = token.totalSupply();

        vm.roll(block.number + 1);
        vm.prank(KEEPER);
        uint256 burned = selfBurner.burn(poolId);
        assertGt(burned, 0);
        assertEq(token.totalSupply(), supplyBefore - burned);
        assertGt(KEEPER.balance, 0);
        assertGt(hook.pending(poolId), 0);
    }

    function testDividendModeIsClosedAndCannotBeEnabledAccidentally()
        public
    {
        assertFalse(factory.dividendLaunchEnabled());
        vm.expectRevert(
            LaypipeFactory.DividendModeUnderReview.selector
        );
        factory.setDividendLaunchEnabled(true);
        assertFalse(factory.dividendLaunchEnabled());
    }

    function testCreatorMustSignAndValueMustBeExact() public {
        LaypipeFactory.TokenParams memory params = _params();
        (bytes32 salt,) =
            factory.mineSalt(params, 0, CREATOR, 20_000, 8_192);

        vm.expectRevert(LaypipeFactory.InvalidCreator.selector);
        factory.launch{value: LAUNCH_FEE}(params, 0, 0, 0, salt);

        vm.expectRevert(LaypipeFactory.InvalidValue.selector);
        vm.prank(CREATOR);
        factory.launch{value: LAUNCH_FEE + 1}(params, 0, 0, 0, salt);
    }

    function testDirectLaunchCannotBypassCcVanitySuffix() public {
        LaypipeFactory.TokenParams memory params = _params();
        bytes32 salt = bytes32(uint256(777));
        address predicted =
            factory.predictTokenAddress(params, 0, CREATOR, salt);
        while (uint8(uint160(predicted)) == 0xcc) {
            salt = bytes32(uint256(salt) + 1);
            predicted =
                factory.predictTokenAddress(params, 0, CREATOR, salt);
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                LaypipeFactory.InvalidVanitySuffix.selector, predicted
            )
        );
        vm.prank(CREATOR);
        factory.launch{value: LAUNCH_FEE}(params, 0, 0, 0, salt);
    }

    function testPauseAndHookRotationCannotLeaveStaleHelpersLive() public {
        PipedogHook replacement = _deployHook(address(treasury));
        factory.setHook(replacement);

        assertFalse(factory.launchEnabled());
        assertFalse(factory.dividendLaunchEnabled());
        assertEq(address(factory.selfBurner()), address(0));
        assertEq(address(factory.dividendDistributor()), address(0));
        assertEq(address(factory.hook()), address(replacement));

        vm.expectRevert(LaypipeFactory.LaunchPaused.selector);
        vm.prank(CREATOR);
        factory.launch{value: LAUNCH_FEE}(
            _params(), 0, 0, 0, bytes32(uint256(1))
        );
    }

    function testFactoryAndHookTreasuriesCannotSilentlyDiverge() public {
        TreasuryReceiver other = new TreasuryReceiver();
        PipedogHook wrongTreasuryHook = _deployHook(address(other));
        vm.expectRevert(LaypipeFactory.InvalidInfrastructure.selector);
        factory.setHook(wrongTreasuryHook);

        vm.expectRevert(LaypipeFactory.InvalidInfrastructure.selector);
        factory.setTreasury(payable(address(other)));

        factory.setLaunchEnabled(false);
        hook.setTreasury(address(other));
        factory.setTreasury(payable(address(other)));
        factory.setLaunchEnabled(true);
        assertEq(factory.treasury(), address(other));
        assertEq(hook.treasury(), address(other));
    }

    function testOwnerCanSweepOnlyFactoryOwnedForcedEthAndAccidentalErc20()
        public
    {
        MockERC20 accidental = new MockERC20("Accidental", "OOPS");
        accidental.mint(address(factory), 123 ether);
        vm.deal(address(this), 1 ether);
        ForceEther forceSender = new ForceEther{value: 1 ether}();
        forceSender.force(payable(address(factory)));

        assertEq(address(factory).balance, 1 ether);
        assertEq(accidental.balanceOf(address(factory)), 123 ether);

        vm.expectRevert(
            abi.encodeWithSignature(
                "OwnableUnauthorizedAccount(address)", TRADER
            )
        );
        vm.prank(TRADER);
        factory.sweep(address(0));
        assertEq(address(factory).balance, 1 ether);

        uint256 treasuryBefore = treasury.received();
        vm.expectEmit(true, true, false, true);
        emit Swept(address(0), address(treasury), 1 ether);
        factory.sweep(address(0));
        assertEq(address(factory).balance, 0);
        assertEq(treasury.received() - treasuryBefore, 1 ether);

        uint256 ownerTokenBefore = accidental.balanceOf(address(this));
        vm.expectEmit(true, true, false, true);
        emit Swept(address(accidental), address(this), 123 ether);
        factory.sweep(address(accidental));
        assertEq(accidental.balanceOf(address(factory)), 0);
        assertEq(
            accidental.balanceOf(address(this)) - ownerTokenBefore,
            123 ether
        );
    }

    function testNativeSweepRevertsAtomicallyWhenTreasuryRejects() public {
        RejectNative rejector = new RejectNative();
        factory.setLaunchEnabled(false);
        hook.setTreasury(address(rejector));
        factory.setTreasury(payable(address(rejector)));

        vm.deal(address(this), 1 ether);
        ForceEther forceSender = new ForceEther{value: 1 ether}();
        forceSender.force(payable(address(factory)));

        vm.expectRevert(LaypipeFactory.EtherTransferFailed.selector);
        factory.sweep(address(0));
        assertEq(address(factory).balance, 1 ether);
    }

    function testSweepCannotReachPoolManagerOrLaunchedTokenBalances() public {
        (LaypipeToken token,,) = _launch(0, 0, 41);
        uint256 managerBalance = token.balanceOf(address(manager));
        uint256 managerNativeBalance = address(manager).balance;

        factory.sweep(address(token));

        assertEq(token.balanceOf(address(factory)), 0);
        assertEq(token.balanceOf(address(manager)), managerBalance);
        assertEq(address(manager).balance, managerNativeBalance);
    }

    function _launch(
        uint256 configId,
        uint256 firstBuy,
        uint256 saltStart
    )
        internal
        returns (LaypipeToken token, PoolId poolId, PoolKey memory key)
    {
        LaypipeFactory.TokenParams memory params = _params();
        (bytes32 salt, address predicted) =
            factory.mineSalt(
                params, configId, CREATOR, saltStart * 10_000 + 1, 8_192
            );
        assertTrue(predicted != address(0));

        vm.prank(CREATOR);
        (address tokenAddress, PoolId launchedPoolId) =
            factory.launch{value: LAUNCH_FEE + firstBuy}(
                params, configId, firstBuy, 0, salt
            );
        assertEq(tokenAddress, predicted);
        token = LaypipeToken(tokenAddress);
        poolId = launchedPoolId;
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(tokenAddress),
            fee: 0,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        assertEq(PoolId.unwrap(key.toId()), PoolId.unwrap(poolId));
    }

    function _buy(PoolKey memory key, uint256 amount, address buyer)
        internal
    {
        vm.prank(buyer);
        swapRouter.swap{value: amount}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({
                takeClaims: false,
                settleUsingBurn: false
            }),
            ""
        );
    }

    function _deployHook(address hookTreasury)
        internal
        returns (PipedogHook deployed)
    {
        bytes memory args = abi.encode(
            manager,
            address(factory),
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
            hookTreasury,
            address(this)
        );
        assertEq(address(deployed), predicted);
        Hooks.validateHookPermissions(
            IHooks(address(deployed)), deployed.getHookPermissions()
        );
    }

    function _requiredFlags() internal pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG
            | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
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

    receive() external payable {}
}
