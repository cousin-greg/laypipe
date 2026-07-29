// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CurrencySettler} from "./lib/CurrencySettler.sol";
import {PipedogHook} from "./PipedogHook.sol";
import {LaypipeToken} from "./LaypipeToken.sol";

/// @title LaypipeSelfBurner
/// @notice Claims a self-burn pool's creator-fee lane in PIPEDOG, buys that
/// launched token on its permanent v4 curve, and calls the launched token's
/// real burn(). PIPEDOG itself is never burned by this contract.
contract LaypipeSelfBurner is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using SafeERC20 for IERC20;

    error NotFactory();
    error NotPoolManager();
    error UnknownPool();
    error AlreadyRegistered();
    error InvalidPool();
    error InvalidConfig();
    error NothingToBurn();
    error BurnedThisBlock();
    error QuoteTransferMismatch(uint256 expected, uint256 actual);

    event Burned(
        PoolId indexed poolId,
        address indexed token,
        uint256 pipedogIn,
        uint256 tokensBurned,
        uint256 pipedogBounty
    );

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_BOUNTY_BPS = 1_000;

    IPoolManager public immutable poolManager;
    PipedogHook public immutable hook;
    IERC20 public immutable quoteToken;
    address public immutable factory;
    uint256 public immutable maxBurnPerCall;
    uint16 public immutable bountyBps;

    mapping(PoolId => PoolKey) private _keys;
    /// @notice Claimed PIPEDOG waiting to buy and burn a launched token.
    mapping(PoolId => uint256) public unburned;
    mapping(PoolId => uint256) private _lastBurnBlock;

    constructor(
        IPoolManager poolManager_,
        PipedogHook hook_,
        address factory_,
        uint256 maxBurnPerCall_,
        uint16 bountyBps_
    ) {
        if (
            address(poolManager_) == address(0)
                || address(hook_).code.length == 0
                || factory_ == address(0)
                || address(hook_.poolManager()) != address(poolManager_)
                || hook_.factory() != factory_
        ) revert InvalidPool();
        if (
            maxBurnPerCall_ == 0
                || bountyBps_ > MAX_BOUNTY_BPS
        ) revert InvalidConfig();
        poolManager = poolManager_;
        hook = hook_;
        quoteToken = hook_.quoteToken();
        factory = factory_;
        maxBurnPerCall = maxBurnPerCall_;
        bountyBps = bountyBps_;
    }

    function register(PoolId poolId, PoolKey calldata key) external {
        if (msg.sender != factory) revert NotFactory();
        if (Currency.unwrap(_keys[poolId].currency1) != address(0)) {
            revert AlreadyRegistered();
        }
        if (
            Currency.unwrap(key.currency0) != address(quoteToken)
                || Currency.unwrap(key.currency1) == address(0)
                || address(key.hooks) != address(hook)
        ) revert InvalidPool();
        _keys[poolId] = key;
    }

    /// @notice Claims PIPEDOG fee fuel and executes one bounded self-burn.
    function burn(PoolId poolId)
        external
        nonReentrant
        returns (uint256 tokensBurned)
    {
        PoolKey memory key = _keys[poolId];
        if (Currency.unwrap(key.currency1) == address(0)) {
            revert UnknownPool();
        }
        if (_lastBurnBlock[poolId] == block.number) {
            revert BurnedThisBlock();
        }
        _lastBurnBlock[poolId] = block.number;

        if (hook.pending(poolId) > 0 || hook.tab(poolId) > 0) {
            uint256 beforeBalance =
                quoteToken.balanceOf(address(this));
            uint256 claimed = hook.claim(poolId);
            uint256 received =
                quoteToken.balanceOf(address(this)) - beforeBalance;
            if (received != claimed) {
                revert QuoteTransferMismatch(claimed, received);
            }
            unburned[poolId] += claimed;
        }

        uint256 fuel = unburned[poolId];
        if (fuel == 0) revert NothingToBurn();
        uint256 chunk =
            fuel > maxBurnPerCall ? maxBurnPerCall : fuel;
        unburned[poolId] = fuel - chunk;

        uint256 bounty = (chunk * bountyBps) / BPS_DENOMINATOR;
        uint256 burnQuote = chunk - bounty;
        (uint256 tokensOut, uint256 quoteSpent) = abi.decode(
            poolManager.unlock(abi.encode(key, burnQuote)),
            (uint256, uint256)
        );
        if (quoteSpent < burnQuote) {
            unburned[poolId] += burnQuote - quoteSpent;
        }
        if (tokensOut == 0) revert NothingToBurn();

        tokensBurned = tokensOut;
        _pushExact(msg.sender, bounty);
        emit Burned(
            poolId,
            Currency.unwrap(key.currency1),
            quoteSpent,
            tokensBurned,
            bounty
        );
    }

    function unlockCallback(bytes calldata data)
        external
        returns (bytes memory)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, uint256 quoteIn) =
            abi.decode(data, (PoolKey, uint256));
        if (quoteIn > uint256(type(int256).max)) {
            revert InvalidConfig();
        }

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(quoteIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            ""
        );
        if (delta.amount0() >= 0 || delta.amount1() <= 0) {
            revert InvalidPool();
        }
        uint256 tokensOut = uint256(uint128(delta.amount1()));
        uint256 quoteSpent = uint256(uint128(-delta.amount0()));
        key.currency0.settle(
            poolManager, address(this), quoteSpent, false
        );
        key.currency1.take(
            poolManager, address(this), tokensOut, false
        );
        LaypipeToken(Currency.unwrap(key.currency1)).burn(tokensOut);
        return abi.encode(tokensOut, quoteSpent);
    }

    function poolKeyOf(PoolId poolId)
        external
        view
        returns (PoolKey memory)
    {
        return _keys[poolId];
    }

    function _pushExact(address recipient, uint256 amount) private {
        if (amount == 0) return;
        uint256 senderBefore = quoteToken.balanceOf(address(this));
        uint256 recipientBefore = quoteToken.balanceOf(recipient);
        quoteToken.safeTransfer(recipient, amount);
        uint256 sent =
            senderBefore - quoteToken.balanceOf(address(this));
        uint256 received =
            quoteToken.balanceOf(recipient) - recipientBefore;
        if (sent != amount || received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
    }
}
