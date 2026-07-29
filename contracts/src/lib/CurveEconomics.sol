// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice Equal-decimal PIPEDOG/launch-token curve calibration helpers.
library CurveEconomics {
    uint256 internal constant Q96 = 1 << 96;
    uint256 internal constant WAD = 1e18;

    /// @notice Launched-token base units per one PIPEDOG token, scaled 1e18.
    function tokensPerPipedogWad(int24 tick)
        internal
        pure
        returns (uint256)
    {
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        uint256 priceX96 = FullMath.mulDiv(
            uint256(sqrtPriceX96), uint256(sqrtPriceX96), Q96
        );
        return FullMath.mulDiv(priceX96, WAD, Q96);
    }

    /// @notice Implied fully diluted value in PIPEDOG base units.
    /// @dev Both assets use 18 decimals. This is a launch-boundary quote, not
    ///      a promise of executable size or a production economic endorsement.
    function impliedInitialFdvPipedog(
        uint256 launchedSupply,
        int24 tick
    ) internal pure returns (uint256) {
        uint256 priceWad = tokensPerPipedogWad(tick);
        return FullMath.mulDiv(launchedSupply, WAD, priceWad);
    }
}
