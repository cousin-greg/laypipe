// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {IUniswapV3Factory} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import {IUniswapV3SwapCallback} from
    "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3SwapCallback.sol";

interface IPipedogWETH9 is IERC20 {
    function deposit() external payable;
}

/// @title PipedogRevenueRouter
/// @notice Fixed platform-revenue policy for laypipe.fun.
///
/// During normal operation every newly received wei is assigned:
/// - 25% buys PIPEDOG and sends it to the conventional dead-address sink;
/// - 25% buys PIPEDOG and sends it to the protocol treasury;
/// - 50% is paid to the operations wallet.
/// The owner retains an explicit all-ETH migration path for replacing this
/// router if canonical liquidity moves, so this is a fixed operating policy,
/// not an irrevocable custody guarantee.
///
/// Anyone may execute either buy lane and earns a 1% bounty from the amount
/// processed. Per-call caps and a one-execution-per-lane-per-block gate bound
/// the value exposed to a public, predictable market order.
///
/// PIPEDOG does not expose burn(), so the first lane is technically
/// sequestration, not a total-supply burn. The contract and events use the
/// precise term: purchased tokens become inaccessible at the sink while
/// ERC-20 totalSupply remains unchanged.
contract PipedogRevenueRouter is
    Ownable2Step,
    Pausable,
    ReentrancyGuard,
    IUniswapV3SwapCallback
{
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroCap();
    error InvalidPool();
    error TokenMismatch();
    error FeeTierMismatch();
    error NothingToProcess();
    error AlreadyProcessedThisBlock();
    error NotPool();
    error NotActiveSwap();
    error InvalidSwapDelta();
    error SwapInputTooHigh();
    error EmptySwap();
    error NativeTransferFailed();
    error MigrationFailed();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SEQUESTER_SHARE_BPS = 2_500;
    uint256 public constant TREASURY_BUY_SHARE_BPS = 2_500;
    uint256 public constant OPERATIONS_SHARE_BPS = 5_000;
    uint256 public constant BOUNTY_BPS = 100;

    address public constant SEQUESTER_SINK =
        0x000000000000000000000000000000000000dEaD;

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4_295_128_740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;

    IUniswapV3Pool public immutable pool;
    IUniswapV3Factory public immutable v3Factory;
    IPipedogWETH9 public immutable weth;
    IERC20 public immutable pipedog;
    bool private immutable _wethIsToken0;

    address public treasury;
    address public operationsWallet;
    uint256 public maxSequesterPerCall;
    uint256 public maxTreasuryBuyPerCall;

    uint256 public sequesterTank;
    uint256 public treasuryBuyTank;
    uint256 public operationsTab;

    uint256 public totalEthSequestered;
    uint256 public totalPipedogSequestered;
    uint256 public totalEthTreasuryBought;
    uint256 public totalPipedogTreasuryBought;
    uint256 public totalOperationsCollected;
    uint256 public totalKeeperBounties;
    uint256 public totalRevenueAllocated;
    uint256 public totalMigrated;

    uint256 private _lastSequesterBlock;
    uint256 private _lastTreasuryBuyBlock;
    uint256 private transient _activeWethAllowance;
    bool private transient _swapActive;

    event RevenueAllocated(
        uint256 sequesterAmount,
        uint256 treasuryBuyAmount,
        uint256 operationsAmount
    );
    event PipedogSequestered(
        address indexed caller,
        uint256 ethSpent,
        uint256 pipedogSequestered,
        uint256 bounty,
        address indexed sink
    );
    event TreasuryPipedogBought(
        address indexed caller,
        address indexed treasury,
        uint256 ethSpent,
        uint256 pipedogBought,
        uint256 bounty
    );
    event OperationsCollected(address indexed operationsWallet, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OperationsWalletUpdated(
        address indexed oldWallet, address indexed newWallet
    );
    event MaxSequesterPerCallUpdated(uint256 oldCap, uint256 newCap);
    event MaxTreasuryBuyPerCallUpdated(uint256 oldCap, uint256 newCap);
    event Migrated(address indexed successor, uint256 amount);

    constructor(
        IUniswapV3Pool pool_,
        IUniswapV3Factory v3Factory_,
        uint24 expectedPoolFee_,
        IERC20 pipedog_,
        IPipedogWETH9 weth_,
        address treasury_,
        address operationsWallet_,
        uint256 maxSequesterPerCall_,
        uint256 maxTreasuryBuyPerCall_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(pool_) == address(0) || address(v3Factory_) == address(0)
                || address(pipedog_) == address(0) || address(weth_) == address(0)
                || treasury_ == address(0) || operationsWallet_ == address(0)
                || owner_ == address(0)
        ) revert ZeroAddress();
        if (maxSequesterPerCall_ == 0 || maxTreasuryBuyPerCall_ == 0) {
            revert ZeroCap();
        }
        if (
            address(pool_).code.length == 0
                || address(v3Factory_).code.length == 0
                || address(pipedog_).code.length == 0
                || address(weth_).code.length == 0
        ) revert InvalidPool();

        address token0 = pool_.token0();
        address token1 = pool_.token1();
        bool wethIsToken0 =
            token0 == address(weth_) && token1 == address(pipedog_);
        bool wethIsToken1 =
            token1 == address(weth_) && token0 == address(pipedog_);
        if (!wethIsToken0 && !wethIsToken1) revert TokenMismatch();
        if (pool_.fee() != expectedPoolFee_) revert FeeTierMismatch();
        if (
            pool_.factory() != address(v3Factory_)
                || v3Factory_.getPool(token0, token1, expectedPoolFee_)
                    != address(pool_)
        ) revert InvalidPool();

        pool = pool_;
        v3Factory = v3Factory_;
        weth = weth_;
        pipedog = pipedog_;
        _wethIsToken0 = wethIsToken0;
        treasury = treasury_;
        operationsWallet = operationsWallet_;
        maxSequesterPerCall = maxSequesterPerCall_;
        maxTreasuryBuyPerCall = maxTreasuryBuyPerCall_;
    }

    /// @dev Hook sweeps and launch fees can push ETH without invoking protocol
    /// logic. Allocation happens lazily on the next public action. Force-sent
    /// ETH is handled identically.
    receive() external payable {}

    /// @notice ETH received but not yet assigned to one of the fixed lanes.
    function unallocated() public view returns (uint256) {
        return address(this).balance - sequesterTank - treasuryBuyTank
            - operationsTab;
    }

    /// @notice Assigns fresh ETH to the immutable 25/25/50 policy.
    function allocate() public {
        _allocate();
    }

    function _allocate() private {
        uint256 fresh = unallocated();
        if (fresh == 0) return;

        uint256 toSequester =
            (fresh * SEQUESTER_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 toTreasuryBuy =
            (fresh * TREASURY_BUY_SHARE_BPS) / BPS_DENOMINATOR;
        // Put both integer-division remainders into operations so every wei is
        // assigned and the accounting identity remains exact.
        uint256 toOperations = fresh - toSequester - toTreasuryBuy;

        sequesterTank += toSequester;
        treasuryBuyTank += toTreasuryBuy;
        operationsTab += toOperations;
        totalRevenueAllocated += fresh;
        emit RevenueAllocated(toSequester, toTreasuryBuy, toOperations);
    }

    /// @notice Buys PIPEDOG and transfers it directly to the dead-address
    /// sink. This reduces circulating availability, not ERC-20 totalSupply.
    function buyAndSequester()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 pipedogSequestered)
    {
        if (_lastSequesterBlock == block.number) {
            revert AlreadyProcessedThisBlock();
        }
        _lastSequesterBlock = block.number;
        _allocate();

        uint256 fuel = sequesterTank;
        if (fuel == 0) revert NothingToProcess();
        uint256 chunk =
            fuel > maxSequesterPerCall ? maxSequesterPerCall : fuel;
        sequesterTank = fuel - chunk;

        (uint256 ethSpent, uint256 bounty, uint256 pipedogOut) =
            _buyPipedog(SEQUESTER_SINK, chunk);
        sequesterTank += chunk - ethSpent - bounty;

        totalEthSequestered += ethSpent;
        totalPipedogSequestered += pipedogOut;
        totalKeeperBounties += bounty;
        _payNative(msg.sender, bounty);

        emit PipedogSequestered(
            msg.sender,
            ethSpent,
            pipedogOut,
            bounty,
            SEQUESTER_SINK
        );
        return pipedogOut;
    }

    /// @notice Buys PIPEDOG and transfers it directly to the current treasury.
    function buyForTreasury()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 pipedogBought)
    {
        if (_lastTreasuryBuyBlock == block.number) {
            revert AlreadyProcessedThisBlock();
        }
        _lastTreasuryBuyBlock = block.number;
        _allocate();

        uint256 fuel = treasuryBuyTank;
        if (fuel == 0) revert NothingToProcess();
        uint256 chunk =
            fuel > maxTreasuryBuyPerCall ? maxTreasuryBuyPerCall : fuel;
        treasuryBuyTank = fuel - chunk;

        address recipient = treasury;
        (uint256 ethSpent, uint256 bounty, uint256 pipedogOut) =
            _buyPipedog(recipient, chunk);
        treasuryBuyTank += chunk - ethSpent - bounty;

        totalEthTreasuryBought += ethSpent;
        totalPipedogTreasuryBought += pipedogOut;
        totalKeeperBounties += bounty;
        _payNative(msg.sender, bounty);

        emit TreasuryPipedogBought(
            msg.sender, recipient, ethSpent, pipedogOut, bounty
        );
        return pipedogOut;
    }

    function _buyPipedog(address recipient, uint256 chunk)
        private
        returns (uint256 ethSpent, uint256 bounty, uint256 pipedogOut)
    {
        // Reserve enough for a 1% bounty of the fully processed gross chunk.
        // If the pool partially fills, the bounty scales down with actual
        // spend, preventing a boundary fill from farming a full bounty.
        uint256 maxSwapInput =
            chunk - (chunk * BOUNTY_BPS) / BPS_DENOMINATOR;
        if (maxSwapInput == 0) revert NothingToProcess();
        if (maxSwapInput > uint256(type(int256).max)) {
            revert SwapInputTooHigh();
        }

        bool zeroForOne = _wethIsToken0;
        _activeWethAllowance = maxSwapInput;
        _swapActive = true;
        (int256 amount0, int256 amount1) = pool.swap(
            recipient,
            zeroForOne,
            int256(maxSwapInput),
            zeroForOne
                ? MIN_SQRT_RATIO_PLUS_ONE
                : MAX_SQRT_RATIO_MINUS_ONE,
            ""
        );
        _swapActive = false;

        uint256 remainingAllowance = _activeWethAllowance;
        _activeWethAllowance = 0;
        ethSpent = maxSwapInput - remainingAllowance;

        int256 returnedInput = zeroForOne ? amount0 : amount1;
        int256 returnedOutput = zeroForOne ? amount1 : amount0;
        if (
            returnedInput <= 0 || returnedOutput >= 0
                || uint256(returnedInput) != ethSpent
        ) revert InvalidSwapDelta();
        pipedogOut = uint256(-returnedOutput);
        if (ethSpent == 0 || pipedogOut == 0) revert EmptySwap();

        // ethSpent represents 99% of a gross fully-filled chunk. This formula
        // makes the keeper bounty exactly 1% of gross when fully filled while
        // remaining proportional for a partial fill.
        uint256 proportionalBounty = (ethSpent * BOUNTY_BPS)
            / (BPS_DENOMINATOR - BOUNTY_BPS);
        uint256 remainingGross = chunk - ethSpent;
        bounty = proportionalBounty > remainingGross
            ? remainingGross
            : proportionalBounty;
    }

    /// @dev Only the canonical pool can collect WETH, only during a router-
    /// initiated swap, and never beyond the exact active input allowance.
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external override {
        if (msg.sender != address(pool)) revert NotPool();
        if (!_swapActive) revert NotActiveSwap();
        if (
            (_wethIsToken0 && (amount0Delta <= 0 || amount1Delta >= 0))
                || (!_wethIsToken0 && (amount1Delta <= 0 || amount0Delta >= 0))
        ) revert InvalidSwapDelta();

        uint256 owed =
            uint256(_wethIsToken0 ? amount0Delta : amount1Delta);
        uint256 allowance = _activeWethAllowance;
        if (owed > allowance) revert SwapInputTooHigh();
        _activeWethAllowance = allowance - owed;

        weth.deposit{value: owed}();
        IERC20(address(weth)).safeTransfer(address(pool), owed);
    }

    /// @notice Pays the complete operations lane to its fixed destination.
    /// Callable by anyone; there is no caller-controlled recipient.
    function collectOperations()
        external
        nonReentrant
        returns (uint256 amount)
    {
        _allocate();
        amount = operationsTab;
        if (amount == 0) return 0;
        operationsTab = 0;
        totalOperationsCollected += amount;
        _payNative(operationsWallet, amount);
        emit OperationsCollected(operationsWallet, amount);
    }

    function _payNative(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setOperationsWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0)) revert ZeroAddress();
        emit OperationsWalletUpdated(operationsWallet, newWallet);
        operationsWallet = newWallet;
    }

    function setMaxSequesterPerCall(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroCap();
        emit MaxSequesterPerCallUpdated(maxSequesterPerCall, newCap);
        maxSequesterPerCall = newCap;
    }

    function setMaxTreasuryBuyPerCall(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroCap();
        emit MaxTreasuryBuyPerCallUpdated(maxTreasuryBuyPerCall, newCap);
        maxTreasuryBuyPerCall = newCap;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Moves all ETH to a replacement router if PIPEDOG liquidity
    /// migrates. This is the only way to change the immutable pool wiring.
    function migrate(address successor) external onlyOwner nonReentrant {
        if (successor == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        sequesterTank = 0;
        treasuryBuyTank = 0;
        operationsTab = 0;
        totalMigrated += amount;
        (bool ok,) = successor.call{value: amount}("");
        if (!ok) revert MigrationFailed();
        emit Migrated(successor, amount);
    }
}
