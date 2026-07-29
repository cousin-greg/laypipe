// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Canonical Robinhood Chain constants for the laypipe.fun deployment.
/// @dev This is a configuration surface, not the audited protocol deployment.
library PipedogProtocolConfig {
    uint256 internal constant CHAIN_ID = 4663;

    address internal constant PIPEDOG =
        0x5Cb6F181081301b44905F3ae15419112ecaBd8A6;

    address internal constant POOL_MANAGER =
        0x8366a39CC670B4001A1121B8F6A443A643e40951;

    address internal constant UNIVERSAL_ROUTER =
        0x8876789976dEcBfCbBbe364623C63652db8C0904;

    address internal constant V4_QUOTER =
        0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;

    address internal constant STATE_VIEW =
        0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;

    address internal constant PERMIT2 =
        0x000000000022D473030F116dDEE9F6B43aC78BA3;
}
