// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "./lib/CurrencySettler.sol";
import {PipedogHook} from "./PipedogHook.sol";

/// @title LaypipeSwapRouter
/// @notice Exact-allowance PIPEDOG buy/sell entrypoint for Laypipe pools.
/// @dev PIPEDOG is always currency0 and launched tokens are mined above its
///      address. The router pulls only the exact requested input, refunds an
///      unspent partial fill, applies caller-provided minimum output, and never
///      accepts native value. Users should approve exact amounts, not unlimited
///      allowances, because this router is the ERC20 spender.
contract LaypipeSwapRouter is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    enum Action {
        BUY,
        SELL
    }

    struct UnlockData {
        Action action;
        PoolKey key;
        uint256 amountIn;
    }

    error NotPoolManager();
    error InvalidPool();
    error ZeroAddress();
    error ZeroAmount();
    error ValueTooLarge();
    error InvalidSwapDelta();
    error SlippageExceeded(uint256 minimum, uint256 actual);
    error AllowanceMismatch(uint256 expected, uint256 actual);
    error TransferMismatch(uint256 expected, uint256 actual);
    error ResidualBalance();

    event Bought(
        PoolId indexed poolId,
        address indexed buyer,
        address indexed recipient,
        uint256 pipedogSpent,
        uint256 tokensOut
    );
    event Sold(
        PoolId indexed poolId,
        address indexed seller,
        address indexed recipient,
        uint256 tokensSpent,
        uint256 pipedogOut
    );

    IPoolManager public immutable poolManager;
    IERC20 public immutable pipedog;
    PipedogHook public immutable hook;

    constructor(
        IPoolManager poolManager_,
        IERC20 pipedog_,
        PipedogHook hook_
    ) {
        if (
            address(poolManager_).code.length == 0
                || address(pipedog_).code.length == 0
                || address(hook_).code.length == 0
        ) revert ZeroAddress();
        if (
            address(hook_.poolManager()) != address(poolManager_)
                || address(hook_.quoteToken()) != address(pipedog_)
        ) revert InvalidPool();
        poolManager = poolManager_;
        pipedog = pipedog_;
        hook = hook_;
    }

    function buy(
        PoolKey calldata key,
        uint256 pipedogIn,
        uint256 minTokensOut,
        address recipient
    ) external nonReentrant returns (uint256 tokensOut) {
        if (pipedogIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        _validatePool(key);

        IERC20 launchedToken = IERC20(Currency.unwrap(key.currency1));
        uint256 quoteFloor = _pullExact(pipedog, msg.sender, pipedogIn);
        uint256 outputFloor = launchedToken.balanceOf(address(this));

        (uint256 spent, uint256 out) = abi.decode(
            poolManager.unlock(
                abi.encode(
                    UnlockData({
                        action: Action.BUY,
                        key: key,
                        amountIn: pipedogIn
                    })
                )
            ),
            (uint256, uint256)
        );
        if (out < minTokensOut) {
            revert SlippageExceeded(minTokensOut, out);
        }

        _pushExact(launchedToken, recipient, out);
        if (spent < pipedogIn) {
            _pushExact(pipedog, msg.sender, pipedogIn - spent);
        }
        if (
            pipedog.balanceOf(address(this)) != quoteFloor
                || launchedToken.balanceOf(address(this)) != outputFloor
        ) revert ResidualBalance();

        emit Bought(key.toId(), msg.sender, recipient, spent, out);
        return out;
    }

    function sell(
        PoolKey calldata key,
        uint256 tokensIn,
        uint256 minPipedogOut,
        address recipient
    ) external nonReentrant returns (uint256 pipedogOut) {
        if (tokensIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        _validatePool(key);

        IERC20 launchedToken = IERC20(Currency.unwrap(key.currency1));
        uint256 tokenFloor = _pullExact(
            launchedToken, msg.sender, tokensIn
        );
        uint256 outputFloor = pipedog.balanceOf(address(this));

        (uint256 spent, uint256 out) = abi.decode(
            poolManager.unlock(
                abi.encode(
                    UnlockData({
                        action: Action.SELL,
                        key: key,
                        amountIn: tokensIn
                    })
                )
            ),
            (uint256, uint256)
        );
        if (out < minPipedogOut) {
            revert SlippageExceeded(minPipedogOut, out);
        }

        _pushExact(pipedog, recipient, out);
        if (spent < tokensIn) {
            _pushExact(launchedToken, msg.sender, tokensIn - spent);
        }
        if (
            launchedToken.balanceOf(address(this)) != tokenFloor
                || pipedog.balanceOf(address(this)) != outputFloor
        ) revert ResidualBalance();

        emit Sold(key.toId(), msg.sender, recipient, spent, out);
        return out;
    }

    function unlockCallback(bytes calldata data)
        external
        returns (bytes memory)
    {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        UnlockData memory operation = abi.decode(data, (UnlockData));
        if (operation.amountIn > uint256(type(int256).max)) {
            revert ValueTooLarge();
        }

        bool buyAction = operation.action == Action.BUY;
        BalanceDelta delta = poolManager.swap(
            operation.key,
            SwapParams({
                zeroForOne: buyAction,
                amountSpecified: -int256(operation.amountIn),
                sqrtPriceLimitX96: buyAction
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int128 inputDelta =
            buyAction ? delta.amount0() : delta.amount1();
        int128 outputDelta =
            buyAction ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) {
            revert InvalidSwapDelta();
        }

        uint256 amountSpent = uint256(uint128(-inputDelta));
        uint256 amountOut = uint256(uint128(outputDelta));
        if (amountSpent > operation.amountIn) {
            revert InvalidSwapDelta();
        }

        Currency inputCurrency = buyAction
            ? operation.key.currency0
            : operation.key.currency1;
        Currency outputCurrency = buyAction
            ? operation.key.currency1
            : operation.key.currency0;
        inputCurrency.settle(
            poolManager, address(this), amountSpent, false
        );
        outputCurrency.take(
            poolManager, address(this), amountOut, false
        );
        return abi.encode(amountSpent, amountOut);
    }

    function _validatePool(PoolKey calldata key) private view {
        if (
            Currency.unwrap(key.currency0) != address(pipedog)
                || Currency.unwrap(key.currency1) <= address(pipedog)
                || address(key.hooks) != address(hook) || key.fee != 0
                || !hook.isRegistered(key.toId())
        ) revert InvalidPool();
    }

    function _pullExact(IERC20 token, address from, uint256 amount)
        private
        returns (uint256 floor)
    {
        floor = token.balanceOf(address(this));
        uint256 approved = token.allowance(from, address(this));
        if (approved != amount) {
            revert AllowanceMismatch(amount, approved);
        }
        token.safeTransferFrom(from, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - floor;
        if (received != amount) revert TransferMismatch(amount, received);
    }

    function _pushExact(IERC20 token, address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 senderBefore = token.balanceOf(address(this));
        uint256 recipientBefore = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 sent = senderBefore - token.balanceOf(address(this));
        uint256 received = token.balanceOf(to) - recipientBefore;
        if (sent != amount || received != amount) {
            revert TransferMismatch(amount, received);
        }
    }
}
