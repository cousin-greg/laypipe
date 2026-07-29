// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "uniswap-hooks/base/BaseHook.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

/// @title PipedogHook
/// @notice The fee engine for Laypipe pools. Takes the trading fee from the
///         PIPEDOG side of every exact-input and exact-output swap. PIPEDOG is
///         always currency0; launch addresses are mined above its address.
///
///         Fees move in two lanes: `sweep(poolId)` is permissionless and pays
///         the platform share to the treasury while crediting the creator
///         share to the creator's unclaimed balance; `claim(poolId)` — fee
///         recipient only — sweeps, then pays the balance in PIPEDOG.
///
///         Trust model — not upgradeable. Only the factory can register pools
///         or add liquidity. Unclaimed creator balances can only ever move to
///         the creator; the owner can only redirect the platform's own share.
contract PipedogHook is BaseHook, Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeCast for int256;
    using SafeERC20 for IERC20;

    struct PoolConfig {
        address creator; // receives the fee stream; can hand off via updateCreator
        uint40 launchTime;
        uint16 creatorFeeBps; // creator's share of fees, fixed at launch
        uint24 baseFeeRate; // steady-state fee, pips of the PIPEDOG side
        uint24 launchFeeRate; // fee at launch, decays to baseFeeRate; == base when off
        uint32 launchFeeDecay; // decay window in seconds; 0 = off
        bool exists;
    }

    error NotFactory();
    error UnknownPool();
    error NotCreator();
    error AlreadyRegistered();
    error InvalidPoolKey();
    error InvalidFeeConfig();
    error ZeroAddress();
    error QuoteTransferMismatch(uint256 expected, uint256 actual);
    error LiquidityLocked();
    error LiquidityAlreadySeeded();
    error DonationsLocked();
    error PartialFillRejected();

    event PoolRegistered(PoolId indexed poolId, address indexed creator, PoolConfig config);
    /// @notice The exact PIPEDOG fee taken by a swap — indexers mirror fees
    ///         from this rather than inferring them from swap amounts.
    event FeeAccrued(PoolId indexed poolId, uint256 amount);
    event FeesSwept(PoolId indexed poolId, address indexed caller, uint256 creatorAmount, uint256 platformAmount);
    event CreatorFeesClaimed(PoolId indexed poolId, address indexed creator, uint256 amount);
    event CreatorUpdated(PoolId indexed poolId, address indexed oldCreator, address indexed newCreator);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant FEE_DENOMINATOR = 1e6;
    /// @dev Hard ceiling on any fee rate: 90% — a fee can never consume a swap.
    uint256 public constant MAX_FEE_RATE = 900_000;

    /// @notice The only address allowed to register pools and add liquidity.
    address public immutable factory;
    /// @notice Canonical PIPEDOG quote/payment token.
    IERC20 public immutable quoteToken;
    /// @notice Receives the platform share of swept fees. Owner-settable.
    address public treasury;

    mapping(PoolId => PoolConfig) public poolConfigs;
    /// @notice True once a pool has received its single seed liquidity add.
    ///         Every later add reverts — even from the factory, even after a
    ///         factory upgrade — so a launched pool's depth is frozen for good.
    mapping(PoolId => bool) public seeded;
    /// @notice PIPEDOG fees not yet swept, held as PoolManager claims.
    mapping(PoolId => uint256) public pending;
    /// @notice Creator's swept-but-unclaimed PIPEDOG, per pool.
    mapping(PoolId => uint256) public tab;
    constructor(
        IPoolManager poolManager_,
        address factory_,
        IERC20 quoteToken_,
        address treasury_,
        address owner_
    )
        BaseHook(poolManager_)
        Ownable(owner_)
    {
        if (
            factory_ == address(0) || treasury_ == address(0)
                || address(quoteToken_).code.length == 0
        ) revert ZeroAddress();
        factory = factory_;
        quoteToken = quoteToken_;
        treasury = treasury_;
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

    // —————————————————————————— registration ——————————————————————————

    /// @notice True once a pool's one exempt first buy has been taken. The
    ///         creator's launch-transaction buy is exempt from the anti-snipe
    ///         premium exactly once; every later factory-originated swap
    ///         (including any from a future malicious factory upgrade) pays the
    ///         normal decayed rate. Combined with the launch-block guard below,
    ///         the exemption is both one-shot and confined to the launch block.
    mapping(PoolId => bool) public firstBuyExemptionSpent;

    /// @notice Called by the factory before pool initialization.
    function register(
        PoolId poolId,
        address creator,
        uint16 creatorFeeBps,
        uint24 baseFeeRate,
        uint24 launchFeeRate,
        uint32 launchFeeDecay
    ) external {
        if (msg.sender != factory) revert NotFactory();
        if (poolConfigs[poolId].exists) revert AlreadyRegistered();
        if (creator == address(0)) revert ZeroAddress();
        if (
            creatorFeeBps > BPS_DENOMINATOR || launchFeeRate > MAX_FEE_RATE || baseFeeRate > launchFeeRate
        ) revert InvalidFeeConfig();
        PoolConfig memory config = PoolConfig({
            creator: creator,
            launchTime: uint40(block.timestamp),
            creatorFeeBps: creatorFeeBps,
            baseFeeRate: baseFeeRate,
            launchFeeRate: launchFeeRate,
            launchFeeDecay: launchFeeDecay,
            exists: true
        });
        poolConfigs[poolId] = config;
        emit PoolRegistered(poolId, creator, config);
    }

    function isRegistered(PoolId poolId) external view returns (bool) {
        return poolConfigs[poolId].exists;
    }

    /// @dev True iff this swap is the pool's one exempt first buy: a
    ///      factory-originated swap, in the launch block, not yet consumed.
    function _isExemptFirstBuy(PoolId poolId, address swapper, PoolConfig memory config)
        private
        view
        returns (bool)
    {
        return swapper == factory && !firstBuyExemptionSpent[poolId]
            && block.timestamp == config.launchTime;
    }

    /// @notice Current fee rate for a pool in pips of the PIPEDOG side. During
    ///         launch window the rate decays linearly from launchFeeRate to
    ///         baseFeeRate. The creator's first buy pays the base rate only —
    ///         a single, self-consuming exemption (see firstBuyExemptionSpent).
    function currentFeeRate(PoolId poolId, address swapper) public view returns (uint256) {
        PoolConfig memory config = poolConfigs[poolId];
        if (!config.exists) revert UnknownPool();
        if (config.launchFeeDecay == 0) return config.baseFeeRate;
        if (_isExemptFirstBuy(poolId, swapper, config)) return config.baseFeeRate;
        uint256 elapsed = block.timestamp - config.launchTime;
        if (elapsed >= config.launchFeeDecay) return config.baseFeeRate;
        return config.baseFeeRate
            + (uint256(config.launchFeeRate) - config.baseFeeRate) * (config.launchFeeDecay - elapsed)
                / config.launchFeeDecay;
    }

    /// @dev Consume the one-shot first-buy exemption once it has been used, so
    ///      no second factory swap can ever claim the base rate during a live
    ///      launch window.
    function _consumeFirstBuyExemption(PoolId poolId, address swapper) private {
        if (swapper == factory && !firstBuyExemptionSpent[poolId]) {
            PoolConfig memory config = poolConfigs[poolId];
            if (config.launchFeeDecay != 0 && block.timestamp == config.launchTime) {
                firstBuyExemptionSpent[poolId] = true;
            }
        }
    }

    // —————————————————————————— hook callbacks ——————————————————————————

    /// @dev Only the factory may create pools with this hook, only with
    ///      canonical PIPEDOG as currency0 and a zero LP fee.
    function _beforeInitialize(address sender, PoolKey calldata key, uint160) internal view override returns (bytes4) {
        if (sender != factory) revert NotFactory();
        if (!poolConfigs[key.toId()].exists) revert UnknownPool();
        if (
            Currency.unwrap(key.currency0) != address(quoteToken)
                || Currency.unwrap(key.currency1) == address(0)
                || uint160(Currency.unwrap(key.currency1))
                    <= uint160(address(quoteToken)) || key.fee != 0
        ) revert InvalidPoolKey();
        return this.beforeInitialize.selector;
    }

    /// @dev The factory seeds liquidity exactly once, at launch. The one-shot
    ///      gate is enforced here, not merely by convention: the first add
    ///      marks the pool seeded and every subsequent add reverts — so no
    ///      future factory upgrade can change a launched pool's depth, and
    ///      combined with the removal gate a pool's liquidity is frozen the
    ///      moment it launches.
    function _beforeAddLiquidity(address sender, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        if (sender != factory) revert NotFactory();
        PoolId poolId = key.toId();
        if (seeded[poolId]) revert LiquidityAlreadySeeded();
        seeded[poolId] = true;
        return this.beforeAddLiquidity.selector;
    }

    /// @dev Liquidity in Pipedog pools is locked at the pool level: every
    ///      removal reverts, no matter who owns the position — including the
    ///      factory, and including any future upgrade of it. This hook is not
    ///      upgradeable, so the lock is absolute.
    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert LiquidityLocked();
    }

    /// @dev Donations are blocked: the seed position can never be modified, so
    ///      donated value would accrue as fees nobody can ever collect — a
    ///      black hole with a standard entrypoint. All value entering a
    ///      Pipedog pool moves through swaps, where the fee engine models it.
    function _beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        revert DonationsLocked();
    }

    /// @dev PIPEDOG is the specified currency on exact-in buys and exact-out
    ///      sells, so the fee is known pre-swap and skimmed here. Exact-output
    ///      fees are grossed up so the configured rate applies to total
    ///      PIPEDOG moved rather than only the recipient's net amount.
    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        bool quoteSpecified = (params.amountSpecified < 0) == params.zeroForOne;
        if (!quoteSpecified) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        PoolId poolId = key.toId();
        uint256 amount = uint256(
            params.amountSpecified < 0 ? -params.amountSpecified : params.amountSpecified
        );
        uint256 rate = currentFeeRate(poolId, sender);
        uint256 fee = params.amountSpecified > 0
            ? FullMath.mulDivRoundingUp(
                amount, rate, FEE_DENOMINATOR - rate
            )
            : FullMath.mulDiv(amount, rate, FEE_DENOMINATOR);
        // exactly one FeeAccrued per swap, on the hook that owns its fee side —
        // emitted even when the fee rounds to zero, so an off-chain indexer can
        // map events to swaps one-to-one by order within a transaction
        emit FeeAccrued(poolId, fee);
        if (fee == 0) return (this.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        poolManager.mint(
            address(this),
            Currency.wrap(address(quoteToken)).toId(),
            fee
        );
        pending[poolId] += fee;
        return (this.beforeSwap.selector, toBeforeSwapDelta(int256(fee).toInt128(), 0), 0);
    }

    /// @dev PIPEDOG is the unspecified currency on exact-out buys and
    ///      exact-in sells; the fee is based on actual quote moved. Exact-out
    ///      buys gross the fee up from the pool's net input.
    function _afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        bool quoteSpecified = (params.amountSpecified < 0) == params.zeroForOne;
        if (quoteSpecified) {
            // _beforeSwap charged the fee on the full specified quote amount; a
            // price-limited swap that only partially fills would therefore be
            // taxed on PIPEDOG that never traded. Refuse partial fills:
            // fill the pool moves exactly the post-fee specified amount, so
            // anything less means the price limit cut the swap short.
            uint256 specified = uint256(
                params.amountSpecified < 0 ? -params.amountSpecified : params.amountSpecified
            );
            uint256 specifiedRate =
                currentFeeRate(key.toId(), sender);
            uint256 specifiedFee = params.amountSpecified > 0
                ? FullMath.mulDivRoundingUp(
                    specified,
                    specifiedRate,
                    FEE_DENOMINATOR - specifiedRate
                )
                : FullMath.mulDiv(
                    specified, specifiedRate, FEE_DENOMINATOR
                );
            int128 amt0 = delta.amount0();
            uint256 poolQuoteMoved =
                uint256(uint128(amt0 < 0 ? -amt0 : amt0));
            uint256 fullFill = params.amountSpecified < 0
                ? specified - specifiedFee
                : specified + specifiedFee;
            if (poolQuoteMoved != fullFill) revert PartialFillRejected();
            // consume here — the last hook call for this swap — so _beforeSwap
            // and this branch computed the same (unconsumed) rate, and only the
            // NEXT factory swap loses the exemption
            _consumeFirstBuyExemption(key.toId(), sender);
            return (this.afterSwap.selector, 0);
        }

        PoolId poolId = key.toId();
        int128 amount0 = delta.amount0();
        uint256 quoteMoved =
            uint256(uint128(amount0 < 0 ? -amount0 : amount0));
        uint256 rate = currentFeeRate(poolId, sender);
        uint256 fee = params.amountSpecified > 0
            ? FullMath.mulDivRoundingUp(
                quoteMoved, rate, FEE_DENOMINATOR - rate
            )
            : FullMath.mulDiv(
                quoteMoved, rate, FEE_DENOMINATOR
            );
        // last hook call for this swap — consume the one-shot exemption (only
        // the next factory swap is affected; this swap's fee already computed)
        _consumeFirstBuyExemption(poolId, sender);
        // one FeeAccrued per swap, even at zero — see _beforeSwap
        emit FeeAccrued(poolId, fee);
        if (fee == 0) return (this.afterSwap.selector, 0);

        poolManager.mint(
            address(this),
            Currency.wrap(address(quoteToken)).toId(),
            fee
        );
        pending[poolId] += fee;
        return (this.afterSwap.selector, int256(fee).toInt128());
    }

    // —————————————————————————— fee payout ——————————————————————————

    /// @notice Redeems pending fee claims into PIPEDOG, routes the platform
    ///         share, and credits the creator share. Callable by anyone.
    function sweep(PoolId poolId) external nonReentrant returns (uint256 creatorAmount, uint256 platformAmount) {
        return _sweep(poolId);
    }

    /// @notice Pays the creator everything owed for a pool in PIPEDOG.
    function claim(PoolId poolId) external nonReentrant returns (uint256 amount) {
        PoolConfig storage config = poolConfigs[poolId];
        if (!config.exists) revert UnknownPool();
        if (msg.sender != config.creator) revert NotCreator();

        _sweep(poolId);

        address recipient = config.creator;
        amount = tab[poolId];
        tab[poolId] = 0;
        _pushExact(recipient, amount);
        emit CreatorFeesClaimed(poolId, recipient, amount);
    }

    function _sweep(PoolId poolId) private returns (uint256 creatorAmount, uint256 platformAmount) {
        PoolConfig memory config = poolConfigs[poolId];
        if (!config.exists) revert UnknownPool();

        uint256 amount = pending[poolId];
        if (amount == 0) return (0, 0);
        pending[poolId] = 0;

        // Redeem ERC6909 claims for canonical PIPEDOG.
        poolManager.unlock(abi.encode(amount));

        creatorAmount = (amount * config.creatorFeeBps) / BPS_DENOMINATOR;
        platformAmount = amount - creatorAmount;
        tab[poolId] += creatorAmount;
        _pushExact(treasury, platformAmount);
        emit FeesSwept(poolId, msg.sender, creatorAmount, platformAmount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = abi.decode(data, (uint256));
        Currency quoteCurrency = Currency.wrap(address(quoteToken));
        uint256 beforeBalance = quoteToken.balanceOf(address(this));
        poolManager.burn(address(this), quoteCurrency.toId(), amount);
        poolManager.take(quoteCurrency, address(this), amount);
        uint256 received =
            quoteToken.balanceOf(address(this)) - beforeBalance;
        if (received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
        return "";
    }

    // —————————————————————————— stream management ——————————————————————————

    /// @notice Lets a creator hand their fee stream to a new address (e.g. a
    ///         multisig). The unclaimed balance travels with the stream.
    function updateCreator(PoolId poolId, address newCreator) external {
        PoolConfig storage config = poolConfigs[poolId];
        if (!config.exists) revert UnknownPool();
        if (msg.sender != config.creator) revert NotCreator();
        if (newCreator == address(0)) revert ZeroAddress();
        emit CreatorUpdated(poolId, config.creator, newCreator);
        config.creator = newCreator;
    }

    /// @notice Redirects the platform's share only; creator balances are unaffected.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function _pushExact(address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 senderBefore = quoteToken.balanceOf(address(this));
        uint256 recipientBefore = quoteToken.balanceOf(to);
        quoteToken.safeTransfer(to, amount);
        uint256 sent =
            senderBefore - quoteToken.balanceOf(address(this));
        uint256 received =
            quoteToken.balanceOf(to) - recipientBefore;
        if (sent != amount || received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
    }
}
