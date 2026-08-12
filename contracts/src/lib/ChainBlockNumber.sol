// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @dev Robinhood Chain is an Arbitrum Orbit chain. Solidity's `block.number`
///      there is a periodically updated estimate of the Ethereum L1 block and
///      must not be used for L2 per-block guards or checkpoints.
interface IArbSysBlockNumber {
    function arbBlockNumber() external view returns (uint256);
}

/// @notice Returns the chain-local block number used by LayPipe accounting.
/// @dev Production is pinned to Robinhood Chain, where the ArbSys precompile is
///      authoritative. The `block.number` branch exists only so the same
///      contracts can be rehearsed on non-Arbitrum test networks such as Base
///      Sepolia; Robinhood deployment is separately chain-gated by preflight.
library ChainBlockNumber {
    uint256 internal constant ROBINHOOD_CHAIN_ID = 4663;
    address internal constant ARBSYS =
        0x0000000000000000000000000000000000000064;

    error ArbSysUnavailable();

    function current() internal view returns (uint256 number) {
        if (block.chainid != ROBINHOOD_CHAIN_ID) return block.number;

        (bool ok, bytes memory result) = ARBSYS.staticcall(
            abi.encodeCall(IArbSysBlockNumber.arbBlockNumber, ())
        );
        if (!ok || result.length != 32) revert ArbSysUnavailable();
        number = abi.decode(result, (uint256));
    }
}
