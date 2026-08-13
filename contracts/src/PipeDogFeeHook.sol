// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {ILayPipeRewardVault} from "./interfaces/ILayPipeRewardVault.sol";

/// @title PipeDogFeeHook
/// @notice Immutable fee and liquidity policy for the single PIPEDOG/LAYPIPE pool.
/// @dev Charges exactly 1% of the PIPEDOG side of every swap. All collected
///      PIPEDOG becomes an ERC6909 PoolManager claim owned by the PipeDog
///      reward vault in the same swap callback; there is no creator,
///      developer, treasury, keeper, or sweep share.
contract PipeDogFeeHook is BaseHook {
    using CurrencyLibrary for Currency;
    using PoolIdLibrary for PoolKey;
    using SafeCast for int256;

    error NotLauncher();
    error NotConfigurator();
    error LauncherAlreadySet();
    error RouterAlreadySet();
    error InvalidLauncherBinding();
    error InvalidRouterBinding();
    error NotCanonicalRouter();
    error InvalidVaultBinding();
    error AlreadyRegistered();
    error InvalidPoolKey();
    error ZeroAddress();
    error LiquidityLocked();
    error LiquidityAlreadySeeded();
    error DonationsLocked();
    error PartialFillRejected();

    event PoolRegistered(PoolId indexed poolId, address indexed laypipeToken);
    event FeeAccrued(PoolId indexed poolId, uint256 amount);
    event RewardsFunded(PoolId indexed poolId, uint256 amount);

    uint256 public constant FEE_DENOMINATOR = 1e6;
    uint256 public constant FEE_RATE = 10_000; // 1% in Uniswap pips.

    bytes4 private constant GET_POOL_MANAGER = bytes4(keccak256("poolManager()"));
    bytes4 private constant GET_PIPEDOG = bytes4(keccak256("pipedog()"));
    bytes4 private constant GET_CONFIGURATOR = bytes4(keccak256("configurator()"));
    bytes4 private constant GET_TOKEN = bytes4(keccak256("token()"));
    bytes4 private constant GET_REWARD_NOTIFIER = bytes4(keccak256("rewardNotifier()"));
    bytes4 private constant GET_HOOK = bytes4(keccak256("hook()"));
    bytes4 private constant GET_LAUNCHER = bytes4(keccak256("launcher()"));
    bytes4 private constant GET_LAYPIPE_TOKEN = bytes4(keccak256("laypipeToken()"));
    bytes4 private constant GET_POOL_ID = bytes4(keccak256("poolId()"));
    bytes4 private constant GET_CONFIGURED_POOL_ID = bytes4(keccak256("configuredPoolId()"));

    address public immutable configurator;
    IERC20 public immutable pipedog;
    ILayPipeRewardVault public immutable rewardVault;

    address public launcher;
    address public canonicalRouter;
    PoolId public poolId;
    address public laypipeToken;
    int24 public tickSpacing;
    bool public registered;
    bool public seeded;

    constructor(IPoolManager poolManager_, address configurator_, IERC20 pipedog_, ILayPipeRewardVault rewardVault_)
        BaseHook(poolManager_)
    {
        if (
            address(poolManager_).code.length == 0 || configurator_ == address(0) || address(pipedog_).code.length == 0
                || address(rewardVault_).code.length == 0
        ) revert ZeroAddress();
        if (
            !_addressGetterMatches(address(rewardVault_), GET_POOL_MANAGER, address(poolManager_))
                || !_addressGetterMatches(address(rewardVault_), GET_PIPEDOG, address(pipedog_))
                || !_addressGetterMatches(address(rewardVault_), GET_CONFIGURATOR, configurator_)
                || !_hasNonzeroCodeAddressGetter(address(rewardVault_), GET_TOKEN)
        ) revert InvalidVaultBinding();
        configurator = configurator_;
        pipedog = pipedog_;
        rewardVault = rewardVault_;
    }

    /// @notice Resolves the hook/launcher deployment-order cycle exactly once.
    /// @dev The hook address must first be mined for its v4 permission bits;
    ///      the launcher is then deployed with that address and bound here.
    function setLauncher(address launcher_) external {
        if (msg.sender != configurator) revert NotConfigurator();
        if (launcher != address(0)) revert LauncherAlreadySet();
        if (launcher_.code.length == 0) revert ZeroAddress();
        address vaultToken = _vaultToken();
        if (
            !_addressGetterMatches(launcher_, GET_HOOK, address(this))
                || !_addressGetterMatches(launcher_, GET_POOL_MANAGER, address(poolManager))
                || !_addressGetterMatches(launcher_, GET_PIPEDOG, address(pipedog))
                || !_addressGetterMatches(launcher_, GET_LAYPIPE_TOKEN, vaultToken)
        ) revert InvalidLauncherBinding();
        launcher = launcher_;
    }

    /// @notice Permanently binds swaps to the one excluded LayPipe router.
    function setCanonicalRouter(address router_) external {
        if (msg.sender != configurator) revert NotConfigurator();
        if (canonicalRouter != address(0)) revert RouterAlreadySet();
        if (router_.code.length == 0) revert ZeroAddress();
        if (launcher == address(0)) revert InvalidRouterBinding();
        address vaultToken = _vaultToken();
        (bool routerPoolOk, bytes32 routerPool) = _bytes32Getter(router_, GET_POOL_ID);
        (bool launcherPoolOk, bytes32 launcherPool) = _bytes32Getter(launcher, GET_CONFIGURED_POOL_ID);
        if (
            !_addressGetterMatches(router_, GET_HOOK, address(this))
                || !_addressGetterMatches(router_, GET_POOL_MANAGER, address(poolManager))
                || !_addressGetterMatches(router_, GET_PIPEDOG, address(pipedog))
                || !_addressGetterMatches(router_, GET_LAYPIPE_TOKEN, vaultToken)
                || !_addressGetterMatches(router_, GET_LAUNCHER, launcher) || !routerPoolOk || !launcherPoolOk
                || routerPool != launcherPool
        ) revert InvalidRouterBinding();
        canonicalRouter = router_;
    }

    /// @notice Verifies the reward vault is irrevocably wired to this hook.
    function vaultBindingValid() public view returns (bool) {
        return _addressGetterMatches(address(rewardVault), GET_REWARD_NOTIFIER, address(this))
            && _addressGetterMatches(address(rewardVault), GET_POOL_MANAGER, address(poolManager))
            && _addressGetterMatches(address(rewardVault), GET_PIPEDOG, address(pipedog))
            && _addressGetterMatches(address(rewardVault), GET_CONFIGURATOR, configurator)
            && _hasNonzeroCodeAddressGetter(address(rewardVault), GET_TOKEN);
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    /// @notice Permanently binds this hook to one PIPEDOG/LAYPIPE pool.
    function registerPool(PoolKey calldata key) external returns (PoolId id) {
        if (launcher == address(0) || msg.sender != launcher) {
            revert NotLauncher();
        }
        if (registered) revert AlreadyRegistered();
        if (!vaultBindingValid()) revert InvalidVaultBinding();
        _validateUnregisteredKey(key);
        if (Currency.unwrap(key.currency1) != _vaultToken()) {
            revert InvalidVaultBinding();
        }

        id = key.toId();
        poolId = id;
        laypipeToken = Currency.unwrap(key.currency1);
        tickSpacing = key.tickSpacing;
        registered = true;
        emit PoolRegistered(id, laypipeToken);
    }

    function isRegistered(PoolId id) external view returns (bool) {
        return registered && PoolId.unwrap(id) == PoolId.unwrap(poolId);
    }

    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (launcher == address(0) || sender != launcher) {
            revert NotLauncher();
        }
        _requirePool(key);
        return this.beforeInitialize.selector;
    }

    function _beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        if (launcher == address(0) || sender != launcher) {
            revert NotLauncher();
        }
        _requirePool(key);
        if (seeded) revert LiquidityAlreadySeeded();
        seeded = true;
        return this.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityLocked();
    }

    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonationsLocked();
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (canonicalRouter == address(0) || sender != canonicalRouter) {
            revert NotCanonicalRouter();
        }
        _requirePool(key);
        bool quoteSpecified = (params.amountSpecified < 0) == params.zeroForOne;
        if (!quoteSpecified) {
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 specified = _absolute(params.amountSpecified);
        uint256 fee = _feeForSpecifiedAmount(specified, params.amountSpecified > 0);
        _accrue(fee);
        if (fee == 0) {
            return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        return (this.beforeSwap.selector, toBeforeSwapDelta(int256(fee).toInt128(), 0), 0);
    }

    function _afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        if (canonicalRouter == address(0) || sender != canonicalRouter) {
            revert NotCanonicalRouter();
        }
        _requirePool(key);
        bool quoteSpecified = (params.amountSpecified < 0) == params.zeroForOne;
        if (quoteSpecified) {
            uint256 specified = _absolute(params.amountSpecified);
            uint256 specifiedFee = _feeForSpecifiedAmount(specified, params.amountSpecified > 0);
            uint256 poolQuoteMoved = _absolute(delta.amount0());
            uint256 fullFill = params.amountSpecified < 0 ? specified - specifiedFee : specified + specifiedFee;
            if (poolQuoteMoved != fullFill) revert PartialFillRejected();
            return (this.afterSwap.selector, 0);
        }

        uint256 quoteMoved = _absolute(delta.amount0());
        uint256 fee = _feeForUnspecifiedAmount(quoteMoved, params.amountSpecified > 0);
        _accrue(fee);
        return (this.afterSwap.selector, fee == 0 ? int128(0) : int256(fee).toInt128());
    }

    function _accrue(uint256 fee) private {
        emit FeeAccrued(poolId, fee);
        if (fee == 0) return;
        poolManager.mint(address(rewardVault), Currency.wrap(address(pipedog)).toId(), fee);
        rewardVault.notifyRewardClaim(fee);
        emit RewardsFunded(poolId, fee);
    }

    function _feeForSpecifiedAmount(uint256 amount, bool exactOutput) private pure returns (uint256) {
        return exactOutput
            ? FullMath.mulDivRoundingUp(amount, FEE_RATE, FEE_DENOMINATOR - FEE_RATE)
            : FullMath.mulDiv(amount, FEE_RATE, FEE_DENOMINATOR);
    }

    function _feeForUnspecifiedAmount(uint256 amount, bool exactOutput) private pure returns (uint256) {
        return exactOutput
            ? FullMath.mulDivRoundingUp(amount, FEE_RATE, FEE_DENOMINATOR - FEE_RATE)
            : FullMath.mulDiv(amount, FEE_RATE, FEE_DENOMINATOR);
    }

    function _requirePool(PoolKey calldata key) private view {
        if (!registered || PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert InvalidPoolKey();
        _validateUnregisteredKey(key);
    }

    function _validateUnregisteredKey(PoolKey calldata key) private view {
        if (
            Currency.unwrap(key.currency0) != address(pipedog) || Currency.unwrap(key.currency1) == address(0)
                || Currency.unwrap(key.currency1) <= address(pipedog) || address(key.hooks) != address(this)
                || key.fee != 0
        ) revert InvalidPoolKey();
    }

    function _absolute(int256 value) private pure returns (uint256) {
        return uint256(value < 0 ? -value : value);
    }

    function _vaultToken() private view returns (address token_) {
        (bool ok, address value) = _addressGetter(address(rewardVault), GET_TOKEN);
        if (!ok || value.code.length == 0) revert InvalidVaultBinding();
        return value;
    }

    function _hasNonzeroCodeAddressGetter(address target, bytes4 selector) private view returns (bool) {
        (bool ok, address value) = _addressGetter(target, selector);
        return ok && value.code.length != 0;
    }

    function _addressGetterMatches(address target, bytes4 selector, address expected) private view returns (bool) {
        (bool ok, address value) = _addressGetter(target, selector);
        return ok && value == expected;
    }

    function _addressGetter(address target, bytes4 selector) private view returns (bool ok, address value) {
        bytes memory data;
        (ok, data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length != 32) return (false, address(0));
        value = abi.decode(data, (address));
    }

    function _bytes32Getter(address target, bytes4 selector) private view returns (bool ok, bytes32 value) {
        bytes memory data;
        (ok, data) = target.staticcall(abi.encodeWithSelector(selector));
        if (!ok || data.length != 32) return (false, bytes32(0));
        value = abi.decode(data, (bytes32));
    }
}
