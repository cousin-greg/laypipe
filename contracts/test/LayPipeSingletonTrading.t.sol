// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {ILayPipeRewardVault} from "../src/interfaces/ILayPipeRewardVault.sol";
import {PipeDogFeeHook} from "../src/PipeDogFeeHook.sol";
import {LayPipeSingletonLauncher} from "../src/LayPipeSingletonLauncher.sol";
import {LayPipeSingletonSwapRouter} from "../src/LayPipeSingletonSwapRouter.sol";
import {LayPipeHybridToken} from "../src/LayPipeHybridToken.sol";
import {PipeDogRewards} from "../src/PipeDogRewards.sol";
import {DN404Mirror} from "dn404/DN404Mirror.sol";
import {HookMiner} from "../src/lib/HookMiner.sol";

contract SingletonCreate2Deployer {
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

contract SingletonMockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FixedSupplyLayPipe is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 ether;
    address public immutable initialSupplyOwner;
    bool public systemExclusionsConfigured;
    mapping(address => bool) public isExcluded;

    constructor(address recipient) ERC20("LayPipe", "LAYPIPE") {
        initialSupplyOwner = recipient;
        isExcluded[recipient] = true;
        _mint(recipient, INITIAL_SUPPLY);
    }

    function configureSystemExclusions(address launcher, address hook, address poolManager, address router) external {
        require(msg.sender == initialSupplyOwner);
        require(!systemExclusionsConfigured);
        systemExclusionsConfigured = true;
        isExcluded[launcher] = true;
        isExcluded[hook] = true;
        isExcluded[poolManager] = true;
        isExcluded[router] = true;
    }
}

