// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ChainBlockNumber} from "./lib/ChainBlockNumber.sol";

/// @title PipedogRevenueRouter
/// @notice Direct PIPEDOG platform-revenue policy for laypipe.fun.
/// @dev Trading fees and launch fees already arrive as PIPEDOG, so swapping
///      through PIPEDOG/WETH and calling the result a buyback would be circular
///      and misleading. During normal operation each newly received token is
///      assigned 25% to dead-address sequestration, 25% to the treasury, and
///      50% to operations. The owner retains a token-only migration escape.
contract PipedogRevenueRouter is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroCap();
    error InvalidBounty();
    error NothingToProcess();
    error AlreadyProcessedThisBlock();
    error QuoteTransferMismatch(uint256 expected, uint256 actual);
    error ProtectedToken();
    error NativeRecoveryFailed();

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant SEQUESTER_SHARE_BPS = 2_500;
    uint256 public constant TREASURY_SHARE_BPS = 2_500;
    uint256 public constant OPERATIONS_SHARE_BPS = 5_000;
    uint256 public constant MAX_BOUNTY_BPS = 1_000;
    address public constant SEQUESTER_SINK = 0x000000000000000000000000000000000000dEaD;

    IERC20 public immutable pipedog;
    uint16 public immutable bountyBps;

    address public treasury;
    address public operationsWallet;
    uint256 public maxSequesterPerCall;
    uint256 public maxTreasuryRoutePerCall;

    uint256 public sequesterTank;
    uint256 public treasuryTank;
    uint256 public operationsTab;

    uint256 public totalRevenueAllocated;
    uint256 public totalPipedogSequestered;
    uint256 public totalPipedogTreasuryRouted;
    uint256 public totalPipedogOperationsCollected;
    uint256 public totalKeeperBounties;
    uint256 public totalMigrated;

    /// @dev Robinhood's actual L2 blocks from ArbSys, not Solidity's
    ///      periodically updated Ethereum L1 estimate.
    uint256 private _lastSequesterBlock;
    uint256 private _lastTreasuryRouteBlock;

    event RevenueAllocated(uint256 sequesterAmount, uint256 treasuryAmount, uint256 operationsAmount);
    event PipedogSequestered(address indexed caller, uint256 pipedogSequestered, uint256 bounty, address indexed sink);
    event TreasuryPipedogRouted(
        address indexed caller, address indexed treasury, uint256 pipedogRouted, uint256 bounty
    );
    event OperationsPipedogCollected(address indexed operationsWallet, uint256 amount);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event OperationsWalletUpdated(address indexed oldWallet, address indexed newWallet);
    event MaxSequesterPerCallUpdated(uint256 oldCap, uint256 newCap);
    event MaxTreasuryRoutePerCallUpdated(uint256 oldCap, uint256 newCap);
    event Migrated(address indexed successor, uint256 amount);
    event TokenRecovered(address indexed token, address indexed recipient, uint256 amount);
    event NativeRecovered(address indexed recipient, uint256 amount);

    constructor(
        IERC20 pipedog_,
        address treasury_,
        address operationsWallet_,
        uint256 maxSequesterPerCall_,
        uint256 maxTreasuryRoutePerCall_,
        uint16 bountyBps_,
        address owner_
    ) Ownable(owner_) {
        if (
            address(pipedog_) == address(0) || treasury_ == address(0) || operationsWallet_ == address(0)
                || owner_ == address(0) || treasury_ == address(this) || operationsWallet_ == address(this)
                || address(pipedog_).code.length == 0
        ) revert ZeroAddress();
        if (maxSequesterPerCall_ == 0 || maxTreasuryRoutePerCall_ == 0) revert ZeroCap();
        if (bountyBps_ > MAX_BOUNTY_BPS) revert InvalidBounty();

        pipedog = pipedog_;
        treasury = treasury_;
        operationsWallet = operationsWallet_;
        maxSequesterPerCall = maxSequesterPerCall_;
        maxTreasuryRoutePerCall = maxTreasuryRoutePerCall_;
        bountyBps = bountyBps_;
    }

    /// @notice PIPEDOG held by the router but not yet assigned to a lane.
    function unallocated() public view returns (uint256) {
        return pipedog.balanceOf(address(this)) - sequesterTank - treasuryTank - operationsTab;
    }

    /// @notice Pulls an exact PIPEDOG donation and assigns it lazily.
    /// @dev The canonical PIPEDOG is a standard fixed-supply OZ ERC20. Balance
    ///      deltas deliberately reject fee-on-transfer or rebasing substitutes.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert NothingToProcess();
        _pullExact(msg.sender, amount);
        _allocate();
    }

    function allocate() public {
        _allocate();
    }

    function _allocate() private {
        uint256 fresh = unallocated();
        if (fresh == 0) return;

        uint256 toSequester = (fresh * SEQUESTER_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 toTreasury = (fresh * TREASURY_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 toOperations = fresh - toSequester - toTreasury;

        sequesterTank += toSequester;
        treasuryTank += toTreasury;
        operationsTab += toOperations;
        totalRevenueAllocated += fresh;
        emit RevenueAllocated(toSequester, toTreasury, toOperations);
    }

    /// @notice Routes PIPEDOG directly to the conventional dead-address sink.
    /// This reduces practical circulation but never ERC20 totalSupply.
    function sequesterPipedog() external nonReentrant whenNotPaused returns (uint256 amount) {
        uint256 currentBlock = ChainBlockNumber.current();
        if (_lastSequesterBlock == currentBlock) {
            revert AlreadyProcessedThisBlock();
        }
        _lastSequesterBlock = currentBlock;
        _allocate();

        uint256 fuel = sequesterTank;
        if (fuel == 0) revert NothingToProcess();
        uint256 chunk = fuel > maxSequesterPerCall ? maxSequesterPerCall : fuel;
        sequesterTank = fuel - chunk;

        uint256 bounty = (chunk * bountyBps) / BPS_DENOMINATOR;
        amount = chunk - bounty;
        _pushExact(SEQUESTER_SINK, amount);
        _pushExact(msg.sender, bounty);

        totalPipedogSequestered += amount;
        totalKeeperBounties += bounty;
        emit PipedogSequestered(msg.sender, amount, bounty, SEQUESTER_SINK);
    }

    /// @notice Routes the treasury lane directly in PIPEDOG.
    function routeTreasuryPipedog() external nonReentrant whenNotPaused returns (uint256 amount) {
        uint256 currentBlock = ChainBlockNumber.current();
        if (_lastTreasuryRouteBlock == currentBlock) {
            revert AlreadyProcessedThisBlock();
        }
        _lastTreasuryRouteBlock = currentBlock;
        _allocate();

        uint256 fuel = treasuryTank;
        if (fuel == 0) revert NothingToProcess();
        uint256 chunk = fuel > maxTreasuryRoutePerCall ? maxTreasuryRoutePerCall : fuel;
        treasuryTank = fuel - chunk;

        uint256 bounty = (chunk * bountyBps) / BPS_DENOMINATOR;
        amount = chunk - bounty;
        address recipient = treasury;
        _pushExact(recipient, amount);
        _pushExact(msg.sender, bounty);

        totalPipedogTreasuryRouted += amount;
        totalKeeperBounties += bounty;
        emit TreasuryPipedogRouted(msg.sender, recipient, amount, bounty);
    }

    /// @notice Sends the complete operations lane in PIPEDOG.
    function collectOperations() external nonReentrant returns (uint256 amount) {
        _allocate();
        amount = operationsTab;
        if (amount == 0) return 0;
        operationsTab = 0;
        totalPipedogOperationsCollected += amount;
        _pushExact(operationsWallet, amount);
        emit OperationsPipedogCollected(operationsWallet, amount);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0) || newTreasury == address(this)) {
            revert ZeroAddress();
        }
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setOperationsWallet(address newWallet) external onlyOwner {
        if (newWallet == address(0) || newWallet == address(this)) {
            revert ZeroAddress();
        }
        emit OperationsWalletUpdated(operationsWallet, newWallet);
        operationsWallet = newWallet;
    }

    function setMaxSequesterPerCall(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroCap();
        emit MaxSequesterPerCallUpdated(maxSequesterPerCall, newCap);
        maxSequesterPerCall = newCap;
    }

    function setMaxTreasuryRoutePerCall(uint256 newCap) external onlyOwner {
        if (newCap == 0) revert ZeroCap();
        emit MaxTreasuryRoutePerCallUpdated(maxTreasuryRoutePerCall, newCap);
        maxTreasuryRoutePerCall = newCap;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Moves every PIPEDOG balance to a replacement router.
    /// @dev This admin escape means 25/25/50 is a trusted operating policy,
    ///      not an irrevocable custody guarantee.
    function migrate(address successor) external onlyOwner nonReentrant {
        if (successor == address(0) || successor == address(this)) {
            revert ZeroAddress();
        }
        _allocate();
        uint256 amount = pipedog.balanceOf(address(this));
        sequesterTank = 0;
        treasuryTank = 0;
        operationsTab = 0;
        totalMigrated += amount;
        _pushExact(successor, amount);
        emit Migrated(successor, amount);
    }

    /// @notice Recovers an unrelated token accidentally sent to this router.
    /// PIPEDOG can leave only through policy lanes or migration.
    function recoverToken(IERC20 token, address recipient) external onlyOwner nonReentrant {
        if (address(token) == address(pipedog)) revert ProtectedToken();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(recipient, amount);
        emit TokenRecovered(address(token), recipient, amount);
    }

    /// @notice Recovers native currency that can only arrive by force-send.
    /// Native value is never accepted or used by the protocol.
    function recoverNative(address payable recipient) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        uint256 amount = address(this).balance;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert NativeRecoveryFailed();
        emit NativeRecovered(recipient, amount);
    }

    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBalance = pipedog.balanceOf(address(this));
        pipedog.safeTransferFrom(from, address(this), amount);
        uint256 received = pipedog.balanceOf(address(this)) - beforeBalance;
        if (received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
    }

    function _pushExact(address recipient, uint256 amount) private {
        if (amount == 0) return;
        uint256 senderBefore = pipedog.balanceOf(address(this));
        uint256 recipientBefore = pipedog.balanceOf(recipient);
        pipedog.safeTransfer(recipient, amount);
        uint256 sent = senderBefore - pipedog.balanceOf(address(this));
        uint256 received = pipedog.balanceOf(recipient) - recipientBefore;
        if (sent != amount || received != amount) {
            revert QuoteTransferMismatch(amount, received);
        }
    }
}
