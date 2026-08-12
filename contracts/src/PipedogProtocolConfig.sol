// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Canonical Robinhood Chain constants for the laypipe.fun deployment.
/// @dev This is a configuration surface, not the audited protocol deployment.
library PipedogProtocolConfig {
    uint256 internal constant CHAIN_ID = 4663;

    address internal constant PIPEDOG =
        0x5Cb6F181081301b44905F3ae15419112ecaBd8A6;
    bytes32 internal constant PIPEDOG_CODEHASH =
        0xc0d0d825734a0b6d070991217c8c0fb8530b574e839d2ff7685341fd9d707912;
    uint256 internal constant PIPEDOG_TOTAL_SUPPLY =
        12_345_678_912 ether;
    uint8 internal constant PIPEDOG_DECIMALS = 18;

    address internal constant POOL_MANAGER =
        0x8366a39CC670B4001A1121B8F6A443A643e40951;
    bytes32 internal constant POOL_MANAGER_CODEHASH =
        0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626;

    /// @dev Foundry's deterministic deployment proxy. Hook address mining
    ///      depends on this exact runtime being present before deployment.
    address internal constant CREATE2_DEPLOYER =
        0x4e59b44847b379578588920cA78FbF26c0B4956C;
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    address internal constant UNIVERSAL_ROUTER =
        0x8876789976dEcBfCbBbe364623C63652db8C0904;

    address internal constant V4_QUOTER =
        0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;

    address internal constant STATE_VIEW =
        0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    address internal constant PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Canonical wrapped native asset reported by the live PIPEDOG pool.
    address internal constant WETH =
        0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    /// @dev Canonical PIPEDOG/WETH Uniswap v3 pool checked directly over RPC.
    address internal constant PIPEDOG_WETH_V3_POOL =
        0xB7f10f74B39291b9290b779978e19A7637C742D6;

    address internal constant UNISWAP_V3_FACTORY =
        0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    uint24 internal constant PIPEDOG_WETH_V3_FEE = 10_000;
}
