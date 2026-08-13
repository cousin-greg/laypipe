// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ILayPipeRewardVault
/// @notice Hook and interface surface for the singleton PipeDog reward vault.
interface ILayPipeRewardVault {
    /// @notice Accounts for `amount` PIPEDOG PoolManager claims already minted to the vault.
    function notifyRewardClaim(uint256 amount) external;

    /// @notice Whole PipeDog units currently eligible for `account`.
    function eligibleUnitsOf(address account) external view returns (uint256);

    /// @notice Total whole PipeDog units participating in rewards.
    function totalEligibleUnits() external view returns (uint256);

    /// @notice PIPEDOG currently withdrawable by `account`.
    function claimable(address account) external view returns (uint256);

    /// @notice Withdraws the caller's accrued PIPEDOG.
    function claim() external returns (uint256 amount);
}
