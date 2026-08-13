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
import {ChainBlockNumber} from "./lib/ChainBlockNumber.sol";
import {PipeDogFeeHook} from "./PipeDogFeeHook.sol";
import {LayPipeSingletonLauncher} from "./LayPipeSingletonLauncher.sol";

/// @title LayPipeSingletonSwapRouter
/// @notice Exact-allowance buy/sell router bound to the one LayPipe pool.
contract LayPipeSingletonSwapRouter is IUnlockCallback, ReentrancyGuard {
    using CurrencySettler for Currency;
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    enum Action {
        Buy,
        Sell
    }

    struct UnlockData {
        Action action;
        uint256 amountIn;
    }

    error NotPoolManager();
    error InvalidInfrastructure();
    error PoolNotReady();
    error ZeroAddress();
    error ZeroAmount();
    error ValueTooLarge();
    error InvalidSwapDelta();
    error SlippageExceeded(uint256 minimum, uint256 actual);
    error AllowanceMismatch(uint256 expected, uint256 actual);
    error TransferMismatch(uint256 expected, uint256 actual);
    error ResidualBalance();
    error TradeExpired(uint256 deadlineBlock, uint256 currentBlock);

    event Bought(
        PoolId indexed poolId,
        address indexed buyer,
        address indexed recipient,
        uint256 pipedogSpent,
        uint256 laypipeOut
    );
    event Sold(
        PoolId indexed poolId,
        address indexed seller,
        address indexed recipient,
        uint256 laypipeSpent,
        uint256 pipedogOut
    );

    IPoolManager public immutable poolManager;
    IERC20 public immutable pipedog;
    IERC20 public immutable laypipeToken;
    PipeDogFeeHook public immutable hook;
    LayPipeSingletonLauncher public immutable launcher;
    PoolId public immutable poolId;
    int24 public immutable tickSpacing;

    constructor(LayPipeSingletonLauncher launcher_) {
        if (address(launcher_).code.length == 0) {
            revert InvalidInfrastructure();
        }
        IPoolManager poolManager_ = launcher_.poolManager();
        PipeDogFeeHook hook_ = launcher_.hook();
        IERC20 pipedog_ = launcher_.pipedog();
        IERC20 token_ = launcher_.laypipeToken();
        int24 tickSpacing_ = launcher_.tickSpacing();
        if (
            address(poolManager_).code.length == 0 || address(hook_).code.length == 0
                || address(hook_.poolManager()) != address(poolManager_) || hook_.launcher() != address(launcher_)
                || address(hook_.pipedog()) != address(pipedog_)
        ) revert InvalidInfrastructure();
        if (
            address(pipedog_).code.length == 0 || address(token_).code.length == 0
                || address(token_) <= address(pipedog_)
        ) revert InvalidInfrastructure();

        poolManager = poolManager_;
        hook = hook_;
        launcher = launcher_;
        pipedog = pipedog_;
        laypipeToken = token_;
        poolId = launcher_.configuredPoolId();
        tickSpacing = tickSpacing_;
        if (PoolId.unwrap(poolKey().toId()) != PoolId.unwrap(poolId)) revert InvalidInfrastructure();
    }

    function poolKey() public view returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(pipedog)),
            currency1: Currency.wrap(address(laypipeToken)),
            fee: 0,
            tickSpacing: tickSpacing,
            hooks: hook
        });
    }

    function buy(uint256 pipedogIn, uint256 minLaypipeOut, address recipient, uint256 deadlineBlock)
        external
        nonReentrant
        returns (uint256 laypipeOut)
    {
        _checkTrade(pipedogIn, recipient, deadlineBlock);
        uint256 inputFloor = _pullExact(pipedog, msg.sender, pipedogIn);
        uint256 outputFloor = laypipeToken.balanceOf(address(this));
        (uint256 spent, uint256 out) = _swap(Action.Buy, pipedogIn);
        if (out < minLaypipeOut) {
            revert SlippageExceeded(minLaypipeOut, out);
        }
        _pushExact(laypipeToken, recipient, out);
        if (spent < pipedogIn) {
            _pushExact(pipedog, msg.sender, pipedogIn - spent);
        }
        if (pipedog.balanceOf(address(this)) != inputFloor || laypipeToken.balanceOf(address(this)) != outputFloor) {
            revert ResidualBalance();
        }
        emit Bought(poolId, msg.sender, recipient, spent, out);
        return out;
    }

    function sell(uint256 laypipeIn, uint256 minPipedogOut, address recipient, uint256 deadlineBlock)
        external
        nonReentrant
        returns (uint256 pipedogOut)
    {
        _checkTrade(laypipeIn, recipient, deadlineBlock);
        uint256 inputFloor = _pullExact(laypipeToken, msg.sender, laypipeIn);
        uint256 outputFloor = pipedog.balanceOf(address(this));
        (uint256 spent, uint256 out) = _swap(Action.Sell, laypipeIn);
        if (out < minPipedogOut) {
            revert SlippageExceeded(minPipedogOut, out);
        }
        _pushExact(pipedog, recipient, out);
        if (spent < laypipeIn) {
            _pushExact(laypipeToken, msg.sender, laypipeIn - spent);
        }
        if (laypipeToken.balanceOf(address(this)) != inputFloor || pipedog.balanceOf(address(this)) != outputFloor) {
            revert ResidualBalance();
        }
        emit Sold(poolId, msg.sender, recipient, spent, out);
        return out;
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        UnlockData memory operation = abi.decode(data, (UnlockData));
        if (operation.amountIn > uint256(type(int256).max)) {
            revert ValueTooLarge();
        }

        bool buyAction = operation.action == Action.Buy;
        PoolKey memory key = poolKey();
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: buyAction,
                amountSpecified: -int256(operation.amountIn),
                sqrtPriceLimitX96: buyAction ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 inputDelta = buyAction ? delta.amount0() : delta.amount1();
        int128 outputDelta = buyAction ? delta.amount1() : delta.amount0();
        if (inputDelta >= 0 || outputDelta <= 0) {
            revert InvalidSwapDelta();
        }
        uint256 amountSpent = uint256(uint128(-inputDelta));
        uint256 amountOut = uint256(uint128(outputDelta));
        if (amountSpent > operation.amountIn) revert InvalidSwapDelta();

        Currency inputCurrency = buyAction ? key.currency0 : key.currency1;
        Currency outputCurrency = buyAction ? key.currency1 : key.currency0;
        inputCurrency.settle(poolManager, address(this), amountSpent, false);
        outputCurrency.take(poolManager, address(this), amountOut, false);
        return abi.encode(amountSpent, amountOut);
    }

    function _swap(Action action, uint256 amountIn) private returns (uint256 spent, uint256 out) {
        return abi.decode(poolManager.unlock(abi.encode(UnlockData(action, amountIn))), (uint256, uint256));
    }

    function _checkTrade(uint256 amountIn, address recipient, uint256 deadlineBlock) private view {
        if (amountIn == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 currentBlock = ChainBlockNumber.current();
        if (currentBlock > deadlineBlock) {
            revert TradeExpired(deadlineBlock, currentBlock);
        }
        PoolKey memory key = poolKey();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId) || !hook.isRegistered(poolId)) revert PoolNotReady();
    }

    function _pullExact(IERC20 token, address from, uint256 amount) private returns (uint256 floor) {
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