/// @dev Purpose-built PoolManager double. It models the settlement shape used
///      by the singleton contracts and executes the real hook callbacks; v4's
///      own PoolManager remains covered by the repo fork integration suite.
contract SingletonPoolManagerMock {
    using PoolIdLibrary for PoolKey;

    PoolKey private _key;
    bool public initialized;
    bool public liquiditySeeded;
    bool private _unlocked;
    mapping(address => mapping(uint256 => uint256)) public claimBalance;

    function initialize(PoolKey memory key, uint160) external returns (int24) {
        require(!initialized);
        key.hooks.beforeInitialize(msg.sender, key, 0);
        _key = key;
        initialized = true;
        return 0;
    }

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!_unlocked);
        _unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        _unlocked = false;
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata data)
        external
        returns (BalanceDelta delta, BalanceDelta fees)
    {
        require(_unlocked && initialized);
        if (params.liquidityDelta > 0) {
            key.hooks.beforeAddLiquidity(msg.sender, key, params, data);
            liquiditySeeded = true;
            uint256 amount = 1_000_000_000 ether;
            delta = toBalanceDelta(0, -int128(int256(amount)));
            fees = toBalanceDelta(0, 0);
            return (delta, fees);
        }
        key.hooks.beforeRemoveLiquidity(msg.sender, key, params, data);
        revert("unexpected liquidity removal");
    }

    function swap(PoolKey memory key, SwapParams memory params, bytes calldata data)
        external
        returns (BalanceDelta callerDelta)
    {
        require(_unlocked && liquiditySeeded);
        (bool beforeOk, bytes memory beforeResult) =
            address(key.hooks).call(abi.encodeWithSelector(IHooks.beforeSwap.selector, msg.sender, key, params, data));
        require(beforeOk && beforeResult.length == 96);
        (, int256 beforeDeltaRaw,) = abi.decode(beforeResult, (bytes4, int256, uint24));
        int128 specifiedDelta = int128(beforeDeltaRaw >> 128);
        int256 adjustedSpecified = params.amountSpecified + specifiedDelta;

        BalanceDelta poolDelta;
        if (params.zeroForOne) {
            poolDelta = toBalanceDelta(int128(adjustedSpecified), int128(-adjustedSpecified));
        } else {
            poolDelta = toBalanceDelta(int128(-adjustedSpecified), int128(adjustedSpecified));
        }

        (bool afterOk, bytes memory afterResult) = address(key.hooks)
            .call(abi.encodeWithSelector(IHooks.afterSwap.selector, msg.sender, key, params, poolDelta, data));
        require(afterOk && afterResult.length == 64);
        (, int128 unspecifiedDelta) = abi.decode(afterResult, (bytes4, int128));

        int128 amount0 = poolDelta.amount0();
        int128 amount1 = poolDelta.amount1();
        bool quoteSpecified = (params.amountSpecified < 0) == params.zeroForOne;
        if (quoteSpecified) {
            amount0 -= specifiedDelta;
        } else {
            amount0 -= unspecifiedDelta;
        }
        callerDelta = toBalanceDelta(amount0, amount1);
    }

    function callBeforeSwap(IHooks hooks, address sender, PoolKey memory key, SwapParams memory params)
        external
        returns (bytes4 selector, int256 rawDelta, uint24 feeOverride)
    {
        require(!_unlocked);
        _unlocked = true;
        BeforeSwapDelta delta;
        (selector, delta, feeOverride) = hooks.beforeSwap(sender, key, params, "");
        rawDelta = BeforeSwapDelta.unwrap(delta);
        _unlocked = false;
    }

    function callAfterSwap(
        IHooks hooks,
        address sender,
        PoolKey memory key,
        SwapParams memory params,
        BalanceDelta delta
    ) external returns (bytes4 selector, int128 unspecifiedDelta) {
        require(!_unlocked);
        _unlocked = true;
        (selector, unspecifiedDelta) = hooks.afterSwap(sender, key, params, delta, "");
        _unlocked = false;
    }

    function donate(PoolKey memory key, uint256 amount0, uint256 amount1, bytes calldata data)
        external
        returns (BalanceDelta)
    {
        key.hooks.beforeDonate(msg.sender, key, amount0, amount1, data);
        return toBalanceDelta(0, 0);
    }

    function mint(address to, uint256 id, uint256 amount) external {
        require(_unlocked);
        claimBalance[to][id] += amount;
    }

    function burn(address from, uint256 id, uint256 amount) external {
        require(_unlocked);
        claimBalance[from][id] -= amount;
    }

    function take(Currency currency, address to, uint256 amount) external {
        require(_unlocked);
        require(IERC20(Currency.unwrap(currency)).transfer(to, amount));
    }

    function sync(Currency) external {}

    function settle() external payable returns (uint256) {
        return 0;
    }

    function settleFor(address) external payable returns (uint256) {
        return 0;
    }

    function clear(Currency, uint256) external {}

    function updateDynamicLPFee(PoolKey memory, uint24) external {}

    function balanceOf(address owner, uint256 id) external view returns (uint256) {
        return claimBalance[owner][id];
    }

    function allowance(address, address, uint256) external pure returns (uint256) {
        return 0;
    }

    function isOperator(address, address) external pure returns (bool) {
        return false;
    }

    function transfer(address, uint256, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256, uint256) external pure returns (bool) {
        return false;
    }

    function approve(address, uint256, uint256) external pure returns (bool) {
        return false;
    }

    function setOperator(address, bool) external pure returns (bool) {
        return false;
    }

    function protocolFeesAccrued(Currency) external pure returns (uint256) {
        return 0;
    }

    function setProtocolFee(PoolKey memory, uint24) external {}

    function setProtocolFeeController(address) external {}

    function collectProtocolFees(address, Currency, uint256) external pure returns (uint256) {
        return 0;
    }

    function protocolFeeController() external pure returns (address) {
        return address(0);
    }

    function extsload(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function extsload(bytes32, uint256 n) external pure returns (bytes32[] memory values) {
        values = new bytes32[](n);
    }

    function extsload(bytes32[] calldata slots) external pure returns (bytes32[] memory values) {
        values = new bytes32[](slots.length);
    }

    function exttload(bytes32) external pure returns (bytes32) {
        return bytes32(0);
    }

    function exttload(bytes32[] calldata slots) external pure returns (bytes32[] memory values) {
        values = new bytes32[](slots.length);
    }
}

