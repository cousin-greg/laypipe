// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/src/libraries/FixedPoint96.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "./lib/CurrencySettler.sol";
import {LiquidityAmounts} from "./lib/LiquidityAmounts.sol";
import {PipeDogFeeHook} from "./PipeDogFeeHook.sol";

/// @title LayPipeSingletonLauncher
/// @notice One-time initializer for the permanent PIPEDOG/LAYPIPE bonding pool.
/// @dev The token, price, spacing and hook are constructor-bound. There are no
///      public launch configurations and no path to create a second pool.
contract LayPipeSingletonLauncher is ReentrancyGuard, IUnlockCallback {
    using CurrencySettler for Currency;
    using PoolIdLibrary for PoolKey;

    error NotPoolManager();
    error AlreadyLaunched();
    error InvalidInfrastructure();
    error InvalidTokenOrdering(address token, address pipedog);
    error InvalidTickConfig();
    error ZeroSupply();
    error SupplyMismatch(uint256 expected, uint256 actual);
    error SeedRequiresPipedog();
    error ValueTooLarge();
    error ResidualTokenBalance(uint256 amount);

    event Launched(
        address indexed laypipeToken,
        PoolId indexed poolId,
        uint256 supply,
        int24 startTick,
        int24 tickSpacing,
        uint128 liquidity
    );
    event LaunchDustReturned(address indexed recipient, uint256 amount);

    struct SeedData {
        PoolKey key;
        uint256 supply;
    }

    IPoolManager public immutable poolManager;
    IERC20 public immutable pipedog;
    IERC20 public immutable laypipeToken;
    PipeDogFeeHook public immutable hook;
    int24 public immutable tickSpacing;
    int24 public immutable startTick;
    PoolId public immutable configuredPoolId;

    bool public launched;
    /// @notice Unavoidable sub-liquidity-quantum LAYPIPE rounding dust returned
    ///         to the still-excluded initial supply owner during launch.
    uint256 public launchDust;

    bytes4 private constant GET_SYSTEM_EXCLUSIONS_CONFIGURED = bytes4(keccak256("systemExclusionsConfigured()"));
    bytes4 private constant GET_INITIAL_SUPPLY_OWNER = bytes4(keccak256("initialSupplyOwner()"));
    bytes4 private constant GET_IS_EXCLUDED = bytes4(keccak256("isExcluded(address)"));

    constructor(
        IPoolManager poolManager_,
        IERC20 pipedog_,
        IERC20 laypipeToken_,
        PipeDogFeeHook hook_,
        int24 tickSpacing_,
        int24 startTick_
    ) {
        if (
            address(poolManager_).code.length == 0 || address(pipedog_).code.length == 0
                || address(laypipeToken_).code.length == 0 || address(hook_).code.length == 0
                || address(hook_.poolManager()) != address(poolManager_)
                || address(hook_.pipedog()) != address(pipedog_) || hook_.launcher() != address(0)
        ) revert InvalidInfrastructure();
        if (address(laypipeToken_) <= address(pipedog_)) {
            revert InvalidTokenOrdering(address(laypipeToken_), address(pipedog_));
        }
        if (
            tickSpacing_ < TickMath.MIN_TICK_SPACING || tickSpacing_ > TickMath.MAX_TICK_SPACING
                || startTick_ <= TickMath.minUsableTick(tickSpacing_)
                || startTick_ > TickMath.maxUsableTick(tickSpacing_) || startTick_ % tickSpacing_ != 0
        ) revert InvalidTickConfig();

        poolManager = poolManager_;
        pipedog = pipedog_;
        laypipeToken = laypipeToken_;
        hook = hook_;
        tickSpacing = tickSpacing_;
        startTick = startTick_;
        configuredPoolId = poolKey().toId();
    }

    function poolKey() public view returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(pipedog)),
            currency1: Currency.wrap(address(laypipeToken)),
            fee: 0,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(hook))
        });
    }

    /// @notice Pulls the complete fixed supply from the caller and permanently seeds the pool.
    function launch() external nonReentrant returns (PoolId id, uint128 liquidity) {
        if (launched) revert AlreadyLaunched();
        if (
            hook.launcher() != address(this) || hook.canonicalRouter() == address(0)
                || !_systemConfigurationValid(msg.sender)
        ) {
            revert InvalidInfrastructure();
        }
        uint256 supply = _totalSupply();
        if (supply == 0) revert ZeroSupply();
        uint256 allowance = laypipeToken.allowance(msg.sender, address(this));
        if (allowance != supply) revert SupplyMismatch(supply, allowance);

        uint256 floor = laypipeToken.balanceOf(address(this));
        bool transferred = laypipeToken.transferFrom(msg.sender, address(this), supply);
        if (!transferred) revert SupplyMismatch(supply, 0);
        uint256 received = laypipeToken.balanceOf(address(this)) - floor;
        if (received != supply) revert SupplyMismatch(supply, received);

        PoolKey memory key = poolKey();
        id = hook.registerPool(key);
        if (PoolId.unwrap(id) != PoolId.unwrap(configuredPoolId)) {
            revert InvalidInfrastructure();
        }
        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(startTick));
        launched = true;
        liquidity = abi.decode(poolManager.unlock(abi.encode(SeedData(key, supply))), (uint128));
        uint256 residual = laypipeToken.balanceOf(address(this));
        uint256 dust = residual - floor;
        if (dust >= launchDustLimit()) revert ResidualTokenBalance(dust);
        launchDust = dust;
        if (dust != 0) {
            bool returned = laypipeToken.transfer(msg.sender, dust);
            if (!returned || laypipeToken.balanceOf(address(this)) != floor) revert ResidualTokenBalance(dust);
            emit LaunchDustReturned(msg.sender, dust);
        }
        emit Launched(address(laypipeToken), id, supply, startTick, tickSpacing, liquidity);
    }

    /// @notice The amount of token1 represented by one liquidity unit, rounded up.
    /// @dev Floor-derived seed liquidity guarantees legitimate residual dust is
    ///      strictly smaller than this value.
    function launchDustLimit() public view returns (uint256) {
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(tickSpacing));
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(startTick);
        return FullMath.mulDivRoundingUp(1, uint256(sqrtUpper) - uint256(sqrtLower), FixedPoint96.Q96);
    }

    function _totalSupply() private view returns (uint256 supply) {
        (bool ok, bytes memory result) = address(laypipeToken).staticcall(abi.encodeWithSignature("INITIAL_SUPPLY()"));
        if (!ok || result.length != 32) revert InvalidInfrastructure();
        supply = abi.decode(result, (uint256));
        if (laypipeToken.totalSupply() != supply) {
            revert SupplyMismatch(supply, laypipeToken.totalSupply());
        }
    }

    function _systemConfigurationValid(address supplyOwner) private view returns (bool) {
        address tokenAddress = address(laypipeToken);
        (bool configuredOk, bool configured) = _boolGetter(tokenAddress, GET_SYSTEM_EXCLUSIONS_CONFIGURED, "");
        (bool ownerOk, address expectedOwner) = _addressGetter(tokenAddress, GET_INITIAL_SUPPLY_OWNER);
        address router = hook.canonicalRouter();
        return configuredOk && configured && ownerOk && expectedOwner == supplyOwner
            && _excluded(tokenAddress, supplyOwner) && _excluded(tokenAddress, address(this))
            && _excluded(tokenAddress, address(hook)) && _excluded(tokenAddress, address(poolManager))
            && _excluded(tokenAddress, router);
    }

    function _excluded(address tokenAddress, address account) private view returns (bool) {
        (bool ok, bool value) = _boolGetter(tokenAddress, GET_IS_EXCLUDED, abi.encode(account));
        return ok && value;
    }

    function _addressGetter(address target, bytes4 selector) private view returns (bool ok, address value) {
        bytes memory data;
        (ok, data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length != 32) return (false, address(0));
        value = abi.decode(data, (address));
    }

    function _boolGetter(address target, bytes4 selector, bytes memory args)
        private
        view
        returns (bool ok, bool value)
    {
        bytes memory data;
        (ok, data) = target.staticcall(bytes.concat(abi.encodeWithSelector(selector), args));
        if (!ok || data.length != 32) return (false, false);
        value = abi.decode(data, (bool));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        SeedData memory data = abi.decode(rawData, (SeedData));

        int24 lowerTick = TickMath.minUsableTick(tickSpacing);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lowerTick);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(startTick);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, data.supply);
        if (liquidity == 0 || uint256(liquidity) > uint256(uint128(type(int128).max))) revert ValueTooLarge();

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            data.key,
            ModifyLiquidityParams({
                tickLower: lowerTick, tickUpper: startTick, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)
            }),
            ""
        );
        if (delta.amount0() != 0 || delta.amount1() >= 0) {
            revert SeedRequiresPipedog();
        }
        uint256 tokenOwed = uint256(uint128(-delta.amount1()));
        data.key.currency1.settle(poolManager, address(this), tokenOwed, false);
        return abi.encode(liquidity);
    }
}
