// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test-only Base Sepolia wiring from Uniswap's official deployment
///         registry. None of these addresses are Robinhood production config.
library BaseSepoliaConfig {
    uint256 internal constant CHAIN_ID = 84_532;

    address internal constant POOL_MANAGER = 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
    /// @dev Runtime hash observed at the official Base Sepolia deployment.
    ///      The preflight pins both the address and deployed bytecode so an
    ///      interface-compatible replacement cannot silently enter a test.
    bytes32 internal constant POOL_MANAGER_CODEHASH =
        0x03c45db6d09b14da7c1f7239a5a49697f976d395277e6d2acb6fbed3f9e0249f;
    address internal constant POSITION_MANAGER = 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80;
    address internal constant UNIVERSAL_ROUTER = 0x492E6456D9528771018DeB9E87ef7750EF184104;
    address internal constant STATE_VIEW = 0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4;
    address internal constant V4_QUOTER = 0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Foundry's deterministic deployment proxy. The preflight pins its
    ///      live Base Sepolia runtime hash before any rehearsal transaction.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;
}
