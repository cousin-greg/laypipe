// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CurveEconomics} from "../src/lib/CurveEconomics.sol";
import {LiquidityAmounts} from "../src/lib/LiquidityAmounts.sol";

/// @dev Cross-language regression anchors for scripts/curve-model.mjs. These
///      values are test economics only and are not a production endorsement.
contract CurveSimulationMathTest is Test {
    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    int24 internal constant TICK_SPACING = 200;
    int24 internal constant START_TICK = 69_000;

    function testJavascriptModelMatchesCurrentUniswapIntegerMath()
        public
        pure
    {
        int24 lowerTick = TickMath.minUsableTick(TICK_SPACING);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(lowerTick);
        uint160 sqrtStart = TickMath.getSqrtPriceAtTick(START_TICK);
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount1(
            sqrtLower, sqrtStart, SUPPLY
        );

        assertEq(lowerTick, -887_200);
        assertEq(sqrtLower, 4_310_618_292);
        assertEq(
            sqrtStart,
            2_495_287_755_534_003_115_715_307_026_263
        );
        assertEq(
            liquidity,
            31_751_112_607_575_451_567_030_977
        );
        assertEq(
            CurveEconomics.tokensPerPipedogWad(START_TICK),
            991_932_462_686_836_107_889
        );
        assertEq(
            CurveEconomics.impliedInitialFdvPipedog(
                SUPPLY, START_TICK
            ),
            1_008_133_151_818_936_791_455_476
        );
        assertEq(
            SqrtPriceMath.getAmount1Delta(
                sqrtLower, sqrtStart, liquidity, true
            ),
            SUPPLY - 12
        );
        assertEq(
            SqrtPriceMath.getAmount0Delta(
                sqrtLower, sqrtStart, liquidity, true
            ),
            583_578_071_468_383_031_898_559_486_237_983_839_937_876_484
        );

        // Gross 10 PIPEDOG with the current 1% hook fee leaves 9.9 PIPEDOG
        // for the zero-LP-fee curve.
        uint256 poolQuoteIn = 9.9 ether;
        uint160 sqrtAfterBuy = SqrtPriceMath.getNextSqrtPriceFromInput(
            sqrtStart, liquidity, poolQuoteIn, true
        );
        uint256 tokensOut = SqrtPriceMath.getAmount1Delta(
            sqrtAfterBuy, sqrtStart, liquidity, false
        );
        assertEq(
            sqrtAfterBuy,
            2_495_263_251_721_042_032_718_286_228_218
        );
        assertEq(tokensOut, 9_820_034_946_566_340_106_510);

        uint160 sqrtAfterSell = SqrtPriceMath.getNextSqrtPriceFromInput(
            sqrtAfterBuy, liquidity, tokensOut, false
        );
        uint256 grossQuoteOut = SqrtPriceMath.getAmount0Delta(
            sqrtAfterBuy, sqrtAfterSell, liquidity, false
        );
        assertEq(
            sqrtAfterSell,
            2_495_287_755_534_003_115_715_307_025_310
        );
        assertEq(grossQuoteOut, poolQuoteIn - 1);
        assertEq(
            grossQuoteOut - grossQuoteOut * 10_000 / 1_000_000,
            9_801_000_000_000_000_000
        );
    }
}
