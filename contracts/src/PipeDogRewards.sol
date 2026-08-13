// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {ILayPipeRewardVault} from "./interfaces/ILayPipeRewardVault.sol";

/// @title PipeDogRewards
/// @notice O(1) pull accounting for PIPEDOG fees, weighted by whole PipeDog units.
/// @dev The linked LayPipe token checkpoints accounts before their unit count changes.
contract PipeDogRewards is ILayPipeRewardVault, IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using CurrencyLibrary for Currency;

    struct Account {
        uint64 units;
        uint256 rewardPerUnitPaid;
        uint256 accrued;
    }

    error NotToken();
    error NotConfigurator();
    error NotRewardNotifier();
    error NotPoolManager();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyConfigured();
    error UnitsTooLarge();
    error RewardClaimMismatch(uint256 expected, uint256 actual);
    error RedemptionMismatch(uint256 expected, uint256 actual);

    event RewardNotifierSet(address indexed notifier);
    event EligibilitySynced(address indexed account, uint256 oldUnits, uint256 newUnits);
    event RewardNotified(uint256 amount, uint256 indexed eligibleUnits, uint256 rewardPerUnitStored);
    event RewardClaimed(address indexed account, uint256 amount);

    uint256 public constant ACC_PRECISION = 1e24;

    IERC20 public immutable pipedog;
    IPoolManager public immutable poolManager;
    uint256 public immutable pipedogClaimId;
    address public immutable token;
    address public immutable configurator;

    address public rewardNotifier;
    uint256 public override totalEligibleUnits;
    uint256 public rewardPerUnitStored;
    uint256 public undistributedRewards;
    uint256 public totalRewardsNotified;
    uint256 public totalRewardsClaimed;

    mapping(address => Account) private _accounts;

    constructor(IERC20 pipedog_, IPoolManager poolManager_, address configurator_) {
        if (address(pipedog_).code.length == 0 || address(poolManager_).code.length == 0 || configurator_ == address(0))
        {
            revert ZeroAddress();
        }
        pipedog = pipedog_;
        poolManager = poolManager_;
        pipedogClaimId = Currency.wrap(address(pipedog_)).toId();
        token = msg.sender;
        configurator = configurator_;
    }

    /// @notice One-time deployment wiring. The notifier is the singleton v4 hook.
    function setRewardNotifier(address notifier) external {
        if (msg.sender != configurator) revert NotConfigurator();
        if (rewardNotifier != address(0)) revert AlreadyConfigured();
        if (notifier.code.length == 0) revert ZeroAddress();
        rewardNotifier = notifier;
        emit RewardNotifierSet(notifier);
    }

    /// @notice Settles an account under its old weight, then installs its new weight.
    /// @dev Callable only by the linked hybrid token during ERC20 or ERC721 moves.
    function sync(address account, uint256 newUnits) external {
        if (msg.sender != token) revert NotToken();
        if (newUnits > type(uint64).max) revert UnitsTooLarge();

        Account storage a = _accounts[account];
        uint256 oldUnits = a.units;
        uint256 accumulator = rewardPerUnitStored;
        uint256 earned = Math.mulDiv(oldUnits, accumulator - a.rewardPerUnitPaid, ACC_PRECISION);
        if (earned != 0) a.accrued += earned;

        a.units = uint64(newUnits);
        a.rewardPerUnitPaid = accumulator;
        totalEligibleUnits = totalEligibleUnits - oldUnits + newUnits;
        if (totalEligibleUnits != 0 && undistributedRewards != 0) {
            uint256 distributable = undistributedRewards;
            undistributedRewards = 0;
            rewardPerUnitStored += Math.mulDiv(distributable, ACC_PRECISION, totalEligibleUnits);
            emit RewardNotified(distributable, totalEligibleUnits, rewardPerUnitStored);
        }
        emit EligibilitySynced(account, oldUnits, newUnits);
    }

    /// @inheritdoc ILayPipeRewardVault
    function notifyRewardClaim(uint256 amount) external override nonReentrant {
        if (msg.sender != rewardNotifier) revert NotRewardNotifier();
        if (amount == 0) revert ZeroAmount();

        // Only freshly minted PoolManager PIPEDOG claims can be notified.
        // Existing liabilities cannot be counted twice.
        uint256 accounted = totalRewardsNotified - totalRewardsClaimed;
        uint256 actual = poolManager.balanceOf(address(this), pipedogClaimId);
        uint256 expected = accounted + amount;
        if (actual < expected) revert RewardClaimMismatch(expected, actual);

        totalRewardsNotified += amount;
        uint256 units = totalEligibleUnits;
        if (units == 0) {
            undistributedRewards += amount;
            emit RewardNotified(amount, 0, rewardPerUnitStored);
            return;
        }

        uint256 distributable = amount + undistributedRewards;
        undistributedRewards = 0;
        rewardPerUnitStored += Math.mulDiv(distributable, ACC_PRECISION, units);
        emit RewardNotified(distributable, units, rewardPerUnitStored);
    }

    /// @inheritdoc ILayPipeRewardVault
    function eligibleUnitsOf(address account) external view override returns (uint256) {
        return _accounts[account].units;
    }

    /// @inheritdoc ILayPipeRewardVault
    function claimable(address account) public view override returns (uint256) {
        Account storage a = _accounts[account];
        return a.accrued + Math.mulDiv(uint256(a.units), rewardPerUnitStored - a.rewardPerUnitPaid, ACC_PRECISION);
    }

    /// @inheritdoc ILayPipeRewardVault
    function claim() external override nonReentrant returns (uint256 amount) {
        Account storage a = _accounts[msg.sender];
        uint256 accumulator = rewardPerUnitStored;
        amount = a.accrued + Math.mulDiv(uint256(a.units), accumulator - a.rewardPerUnitPaid, ACC_PRECISION);
        if (amount == 0) return 0;

        a.accrued = 0;
        a.rewardPerUnitPaid = accumulator;
        totalRewardsClaimed += amount;
        uint256 beforeBalance = pipedog.balanceOf(address(this));
        poolManager.unlock(abi.encode(amount));
        uint256 received = pipedog.balanceOf(address(this)) - beforeBalance;
        if (received != amount) revert RedemptionMismatch(amount, received);
        pipedog.safeTransfer(msg.sender, amount);
        emit RewardClaimed(msg.sender, amount);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        uint256 amount = abi.decode(data, (uint256));
        Currency quote = Currency.wrap(address(pipedog));
        poolManager.burn(address(this), pipedogClaimId, amount);
        poolManager.take(quote, address(this), amount);
        return "";
    }

    /// @notice Detailed account state for indexers and the single-coin UI.
    function accountState(address account)
        external
        view
        returns (uint256 units, uint256 rewardPerUnitPaid, uint256 accrued)
    {
        Account storage a = _accounts[account];
        return (a.units, a.rewardPerUnitPaid, a.accrued);
    }
}
