// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CurveEconomics} from "../src/lib/CurveEconomics.sol";

contract CurveEconomicsHarness {
    function tokensPerPipedogWad(int24 tick)
        external
        pure
        returns (uint256)
    {
        return CurveEconomics.tokensPerPipedogWad(tick);
    }

    function impliedInitialFdvPipedog(
        uint256 supply,
        int24 tick
    ) external pure returns (uint256) {
        return CurveEconomics.impliedInitialFdvPipedog(
            supply, tick
        );
    }
}

contract CurveEconomicsTest is Test {
    CurveEconomicsHarness internal economics;

    function setUp() public {
        economics = new CurveEconomicsHarness();
    }

    /// @dev Regression only, not a recommended config: carrying the original
    /// LetsCash tick into an equal-decimal PIPEDOG pair makes a 1B-token launch
    /// worth only about 1.356 PIPEDOG at the boundary.
    function testLegacyTickIsUnsafeForOneBillionSupply() public view {
        uint256 fdv = economics.impliedInitialFdvPipedog(
            1_000_000_000 ether, 204_200
        );
        assertApproxEqAbs(
            fdv,
            1_355_657_760_820_152_300,
            1e9,
            "legacy tick FDV regression changed"
        );
        assertLt(fdv, 2 ether);
    }

    function testHigherTickMeansMoreTokensPerPipedogAndLowerFdv()
        public
        view
    {
        uint256 lowPrice =
            economics.tokensPerPipedogWad(90_000);
        uint256 highPrice =
            economics.tokensPerPipedogWad(100_000);
        assertGt(highPrice, lowPrice);

        uint256 lowTickFdv = economics.impliedInitialFdvPipedog(
            1_000_000_000 ether, 90_000
        );
        uint256 highTickFdv = economics.impliedInitialFdvPipedog(
            1_000_000_000 ether, 100_000
        );
        assertLt(highTickFdv, lowTickFdv);
    }
}