contract SingletonMockRewardVault is ILayPipeRewardVault {
    IERC20 public immutable pipedog;
    IPoolManager public immutable poolManager;
    address public immutable token;
    address public immutable configurator;
    address public notifier;
    uint256 public notified;
    uint256 public override totalEligibleUnits = 1;

    constructor(IERC20 pipedog_, IPoolManager poolManager_, address token_, address configurator_) {
        pipedog = pipedog_;
        poolManager = poolManager_;
        token = token_;
        configurator = configurator_;
    }

    function setNotifier(address notifier_) external {
        require(notifier == address(0));
        notifier = notifier_;
    }

    function rewardNotifier() external view returns (address) {
        return notifier;
    }

    function notifyRewardClaim(uint256 amount) external {
        require(msg.sender == notifier);
        require(poolManager.balanceOf(address(this), Currency.wrap(address(pipedog)).toId()) == notified + amount);
        notified += amount;
    }

    function eligibleUnitsOf(address) external pure returns (uint256) {
        return 1;
    }

    function claimable(address) external pure returns (uint256) {
        return 0;
    }

    function claim() external pure returns (uint256) {
        return 0;
    }
}

contract LayPipeSingletonTradingTest is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant START_TICK = 0;
    address internal constant TRADER = address(0xB0B);

    IPoolManager internal manager;
    SingletonMockERC20 internal pipedog;
    FixedSupplyLayPipe internal token;
    SingletonMockRewardVault internal vault;
    PipeDogFeeHook internal hook;
    LayPipeSingletonLauncher internal launcher;
    LayPipeSingletonSwapRouter internal router;

    function setUp() public {
        manager = IPoolManager(address(new SingletonPoolManagerMock()));

        pipedog = new SingletonMockERC20("PipeDog", "PIPEDOG");
        token = _deployOrderedLayPipe();
        vault = new SingletonMockRewardVault(pipedog, manager, address(token), address(this));

        hook = _deployHook();
        launcher = new LayPipeSingletonLauncher(manager, pipedog, token, hook, TICK_SPACING, START_TICK);
        hook.setLauncher(address(launcher));
        vault.setNotifier(address(hook));
        router = new LayPipeSingletonSwapRouter(launcher);
        hook.setCanonicalRouter(address(router));
        token.configureSystemExclusions(address(launcher), address(hook), address(manager), address(router));

        token.approve(address(launcher), SUPPLY);
        (PoolId launchedPoolId,) = launcher.launch();
        assertEq(PoolId.unwrap(launchedPoolId), PoolId.unwrap(hook.poolId()));
        pipedog.mint(TRADER, 1_000_000 ether);
    }

    function _deployOrderedLayPipe() private returns (FixedSupplyLayPipe deployed) {
        SingletonCreate2Deployer create2Deployer = new SingletonCreate2Deployer();
        bytes memory creationCode = abi.encodePacked(type(FixedSupplyLayPipe).creationCode, abi.encode(address(this)));
        bytes32 initCodeHash = keccak256(creationCode);
        for (uint256 i; i < 10_000; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = create2Deployer.compute(salt, initCodeHash);
            if (predicted > address(pipedog)) {
                deployed = FixedSupplyLayPipe(create2Deployer.deploy(salt, creationCode));
                assertEq(address(deployed), predicted);
                return deployed;
            }
        }
        revert("ordered token salt not found");
    }

    function testOnePercentBuyAndSellFeesAllFundRewardVault() public {
        uint256 buyIn = 10 ether;
        vm.prank(TRADER);
        pipedog.approve(address(router), buyIn);
        vm.prank(TRADER);
        uint256 bought = router.buy(buyIn, 1, TRADER, type(uint256).max);
        assertEq(vault.notified(), buyIn / 100);

        uint256 sellIn = bought / 2;
        vm.prank(TRADER);
        token.approve(address(router), sellIn);
        uint256 rewardsBeforeSell = vault.notified();
        vm.prank(TRADER);
        uint256 pipedogOut = router.sell(sellIn, 1, TRADER, type(uint256).max);
        assertEq(vault.notified() - rewardsBeforeSell, pipedogOut / 99);

        uint256 totalFees = vault.notified();
        assertGt(totalFees, buyIn / 100);
        assertEq(manager.balanceOf(address(vault), Currency.wrap(address(pipedog)).toId()), totalFees);
        assertEq(pipedog.balanceOf(address(vault)), 0);
        assertEq(pipedog.balanceOf(address(hook)), 0);
    }

    function testSingletonRegistrationLaunchAndLiquidityAreOneShot() public {
        vm.expectRevert(PipeDogFeeHook.LauncherAlreadySet.selector);
        hook.setLauncher(address(launcher));

        vm.expectRevert(PipeDogFeeHook.RouterAlreadySet.selector);
        hook.setCanonicalRouter(address(router));

        vm.expectRevert(LayPipeSingletonLauncher.AlreadyLaunched.selector);
        launcher.launch();

        PoolKey memory key = launcher.poolKey();
        vm.expectRevert(PipeDogFeeHook.AlreadyRegistered.selector);
        vm.prank(address(launcher));
        hook.registerPool(key);

        vm.expectRevert();
        SingletonPoolManagerMock(address(manager))
            .modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: TickMath.minUsableTick(TICK_SPACING),
                    tickUpper: START_TICK,
                    liquidityDelta: -1,
                    salt: bytes32(0)
                }),
                ""
            );

        vm.expectRevert();
        SingletonPoolManagerMock(address(manager)).donate(key, 0, 1, "");
    }

    function testRouterIsBoundToTheRegisteredSingletonPool() public view {
        PoolKey memory key = router.poolKey();
        assertEq(PoolId.unwrap(key.toId()), PoolId.unwrap(hook.poolId()));
        assertEq(address(router.pipedog()), address(pipedog));
        assertEq(address(router.laypipeToken()), address(token));
        assertEq(router.tickSpacing(), TICK_SPACING);
    }

    function testNonCanonicalRouterCannotSwap() public {
        PoolKey memory key = launcher.poolKey();
        vm.expectRevert(PipeDogFeeHook.NotCanonicalRouter.selector);
        vm.prank(address(manager));
        hook.beforeSwap(
            address(0xBAD),
            key,
            SwapParams({
                zeroForOne: true, amountSpecified: -int256(1 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
    }

    function testExactOutputBuyGrossesUpOnePercentAndFundsVault() public {
        PoolKey memory key = launcher.poolKey();
        SwapParams memory params = SwapParams({
            zeroForOne: true, amountSpecified: int256(100 ether), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        SingletonPoolManagerMock mock = SingletonPoolManagerMock(address(manager));

        (, int256 beforeDelta,) = mock.callBeforeSwap(hook, address(router), key, params);
        assertEq(beforeDelta, 0);
        assertEq(vault.notified(), 0);

        (, int128 fee) =
            mock.callAfterSwap(hook, address(router), key, params, toBalanceDelta(-int128(99 ether), int128(100 ether)));
        assertEq(fee, int128(1 ether));
        assertEq(vault.notified(), 1 ether);
        assertEq(manager.balanceOf(address(vault), Currency.wrap(address(pipedog)).toId()), 1 ether);
    }

    function testExactOutputSellGrossesUpAndRejectsPartialFill() public {
        PoolKey memory key = launcher.poolKey();
        SwapParams memory params = SwapParams({
            zeroForOne: false, amountSpecified: int256(99 ether), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
        });
        SingletonPoolManagerMock mock = SingletonPoolManagerMock(address(manager));

        (, int256 beforeDelta,) = mock.callBeforeSwap(hook, address(router), key, params);
        assertEq(int128(beforeDelta >> 128), int128(1 ether));
        assertEq(vault.notified(), 1 ether);

        mock.callAfterSwap(hook, address(router), key, params, toBalanceDelta(int128(100 ether), -int128(100 ether)));

        vm.expectRevert(PipeDogFeeHook.PartialFillRejected.selector);
        mock.callAfterSwap(hook, address(router), key, params, toBalanceDelta(int128(99 ether), -int128(99 ether)));
    }

    function _deployHook() private returns (PipeDogFeeHook deployed) {
        bytes memory args =
            abi.encode(manager, address(this), IERC20(address(pipedog)), ILayPipeRewardVault(address(vault)));
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
}

contract LayPipeSingletonBindingTest is Test {
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant START_TICK = 0;

    IPoolManager internal manager;
    SingletonMockERC20 internal pipedog;
    FixedSupplyLayPipe internal token;
    SingletonMockRewardVault internal vault;
    PipeDogFeeHook internal hook;

    function setUp() public {
        manager = IPoolManager(address(new SingletonPoolManagerMock()));
        pipedog = new SingletonMockERC20("PipeDog", "PIPEDOG");
        token = _deployOrderedLayPipe();
        vault = new SingletonMockRewardVault(pipedog, manager, address(token), address(this));
        hook = _deployHook(pipedog, vault);
    }

    function testRejectsMiswiredVaultLauncherAndRouter() public {
        SingletonMockERC20 wrongPipedog = new SingletonMockERC20("Wrong", "WRONG");
        SingletonMockRewardVault wrongVault =
            new SingletonMockRewardVault(wrongPipedog, manager, address(token), address(this));
        bytes memory badArgs =
            abi.encode(manager, address(this), IERC20(address(pipedog)), ILayPipeRewardVault(address(wrongVault)));
        (, bytes32 badSalt) =
            HookMiner.find(address(this), _requiredFlags(), type(PipeDogFeeHook).creationCode, badArgs);
        vm.expectRevert(PipeDogFeeHook.InvalidVaultBinding.selector);
        new PipeDogFeeHook{salt: badSalt}(manager, address(this), pipedog, wrongVault);

        vm.expectRevert(PipeDogFeeHook.InvalidLauncherBinding.selector);
        hook.setLauncher(address(token));

        LayPipeSingletonLauncher launcher = _deployLauncher(hook);
        hook.setLauncher(address(launcher));
        vm.expectRevert(PipeDogFeeHook.InvalidRouterBinding.selector);
        hook.setCanonicalRouter(address(launcher));
    }

    function testLaunchFailsUntilExactTokenExclusionsAreConfigured() public {
        LayPipeSingletonLauncher launcher = _deployLauncher(hook);
        hook.setLauncher(address(launcher));
        LayPipeSingletonSwapRouter router = new LayPipeSingletonSwapRouter(launcher);
        hook.setCanonicalRouter(address(router));
        vault.setNotifier(address(hook));

        token.approve(address(launcher), token.INITIAL_SUPPLY());
        vm.expectRevert(LayPipeSingletonLauncher.InvalidInfrastructure.selector);
        launcher.launch();
    }

    function _deployLauncher(PipeDogFeeHook hook_) private returns (LayPipeSingletonLauncher) {
        return new LayPipeSingletonLauncher(manager, pipedog, token, hook_, TICK_SPACING, START_TICK);
    }

    function _deployOrderedLayPipe() private returns (FixedSupplyLayPipe deployed) {
        SingletonCreate2Deployer create2Deployer = new SingletonCreate2Deployer();
        bytes memory creationCode = abi.encodePacked(type(FixedSupplyLayPipe).creationCode, abi.encode(address(this)));
        bytes32 initCodeHash = keccak256(creationCode);
        for (uint256 i; i < 10_000; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = create2Deployer.compute(salt, initCodeHash);
            if (predicted > address(pipedog)) {
                deployed = FixedSupplyLayPipe(create2Deployer.deploy(salt, creationCode));
                return deployed;
            }
        }
        revert("ordered token salt not found");
    }

    function _deployHook(IERC20 pipedog_, ILayPipeRewardVault vault_) private returns (PipeDogFeeHook deployed) {
        bytes memory args = abi.encode(manager, address(this), pipedog_, vault_);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), _requiredFlags(), type(PipeDogFeeHook).creationCode, args);
        deployed = new PipeDogFeeHook{salt: salt}(manager, address(this), pipedog_, vault_);
        assertEq(address(deployed), predicted);
    }

    function _requiredFlags() private pure returns (uint160) {
        return Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;
    }
}

contract LayPipeSingletonFullIntegrationTest is Test {
    uint256 internal constant NFT_UNIT = 100_000 ether;
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant START_TICK = 0;
    address internal constant TRADER = address(0xB0B);

    IPoolManager internal manager;
    SingletonMockERC20 internal pipedog;
    LayPipeHybridToken internal token;
    PipeDogRewards internal vault;
    DN404Mirror internal mirror;
    PipeDogFeeHook internal hook;
    LayPipeSingletonLauncher internal launcher;
    LayPipeSingletonSwapRouter internal router;

    function setUp() public {
        manager = IPoolManager(address(new SingletonPoolManagerMock()));
        pipedog = new SingletonMockERC20("PipeDog", "PIPEDOG");
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

        token.approve(address(launcher), token.INITIAL_SUPPLY());
        launcher.launch();
        token.releaseInitialSupplyOwner();
        pipedog.mint(TRADER, 1_000_000 ether);
    }

    function testBuyMintsPipeDogAndTradeFeeClaimsAsPipedog() public {
        assertEq(mirror.totalSupply(), 0);
        assertTrue(token.initialSupplyOwnerReleased());
        assertEq(token.balanceOf(address(manager)), token.INITIAL_SUPPLY());

        uint256 pipedogIn = 200_000 ether;
        uint256 expectedFee = pipedogIn / 100;
        vm.prank(TRADER);
        pipedog.approve(address(router), pipedogIn);
        vm.prank(TRADER);
        uint256 laypipeOut = router.buy(pipedogIn, NFT_UNIT, TRADER, type(uint256).max);

        assertEq(laypipeOut, pipedogIn - expectedFee);
        assertEq(mirror.balanceOf(TRADER), 1);
        assertEq(vault.eligibleUnitsOf(TRADER), 1);
        assertEq(vault.claimable(TRADER), expectedFee);
        assertEq(manager.balanceOf(address(vault), vault.pipedogClaimId()), expectedFee);

        uint256 beforeClaim = pipedog.balanceOf(TRADER);
        vm.prank(TRADER);
        assertEq(vault.claim(), expectedFee);
        assertEq(pipedog.balanceOf(TRADER), beforeClaim + expectedFee);
        assertEq(manager.balanceOf(address(vault), vault.pipedogClaimId()), 0);
        assertEq(vault.claimable(TRADER), 0);
    }

    function testEverySystemHolderIsExcludedBeforeLaunch() public view {
        assertTrue(token.isExcluded(address(launcher)));
        assertTrue(token.isExcluded(address(hook)));
        assertTrue(token.isExcluded(address(manager)));
        assertTrue(token.isExcluded(address(router)));
        assertEq(mirror.balanceOf(address(launcher)), 0);
        assertEq(mirror.balanceOf(address(manager)), 0);
        assertEq(vault.totalEligibleUnits(), 0);
    }

    function _deployOrderedHybrid() private returns (LayPipeHybridToken deployed) {
        SingletonCreate2Deployer create2Deployer = new SingletonCreate2Deployer();
        bytes memory creationCode = abi.encodePacked(
            type(LayPipeHybridToken).creationCode,
            abi.encode(address(this), IERC20(address(pipedog)), manager, address(this), "ipfs://pipedogs/")
        );
        bytes32 initCodeHash = keccak256(creationCode);
        for (uint256 i; i < 10_000; ++i) {
            bytes32 salt = bytes32(i);
            address predicted = create2Deployer.compute(salt, initCodeHash);
            if (predicted > address(pipedog)) {
                deployed = LayPipeHybridToken(payable(create2Deployer.deploy(salt, creationCode)));
                assertEq(address(deployed), predicted);
                return deployed;
            }
        }
        revert("ordered hybrid salt not found");
    }

    function _deployHook() private returns (PipeDogFeeHook deployed) {
        bytes memory args =
            abi.encode(manager, address(this), IERC20(address(pipedog)), ILayPipeRewardVault(address(vault)));
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
}
