import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_ID = "laypipe-v4-one-sided-pipedog-v1";
export const REVIEW_SCHEMA_VERSION = 1;
export const PIPEDOG_ADDRESS =
  "0x5cb6f181081301b44905f3ae15419112ecabd8a6";
export const ROBINHOOD_CHAIN_ID = 4663;
export const MODEL_DEPENDENCY_PINS = {
  "uniswap-v4-core": "a7cf038cd568801a79a9b4cf92cd5b52c95c8585",
  "v4-periphery-liquidity-amounts":
    "e5829f6bbd656444bce937a27f4d714b6de82d75",
};

export const Q96 = 1n << 96n;
export const Q192 = Q96 * Q96;
export const WAD = 10n ** 18n;
export const FEE_DENOMINATOR = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT192 = (1n << 192n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_INT128 = (1n << 127n) - 1n;
export const MIN_TICK = -887_272;
export const MAX_TICK = 887_272;
export const MAX_TICK_SPACING = 32_767;

const TICK_RATIOS = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_ROOT = resolve(SCRIPT_DIR, "..");

const MODEL_SOURCE_PATHS = [
  "foundry.toml",
  "remappings.txt",
  "scripts/calibrate-curve.mjs",
  "scripts/curve-model.mjs",
  "scripts/install-deps.ps1",
  "scripts/simulate-curve.mjs",
  "script/DeployLaypipe.s.sol",
  "src/LaypipeFactory.sol",
  "src/LaypipeSwapRouter.sol",
  "src/LaypipeSelfBurner.sol",
  "src/LaypipeToken.sol",
  "src/PipedogHook.sol",
  "src/lib/CurveEconomics.sol",
  "src/lib/LiquidityAmounts.sol",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function divRoundingUp(numerator, denominator) {
  assert(denominator > 0n, "division denominator must be positive");
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

function mulDiv(a, b, denominator) {
  return (a * b) / denominator;
}

function mulDivRoundingUp(a, b, denominator) {
  return divRoundingUp(a * b, denominator);
}

function parseUintString(value, path, { allowZero = true } = {}) {
  assert(
    typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value),
    `${path} must be a canonical unsigned decimal string`,
  );
  const parsed = BigInt(value);
  assert(allowZero || parsed > 0n, `${path} must be greater than zero`);
  assert(parsed <= MAX_UINT256, `${path} exceeds uint256`);
  return parsed;
}

function parseSafeInteger(value, path, { minimum, maximum } = {}) {
  assert(
    typeof value === "number" && Number.isSafeInteger(value),
    `${path} must be a JSON safe integer`,
  );
  if (minimum !== undefined) {
    assert(value >= minimum, `${path} must be at least ${minimum}`);
  }
  if (maximum !== undefined) {
    assert(value <= maximum, `${path} must be at most ${maximum}`);
  }
  return value;
}

function requireExactKeys(object, path, keys) {
  assert(
    object !== null && typeof object === "object" && !Array.isArray(object),
    `${path} must be an object`,
  );
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${path} keys must be exactly: ${expected.join(", ")}`,
  );
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function getSqrtPriceAtTick(tick) {
  assert(Number.isInteger(tick), "tick must be an integer");
  assert(tick >= MIN_TICK && tick <= MAX_TICK, "tick is out of range");
  const absoluteTick = Math.abs(tick);
  let ratio =
    absoluteTick & 1 ? TICK_RATIOS[0] : 1n << 128n;
  for (let bit = 1; bit < TICK_RATIOS.length; bit += 1) {
    if (absoluteTick & (1 << bit)) {
      ratio = (ratio * TICK_RATIOS[bit]) >> 128n;
    }
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

export function getTickAtSqrtPrice(sqrtPriceX96) {
  assert(sqrtPriceX96 >= getSqrtPriceAtTick(MIN_TICK), "sqrt price below minimum");
  assert(sqrtPriceX96 < getSqrtPriceAtTick(MAX_TICK), "sqrt price at or above maximum");
  let low = MIN_TICK;
  let high = MAX_TICK - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (getSqrtPriceAtTick(middle) <= sqrtPriceX96) low = middle;
    else high = middle - 1;
  }
  return low;
}

export function minimumUsableTick(tickSpacing) {
  return Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
}

export function maximumUsableTick(tickSpacing) {
  return Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
}

export function getAmount0Delta(
  sqrtPriceAX96,
  sqrtPriceBX96,
  liquidity,
  roundUp,
) {
  let lower = sqrtPriceAX96;
  let upper = sqrtPriceBX96;
  if (lower > upper) [lower, upper] = [upper, lower];
  assert(lower > 0n, "sqrt price must be positive");
  const numerator1 = liquidity << 96n;
  const numerator2 = upper - lower;
  if (roundUp) {
    return divRoundingUp(
      mulDivRoundingUp(numerator1, numerator2, upper),
      lower,
    );
  }
  return mulDiv(numerator1, numerator2, upper) / lower;
}

export function getAmount1Delta(
  sqrtPriceAX96,
  sqrtPriceBX96,
  liquidity,
  roundUp,
) {
  const difference =
    sqrtPriceAX96 >= sqrtPriceBX96
      ? sqrtPriceAX96 - sqrtPriceBX96
      : sqrtPriceBX96 - sqrtPriceAX96;
  const numerator = liquidity * difference;
  return roundUp ? divRoundingUp(numerator, Q96) : numerator / Q96;
}

export function liquidityForAmount1(
  sqrtPriceAX96,
  sqrtPriceBX96,
  amount1,
) {
  const difference =
    sqrtPriceAX96 >= sqrtPriceBX96
      ? sqrtPriceAX96 - sqrtPriceBX96
      : sqrtPriceBX96 - sqrtPriceAX96;
  assert(difference > 0n, "price range must be non-zero");
  return mulDiv(amount1, Q96, difference);
}

function nextSqrtFromAmount0Input(sqrtPriceX96, liquidity, amount0) {
  if (amount0 === 0n) return sqrtPriceX96;
  const numerator1 = liquidity << 96n;
  const product = amount0 * sqrtPriceX96;
  if (product <= MAX_UINT256) {
    const denominator = numerator1 + product;
    if (denominator <= MAX_UINT256 && denominator >= numerator1) {
      return mulDivRoundingUp(numerator1, sqrtPriceX96, denominator);
    }
  }
  return divRoundingUp(
    numerator1,
    numerator1 / sqrtPriceX96 + amount0,
  );
}

function nextSqrtFromAmount1Input(sqrtPriceX96, liquidity, amount1) {
  const quotient = mulDiv(amount1, Q96, liquidity);
  const next = sqrtPriceX96 + quotient;
  assert(next <= MAX_UINT160, "sell price exceeds uint160");
  return next;
}

function feeForGrossQuote(grossQuote, feeRatePips) {
  return mulDiv(grossQuote, feeRatePips, FEE_DENOMINATOR);
}

function netQuoteAfterFee(grossQuote, feeRatePips) {
  return grossQuote - feeForGrossQuote(grossQuote, feeRatePips);
}

function maximumGrossForNetCapacity(netCapacity, feeRatePips) {
  assert(
    feeRatePips >= 0n && feeRatePips < FEE_DENOMINATOR,
    "fee rate must be below 100%",
  );
  let low = netCapacity;
  let high =
    divRoundingUp(
      netCapacity * FEE_DENOMINATOR,
      FEE_DENOMINATOR - feeRatePips,
    ) + 2n;
  while (netQuoteAfterFee(high, feeRatePips) <= netCapacity) {
    high *= 2n;
    assert(high <= MAX_UINT256, "gross boundary exceeds uint256");
  }
  while (low + 1n < high) {
    const middle = (low + high) / 2n;
    if (netQuoteAfterFee(middle, feeRatePips) <= netCapacity) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

function bpsCeil(numerator, denominator) {
  if (numerator <= 0n) return 0n;
  return divRoundingUp(numerator * BPS_DENOMINATOR, denominator);
}

function formatUnits(value, decimals = 18, displayDecimals = 6) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const remainder = value % base;
  if (remainder === 0n || displayDecimals === 0) return whole.toString();
  const divisor = 10n ** BigInt(decimals - displayDecimals);
  const displayed = remainder / divisor;
  if (displayed === 0n) return `<0.${"0".repeat(displayDecimals - 1)}1`;
  return `${whole}.${displayed
    .toString()
    .padStart(displayDecimals, "0")
    .replace(/0+$/, "")}`;
}

function ratioPercentFromBps(bps) {
  const whole = bps / 100n;
  const fraction = bps % 100n;
  return `${whole}.${fraction.toString().padStart(2, "0")}%`;
}

function displayAmount(value, unit) {
  return {
    baseUnits: value.toString(),
    display: formatUnits(value),
    unit,
  };
}

function simulateBuy({
  grossQuoteIn,
  buyFeeRatePips,
  sellFeeRatePips,
  sqrtLowerX96,
  sqrtStartX96,
  liquidity,
  netCurveCapacity,
}) {
  const buyFee = feeForGrossQuote(grossQuoteIn, buyFeeRatePips);
  const poolQuoteIn = grossQuoteIn - buyFee;
  const fills = poolQuoteIn <= netCurveCapacity;
  const poolQuoteSpent = fills ? poolQuoteIn : netCurveCapacity;
  const sqrtAfterBuyX96 =
    poolQuoteSpent === netCurveCapacity
      ? sqrtLowerX96
      : nextSqrtFromAmount0Input(
          sqrtStartX96,
          liquidity,
          poolQuoteSpent,
        );
  const tokensOut = getAmount1Delta(
    sqrtAfterBuyX96,
    sqrtStartX96,
    liquidity,
    false,
  );

  const startSquared = sqrtStartX96 * sqrtStartX96;
  const endSquared = sqrtAfterBuyX96 * sqrtAfterBuyX96;
  const spotImpactBps = bpsCeil(
    startSquared - endSquared,
    endSquared,
  );
  const averageCurveNumerator =
    poolQuoteSpent * startSquared - tokensOut * Q192;
  const averageCurveImpactBps =
    tokensOut === 0n
      ? null
      : bpsCeil(averageCurveNumerator, tokensOut * Q192);
  const averageGrossNumerator =
    grossQuoteIn * startSquared - tokensOut * Q192;
  const averageGrossImpactBps =
    tokensOut === 0n
      ? null
      : bpsCeil(averageGrossNumerator, tokensOut * Q192);
  const averageCurvePipedogPerTokenWad =
    tokensOut === 0n ? null : mulDiv(poolQuoteSpent, WAD, tokensOut);
  const averageGrossPipedogPerTokenWad =
    tokensOut === 0n ? null : mulDiv(grossQuoteIn, WAD, tokensOut);

  const tokensNeededToStart = getAmount1Delta(
    sqrtAfterBuyX96,
    sqrtStartX96,
    liquidity,
    true,
  );
  const tokensSold =
    tokensOut >= tokensNeededToStart ? tokensNeededToStart : tokensOut;
  const sqrtAfterSellX96 =
    tokensSold === tokensNeededToStart
      ? sqrtStartX96
      : nextSqrtFromAmount1Input(
          sqrtAfterBuyX96,
          liquidity,
          tokensSold,
        );
  const grossQuoteOut = getAmount0Delta(
    sqrtAfterBuyX96,
    sqrtAfterSellX96,
    liquidity,
    false,
  );
  const sellFee = feeForGrossQuote(grossQuoteOut, sellFeeRatePips);
  const netQuoteOut = grossQuoteOut - sellFee;
  const roundTripLoss =
    grossQuoteIn >= netQuoteOut ? grossQuoteIn - netQuoteOut : 0n;
  const roundTripLossBps = bpsCeil(roundTripLoss, grossQuoteIn);

  return {
    fills,
    grossQuoteIn,
    buyFee,
    poolQuoteIn,
    poolQuoteSpent,
    unfilledPoolQuote: poolQuoteIn - poolQuoteSpent,
    tokensOut,
    sqrtAfterBuyX96,
    tickAfterBuy: getTickAtSqrtPrice(sqrtAfterBuyX96),
    capacityUtilizationBps: bpsCeil(
      poolQuoteSpent,
      netCurveCapacity,
    ),
    spotPriceImpactBps: spotImpactBps,
    averageCurvePriceImpactBps: averageCurveImpactBps,
    averageGrossPriceImpactBps: averageGrossImpactBps,
    endingSpotPipedogPerTokenWad: mulDiv(Q192, WAD, endSquared),
    averageCurvePipedogPerTokenWad,
    averageGrossPipedogPerTokenWad,
    reversal: {
      tokensSold,
      tokenRefund: tokensOut - tokensSold,
      grossQuoteOut,
      sellFee,
      netQuoteOut,
      sqrtAfterSellX96,
      tickAfterSell: getTickAtSqrtPrice(sqrtAfterSellX96),
      roundTripLoss,
      roundTripLossBps,
    },
  };
}

async function modelSourceHashes(contractsRoot) {
  const hashes = {};
  for (const path of MODEL_SOURCE_PATHS) {
    const absolute = join(contractsRoot, ...path.split("/"));
    const contents = await readFile(absolute, "utf8");
    hashes[path] = sha256(contents.replace(/\r\n?/g, "\n"));
  }
  return hashes;
}

async function dependencyPinMismatches(contractsRoot) {
  const installer = await readFile(
    join(contractsRoot, "scripts", "install-deps.ps1"),
    "utf8",
  );
  const liquidityAmounts = await readFile(
    join(contractsRoot, "src", "lib", "LiquidityAmounts.sol"),
    "utf8",
  );
  const mismatches = [];
  if (!installer.includes(MODEL_DEPENDENCY_PINS["uniswap-v4-core"])) {
    mismatches.push("uniswap-v4-core");
  }
  if (
    !liquidityAmounts.includes(
      MODEL_DEPENDENCY_PINS["v4-periphery-liquidity-amounts"],
    )
  ) {
    mismatches.push("v4-periphery-liquidity-amounts");
  }
  return mismatches;
}

function parseReview(review) {
  requireExactKeys(review, "review", [
    "approval",
    "chainId",
    "launchConfig",
    "model",
    "quoteDecimals",
    "quoteToken",
    "reviewBounds",
    "schemaVersion",
    "tokenDecimals",
  ]);
  assert(
    review.schemaVersion === REVIEW_SCHEMA_VERSION,
    `schemaVersion must be ${REVIEW_SCHEMA_VERSION}`,
  );
  assert(review.model === MODEL_ID, `model must be ${MODEL_ID}`);
  assert(
    review.chainId === ROBINHOOD_CHAIN_ID,
    `chainId must be ${ROBINHOOD_CHAIN_ID}`,
  );
  assert(
    typeof review.quoteToken === "string" &&
      review.quoteToken.toLowerCase() === PIPEDOG_ADDRESS,
    `quoteToken must be canonical PIPEDOG ${PIPEDOG_ADDRESS}`,
  );
  assert(review.quoteDecimals === 18, "quoteDecimals must be 18");
  assert(review.tokenDecimals === 18, "tokenDecimals must be 18");

  requireExactKeys(review.launchConfig, "launchConfig", [
    "baseFeeRatePips",
    "creatorFeeBps",
    "enabled",
    "launchFeeDecaySeconds",
    "launchFeePipedogWei",
    "launchFeeRatePips",
    "selfBurn",
    "startTick",
    "supplyWei",
    "tickSpacing",
  ]);
  const supply = parseUintString(
    review.launchConfig.supplyWei,
    "launchConfig.supplyWei",
    { allowZero: false },
  );
  const launchFee = parseUintString(
    review.launchConfig.launchFeePipedogWei,
    "launchConfig.launchFeePipedogWei",
  );
  const tickSpacing = parseSafeInteger(
    review.launchConfig.tickSpacing,
    "launchConfig.tickSpacing",
    { minimum: 1, maximum: MAX_TICK_SPACING },
  );
  const startTick = parseSafeInteger(
    review.launchConfig.startTick,
    "launchConfig.startTick",
    { minimum: MIN_TICK, maximum: MAX_TICK },
  );
  const creatorFeeBps = parseSafeInteger(
    review.launchConfig.creatorFeeBps,
    "launchConfig.creatorFeeBps",
    { minimum: 0, maximum: 10_000 },
  );
  const baseFeeRatePips = parseSafeInteger(
    review.launchConfig.baseFeeRatePips,
    "launchConfig.baseFeeRatePips",
    { minimum: 0, maximum: 900_000 },
  );
  const launchFeeRatePips = parseSafeInteger(
    review.launchConfig.launchFeeRatePips,
    "launchConfig.launchFeeRatePips",
    { minimum: baseFeeRatePips, maximum: 900_000 },
  );
  const launchFeeDecaySeconds = parseSafeInteger(
    review.launchConfig.launchFeeDecaySeconds,
    "launchConfig.launchFeeDecaySeconds",
    { minimum: 0, maximum: 2 ** 32 - 1 },
  );
  assert(
    typeof review.launchConfig.enabled === "boolean",
    "launchConfig.enabled must be boolean",
  );
  assert(
    typeof review.launchConfig.selfBurn === "boolean",
    "launchConfig.selfBurn must be boolean",
  );

  requireExactKeys(review.reviewBounds, "reviewBounds", [
    "maxInitialFdvErrorBps",
    "maxLaunchFeeBpsOfTargetFdv",
    "maxSeedDustTokenWei",
    "minimumNetCurveCapacityPipedogWei",
    "representativeBuys",
    "targetInitialFdvPipedogWei",
  ]);
  const targetInitialFdv = parseUintString(
    review.reviewBounds.targetInitialFdvPipedogWei,
    "reviewBounds.targetInitialFdvPipedogWei",
    { allowZero: false },
  );
  const minimumNetCurveCapacity = parseUintString(
    review.reviewBounds.minimumNetCurveCapacityPipedogWei,
    "reviewBounds.minimumNetCurveCapacityPipedogWei",
    { allowZero: false },
  );
  const maxSeedDust = parseUintString(
    review.reviewBounds.maxSeedDustTokenWei,
    "reviewBounds.maxSeedDustTokenWei",
  );
  const maxInitialFdvErrorBps = parseSafeInteger(
    review.reviewBounds.maxInitialFdvErrorBps,
    "reviewBounds.maxInitialFdvErrorBps",
    { minimum: 0, maximum: 10_000 },
  );
  const maxLaunchFeeBpsOfTargetFdv = parseSafeInteger(
    review.reviewBounds.maxLaunchFeeBpsOfTargetFdv,
    "reviewBounds.maxLaunchFeeBpsOfTargetFdv",
    { minimum: 0, maximum: 1_000_000 },
  );
  assert(
    Array.isArray(review.reviewBounds.representativeBuys) &&
      review.reviewBounds.representativeBuys.length >= 3 &&
      review.reviewBounds.representativeBuys.length <= 32,
    "reviewBounds.representativeBuys must contain 3 to 32 scenarios",
  );

  const labels = new Set();
  let previousGross = 0n;
  const representativeBuys = review.reviewBounds.representativeBuys.map(
    (scenario, index) => {
      const path = `reviewBounds.representativeBuys[${index}]`;
      requireExactKeys(scenario, path, [
        "buyFeeRatePips",
        "grossPipedogInWei",
        "label",
        "maxAverageGrossPriceImpactBps",
        "maxRoundTripLossBps",
        "maxSpotPriceImpactBps",
        "minTokensOutWei",
        "sellFeeRatePips",
      ]);
      assert(
        typeof scenario.label === "string" &&
          /^[a-z0-9][a-z0-9_-]{0,31}$/.test(scenario.label),
        `${path}.label must be a lowercase stable identifier`,
      );
      assert(!labels.has(scenario.label), `${path}.label must be unique`);
      labels.add(scenario.label);
      const grossPipedogIn = parseUintString(
        scenario.grossPipedogInWei,
        `${path}.grossPipedogInWei`,
        { allowZero: false },
      );
      assert(
        grossPipedogIn > previousGross,
        `${path}.grossPipedogInWei must be strictly increasing`,
      );
      previousGross = grossPipedogIn;
      const minTokensOut = parseUintString(
        scenario.minTokensOutWei,
        `${path}.minTokensOutWei`,
        { allowZero: false },
      );
      const buyFeeRate = parseSafeInteger(
        scenario.buyFeeRatePips,
        `${path}.buyFeeRatePips`,
        { minimum: 0, maximum: 900_000 },
      );
      const sellFeeRate = parseSafeInteger(
        scenario.sellFeeRatePips,
        `${path}.sellFeeRatePips`,
        { minimum: 0, maximum: 900_000 },
      );
      const maxSpotPriceImpactBps = parseSafeInteger(
        scenario.maxSpotPriceImpactBps,
        `${path}.maxSpotPriceImpactBps`,
        { minimum: 0, maximum: 1_000_000 },
      );
      const maxAverageGrossPriceImpactBps = parseSafeInteger(
        scenario.maxAverageGrossPriceImpactBps,
        `${path}.maxAverageGrossPriceImpactBps`,
        { minimum: 0, maximum: 1_000_000 },
      );
      const maxRoundTripLossBps = parseSafeInteger(
        scenario.maxRoundTripLossBps,
        `${path}.maxRoundTripLossBps`,
        { minimum: 0, maximum: 10_000 },
      );
      return {
        ...scenario,
        grossPipedogIn,
        minTokensOut,
        buyFeeRate: BigInt(buyFeeRate),
        sellFeeRate: BigInt(sellFeeRate),
        maxSpotPriceImpactBps,
        maxAverageGrossPriceImpactBps,
        maxRoundTripLossBps,
      };
    },
  );

  requireExactKeys(review.approval, "approval", [
    "configHash",
    "reviewedAt",
    "reviewer",
    "status",
  ]);
  assert(
    review.approval.status === "draft" ||
      review.approval.status === "approved",
    "approval.status must be draft or approved",
  );
  assert(
    typeof review.approval.configHash === "string",
    "approval.configHash must be a string",
  );
  assert(
    typeof review.approval.reviewer === "string",
    "approval.reviewer must be a string",
  );
  assert(
    typeof review.approval.reviewedAt === "string",
    "approval.reviewedAt must be a string",
  );

  return {
    supply,
    launchFee,
    tickSpacing,
    startTick,
    creatorFeeBps,
    baseFeeRatePips,
    launchFeeRatePips,
    launchFeeDecaySeconds,
    targetInitialFdv,
    minimumNetCurveCapacity,
    maxSeedDust,
    maxInitialFdvErrorBps,
    maxLaunchFeeBpsOfTargetFdv,
    representativeBuys,
  };
}

function issue(code, message, context = undefined) {
  return context === undefined ? { code, message } : { code, message, context };
}

export async function evaluateCurveReview(
  review,
  { contractsRoot = CONTRACTS_ROOT } = {},
) {
  const parsed = parseReview(review);
  const sources = await modelSourceHashes(contractsRoot);
  const dependencyMismatches = await dependencyPinMismatches(contractsRoot);
  const approvalPayload = {
    economicReview: {
      ...review,
      approval: undefined,
      quoteToken: review.quoteToken.toLowerCase(),
    },
    modelDependencyPins: MODEL_DEPENDENCY_PINS,
    modelSources: sources,
  };
  delete approvalPayload.economicReview.approval;
  const computedConfigHash = sha256(canonicalJson(approvalPayload));
  const issues = [];

  if (dependencyMismatches.length > 0) {
    issues.push(
      issue(
        "MODEL_DEPENDENCY_PIN_MISMATCH",
        "the curve model dependency pins no longer match the tracked installer or vendored liquidity source",
        { dependencies: dependencyMismatches },
      ),
    );
  }

  if (review.approval.status !== "approved") {
    issues.push(
      issue(
        "APPROVAL_REQUIRED",
        "approval.status is not approved; copy the computed hash only after review",
      ),
    );
  }
  if (review.approval.configHash !== computedConfigHash) {
    issues.push(
      issue(
        "CONFIG_HASH_MISMATCH",
        "approval.configHash does not match the exact review inputs and model sources",
        {
          expected: computedConfigHash,
          provided: review.approval.configHash,
        },
      ),
    );
  }
  if (
    review.approval.status === "approved" &&
    (review.approval.reviewer.trim().length === 0 ||
      review.approval.reviewer.length > 256 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        review.approval.reviewedAt,
      ) ||
      !Number.isFinite(Date.parse(review.approval.reviewedAt)))
  ) {
    issues.push(
      issue(
        "APPROVAL_METADATA_REQUIRED",
        "approved reviews require a reviewer (1-256 characters) and a valid UTC RFC3339 reviewedAt timestamp",
      ),
    );
  }

  if (parsed.supply > MAX_UINT192) {
    issues.push(
      issue("SUPPLY_EXCEEDS_FACTORY_LIMIT", "supply exceeds uint192"),
    );
  }
  const minTick = minimumUsableTick(parsed.tickSpacing);
  const maxTick = maximumUsableTick(parsed.tickSpacing);
  if (
    parsed.startTick <= minTick ||
    parsed.startTick > maxTick ||
    parsed.startTick % parsed.tickSpacing !== 0
  ) {
    issues.push(
      issue(
        "INVALID_TICK_RANGE",
        "startTick must be aligned and inside the factory's usable range",
        { minExclusive: minTick, maxInclusive: maxTick },
      ),
    );
  }
  if (!review.launchConfig.enabled) {
    issues.push(
      issue(
        "CONFIG_DISABLED",
        "the reviewed launch config is disabled and cannot be activated as reviewed",
      ),
    );
  }
  if (review.launchConfig.selfBurn) {
    issues.push(
      issue(
        "SELF_BURN_PRICE_GUARD_MISSING",
        "self-burn activation is not approvable while its permissionless market order lacks an independently audited price guard",
      ),
    );
  }
  if (
    parsed.creatorFeeBps !== 7_000 ||
    parsed.baseFeeRatePips !== 10_000 ||
    parsed.launchFeeRatePips !== 10_000 ||
    parsed.launchFeeDecaySeconds !== 0
  ) {
    issues.push(
      issue(
        "UNSUPPORTED_ACTIVE_FEE_CONFIG",
        "the current factory only enables creatorFeeBps=7000, fixed 10000-pip fees, and zero decay",
      ),
    );
  }

  if (issues.some((entry) => entry.code === "INVALID_TICK_RANGE")) {
    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      model: MODEL_ID,
      gate: { status: "fail", computedConfigHash, issues },
      modelSources: sources,
      modelDependencyPins: MODEL_DEPENDENCY_PINS,
      limits: {
        displayAmountsAreRoundedDownToDecimals: 6,
        exactBaseUnitsAreAuthoritative: true,
      },
    };
  }

  const sqrtLowerX96 = getSqrtPriceAtTick(minTick);
  const sqrtStartX96 = getSqrtPriceAtTick(parsed.startTick);
  const liquidity = liquidityForAmount1(
    sqrtLowerX96,
    sqrtStartX96,
    parsed.supply,
  );
  if (liquidity === 0n || liquidity > MAX_INT128) {
    issues.push(
      issue(
        "LIQUIDITY_OUT_OF_FACTORY_RANGE",
        "derived liquidity is zero or exceeds the factory int128 limit",
        { liquidity: liquidity.toString() },
      ),
    );
    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      model: MODEL_ID,
      gate: { status: "fail", computedConfigHash, issues },
      exactInputs: {
        chainId: review.chainId,
        quoteToken: review.quoteToken.toLowerCase(),
        launchConfig: review.launchConfig,
        reviewBounds: review.reviewBounds,
      },
      launchBoundary: {
        minimumUsableTick: minTick,
        startTick: parsed.startTick,
        sqrtLowerX96: sqrtLowerX96.toString(),
        sqrtStartX96: sqrtStartX96.toString(),
        liquidity: liquidity.toString(),
      },
      modelSources: sources,
      modelDependencyPins: MODEL_DEPENDENCY_PINS,
      limits: {
        exactBaseUnitsAreAuthoritative: true,
        warning:
          "simulation stopped because the factory cannot seed this liquidity",
      },
    };
  }
  const seededTokenAmount = getAmount1Delta(
    sqrtLowerX96,
    sqrtStartX96,
    liquidity,
    true,
  );
  const seedDust = parsed.supply - seededTokenAmount;
  const netCurveCapacity = getAmount0Delta(
    sqrtLowerX96,
    sqrtStartX96,
    liquidity,
    true,
  );
  if (netCurveCapacity > MAX_UINT256) {
    issues.push(
      issue(
        "CURVE_CAPACITY_EXCEEDS_UINT256",
        "the modeled cumulative PIPEDOG capacity exceeds uint256 arithmetic",
      ),
    );
    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      model: MODEL_ID,
      gate: { status: "fail", computedConfigHash, issues },
      exactInputs: {
        chainId: review.chainId,
        quoteToken: review.quoteToken.toLowerCase(),
        launchConfig: review.launchConfig,
        reviewBounds: review.reviewBounds,
      },
      launchBoundary: {
        minimumUsableTick: minTick,
        startTick: parsed.startTick,
        sqrtLowerX96: sqrtLowerX96.toString(),
        sqrtStartX96: sqrtStartX96.toString(),
        liquidity: liquidity.toString(),
        netCurveCapacity: netCurveCapacity.toString(),
      },
      modelSources: sources,
      modelDependencyPins: MODEL_DEPENDENCY_PINS,
      limits: {
        exactBaseUnitsAreAuthoritative: true,
        warning:
          "simulation stopped because the exhaustion boundary is outside uint256",
      },
    };
  }
  const boundaryGross = maximumGrossForNetCapacity(
    netCurveCapacity,
    BigInt(parsed.baseFeeRatePips),
  );
  if (boundaryGross > MAX_UINT256) {
    issues.push(
      issue(
        "GROSS_EXHAUSTION_BOUNDARY_EXCEEDS_UINT256",
        "the fee-inclusive exhaustion boundary cannot be represented as uint256",
      ),
    );
  }
  const boundaryFee = feeForGrossQuote(
    boundaryGross,
    BigInt(parsed.baseFeeRatePips),
  );
  const boundaryTokenOut = getAmount1Delta(
    sqrtLowerX96,
    sqrtStartX96,
    liquidity,
    false,
  );

  if (seededTokenAmount > MAX_INT128) {
    issues.push(
      issue(
        "SEED_DELTA_EXCEEDS_INT128",
        "the initial token liquidity delta cannot fit BalanceDelta.int128",
      ),
    );
  }
  if (seedDust > parsed.maxSeedDust) {
    issues.push(
      issue(
        "SEED_DUST_LIMIT_EXCEEDED",
        "derived launch-token dust exceeds the approved bound",
        {
          actual: seedDust.toString(),
          maximum: parsed.maxSeedDust.toString(),
        },
      ),
    );
  }
  if (netCurveCapacity < parsed.minimumNetCurveCapacity) {
    issues.push(
      issue(
        "CURVE_CAPACITY_BELOW_MINIMUM",
        "net PIPEDOG curve capacity is below the approved minimum",
        {
          actual: netCurveCapacity.toString(),
          minimum: parsed.minimumNetCurveCapacity.toString(),
        },
      ),
    );
  }

  const startSquared = sqrtStartX96 * sqrtStartX96;
  const fdvNumerator = parsed.supply * Q192;
  const impliedInitialFdv = fdvNumerator / startSquared;
  const curveEconomicsPriceX96 = startSquared / Q96;
  const curveEconomicsTokensPerPipedogWad = mulDiv(
    curveEconomicsPriceX96,
    WAD,
    Q96,
  );
  const curveEconomicsHelperFdv =
    curveEconomicsTokensPerPipedogWad === 0n
      ? null
      : mulDiv(
          parsed.supply,
          WAD,
          curveEconomicsTokensPerPipedogWad,
        );
  if (curveEconomicsTokensPerPipedogWad === 0n) {
    issues.push(
      issue(
        "CURVE_ECONOMICS_HELPER_UNDERFLOW",
        "CurveEconomics.tokensPerPipedogWad rounds to zero at this tick, so the deployment FDV helper would revert",
      ),
    );
  }
  if (curveEconomicsHelperFdv !== null && curveEconomicsHelperFdv > MAX_UINT256) {
    issues.push(
      issue(
        "CURVE_ECONOMICS_HELPER_OVERFLOW",
        "CurveEconomics.impliedInitialFdvPipedog exceeds uint256 at this tick",
      ),
    );
  }
  if (impliedInitialFdv > MAX_UINT256) {
    issues.push(
      issue(
        "INITIAL_FDV_EXCEEDS_UINT256",
        "implied initial FDV cannot be represented as uint256",
      ),
    );
  }
  const targetNumerator = parsed.targetInitialFdv * startSquared;
  const fdvErrorNumerator =
    fdvNumerator >= targetNumerator
      ? fdvNumerator - targetNumerator
      : targetNumerator - fdvNumerator;
  const fdvErrorBps = bpsCeil(fdvErrorNumerator, targetNumerator);
  if (fdvErrorBps > BigInt(parsed.maxInitialFdvErrorBps)) {
    issues.push(
      issue(
        "INITIAL_FDV_ERROR_LIMIT_EXCEEDED",
        "aligned start tick misses the approved FDV tolerance",
        {
          actualBpsCeiling: fdvErrorBps.toString(),
          maximumBps: String(parsed.maxInitialFdvErrorBps),
        },
      ),
    );
  }
  const launchFeeBpsOfTargetFdv = bpsCeil(
    parsed.launchFee,
    parsed.targetInitialFdv,
  );
  if (
    launchFeeBpsOfTargetFdv >
    BigInt(parsed.maxLaunchFeeBpsOfTargetFdv)
  ) {
    issues.push(
      issue(
        "LAUNCH_FEE_LIMIT_EXCEEDED",
        "launch fee exceeds the approved share of target initial FDV",
        {
          actualBpsCeiling: launchFeeBpsOfTargetFdv.toString(),
          maximumBps: String(parsed.maxLaunchFeeBpsOfTargetFdv),
        },
      ),
    );
  }

  const scenarioReports = parsed.representativeBuys.map((scenario) => {
    if (
      scenario.buyFeeRate !== BigInt(parsed.baseFeeRatePips) ||
      scenario.sellFeeRate !== BigInt(parsed.baseFeeRatePips)
    ) {
      issues.push(
        issue(
          "SCENARIO_FEE_MISMATCH",
          `${scenario.label} does not use the current fixed hook fee`,
        ),
      );
    }
    if (scenario.grossPipedogIn > MAX_INT128) {
      issues.push(
        issue(
          "SCENARIO_GROSS_INPUT_EXCEEDS_INT128",
          `${scenario.label} gross input exceeds the conservative single-swap BalanceDelta limit`,
        ),
      );
    }
    const launchPaymentFitsUint256 =
      scenario.grossPipedogIn <= MAX_UINT256 - parsed.launchFee;
    if (!launchPaymentFitsUint256) {
      issues.push(
        issue(
          "SCENARIO_LAUNCH_PAYMENT_OVERFLOW",
          `${scenario.label} launch fee plus first buy exceeds uint256`,
        ),
      );
    }
    const simulation = simulateBuy({
      grossQuoteIn: scenario.grossPipedogIn,
      buyFeeRatePips: scenario.buyFeeRate,
      sellFeeRatePips: scenario.sellFeeRate,
      sqrtLowerX96,
      sqrtStartX96,
      liquidity,
      netCurveCapacity,
    });
    if (!simulation.fills) {
      issues.push(
        issue(
          "SCENARIO_PARTIAL_FILL",
          `${scenario.label} exceeds the curve boundary and would revert in the hook`,
        ),
      );
    }
    if (simulation.tokensOut < scenario.minTokensOut) {
      issues.push(
        issue(
          "SCENARIO_MIN_OUTPUT_MISSED",
          `${scenario.label} token output is below the approved floor`,
          {
            actual: simulation.tokensOut.toString(),
            minimum: scenario.minTokensOut.toString(),
          },
        ),
      );
    }
    if (
      simulation.spotPriceImpactBps >
      BigInt(scenario.maxSpotPriceImpactBps)
    ) {
      issues.push(
        issue(
          "SCENARIO_PRICE_IMPACT_LIMIT_EXCEEDED",
          `${scenario.label} ending spot-price impact exceeds the approved bound`,
          {
            actualBpsCeiling: simulation.spotPriceImpactBps.toString(),
            maximumBps: String(scenario.maxSpotPriceImpactBps),
          },
        ),
      );
    }
    if (
      simulation.averageGrossPriceImpactBps === null ||
      simulation.averageGrossPriceImpactBps >
        BigInt(scenario.maxAverageGrossPriceImpactBps)
    ) {
      issues.push(
        issue(
          "SCENARIO_AVERAGE_GROSS_PRICE_IMPACT_LIMIT_EXCEEDED",
          `${scenario.label} fee-inclusive average execution-price impact exceeds the approved bound`,
          {
            actualBpsCeiling:
              simulation.averageGrossPriceImpactBps === null
                ? "undefined-no-token-output"
                : simulation.averageGrossPriceImpactBps.toString(),
            maximumBps: String(
              scenario.maxAverageGrossPriceImpactBps,
            ),
          },
        ),
      );
    }
    if (
      simulation.reversal.roundTripLossBps >
      BigInt(scenario.maxRoundTripLossBps)
    ) {
      issues.push(
        issue(
          "SCENARIO_ROUND_TRIP_LIMIT_EXCEEDED",
          `${scenario.label} buy/sell reversal loss exceeds the approved bound`,
          {
            actualBpsCeiling:
              simulation.reversal.roundTripLossBps.toString(),
            maximumBps: String(scenario.maxRoundTripLossBps),
          },
        ),
      );
    }

    return {
      label: scenario.label,
      approvedBounds: {
        minTokensOutWei: scenario.minTokensOut.toString(),
        maxSpotPriceImpactBps: scenario.maxSpotPriceImpactBps,
        maxAverageGrossPriceImpactBps:
          scenario.maxAverageGrossPriceImpactBps,
        maxRoundTripLossBps: scenario.maxRoundTripLossBps,
      },
      feeAssumptions: {
        buyFeeRatePips: scenario.buyFeeRatePips,
        sellFeeRatePips: scenario.sellFeeRatePips,
      },
      buy: {
        fills: simulation.fills,
        grossPipedogIn: displayAmount(
          simulation.grossQuoteIn,
          "PIPEDOG",
        ),
        exactLaunchAllowanceIfUsedAsFirstBuy:
          launchPaymentFitsUint256
            ? displayAmount(
                parsed.launchFee + simulation.grossQuoteIn,
                "PIPEDOG",
              )
            : "uint256-overflow",
        hookFee: displayAmount(simulation.buyFee, "PIPEDOG"),
        poolPipedogIn: displayAmount(
          simulation.poolQuoteSpent,
          "PIPEDOG",
        ),
        unfilledPoolPipedog: displayAmount(
          simulation.unfilledPoolQuote,
          "PIPEDOG",
        ),
        tokensOut: displayAmount(simulation.tokensOut, "launch token"),
        endSqrtPriceX96: simulation.sqrtAfterBuyX96.toString(),
        endTick: simulation.tickAfterBuy,
        curveCapacityUtilizationBpsCeiling:
          simulation.capacityUtilizationBps.toString(),
        endingSpotPriceImpactBpsCeiling:
          simulation.spotPriceImpactBps.toString(),
        endingSpotPriceImpactPercentCeiling: ratioPercentFromBps(
          simulation.spotPriceImpactBps,
        ),
        averageCurvePriceImpactBpsCeiling:
          simulation.averageCurvePriceImpactBps === null
            ? "undefined-no-token-output"
            : simulation.averageCurvePriceImpactBps.toString(),
        averageGrossPriceImpactBpsCeiling:
          simulation.averageGrossPriceImpactBps === null
            ? "undefined-no-token-output"
            : simulation.averageGrossPriceImpactBps.toString(),
        endingSpotPipedogPerTokenWad:
          simulation.endingSpotPipedogPerTokenWad.toString(),
        averageCurvePipedogPerTokenWad:
          simulation.averageCurvePipedogPerTokenWad === null
            ? "undefined-no-token-output"
            : simulation.averageCurvePipedogPerTokenWad.toString(),
        averageGrossPipedogPerTokenWad:
          simulation.averageGrossPipedogPerTokenWad === null
            ? "undefined-no-token-output"
            : simulation.averageGrossPipedogPerTokenWad.toString(),
      },
      sellSideReversal: {
        model: "sell the exact token output immediately back through the same zero-LP-fee range",
        tokensSold: displayAmount(
          simulation.reversal.tokensSold,
          "launch token",
        ),
        tokenRefund: displayAmount(
          simulation.reversal.tokenRefund,
          "launch token",
        ),
        grossPipedogOut: displayAmount(
          simulation.reversal.grossQuoteOut,
          "PIPEDOG",
        ),
        hookFee: displayAmount(
          simulation.reversal.sellFee,
          "PIPEDOG",
        ),
        netPipedogOut: displayAmount(
          simulation.reversal.netQuoteOut,
          "PIPEDOG",
        ),
        endSqrtPriceX96:
          simulation.reversal.sqrtAfterSellX96.toString(),
        endTick: simulation.reversal.tickAfterSell,
        roundTripLoss: displayAmount(
          simulation.reversal.roundTripLoss,
          "PIPEDOG",
        ),
        roundTripLossBpsCeiling:
          simulation.reversal.roundTripLossBps.toString(),
      },
    };
  });

  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    model: MODEL_ID,
    gate: {
      status: issues.length === 0 ? "pass" : "fail",
      computedConfigHash,
      approvedConfigHash: review.approval.configHash,
      reviewer: review.approval.reviewer,
      reviewedAt: review.approval.reviewedAt,
      issues,
    },
    exactInputs: {
      chainId: review.chainId,
      quoteToken: review.quoteToken.toLowerCase(),
      quoteDecimals: review.quoteDecimals,
      tokenDecimals: review.tokenDecimals,
      launchConfig: review.launchConfig,
      reviewBounds: review.reviewBounds,
    },
    launchBoundary: {
      minimumUsableTick: minTick,
      startTick: parsed.startTick,
      sqrtLowerX96: sqrtLowerX96.toString(),
      sqrtStartX96: sqrtStartX96.toString(),
      liquidity: liquidity.toString(),
      suppliedTokens: displayAmount(parsed.supply, "launch token"),
      seededTokens: displayAmount(seededTokenAmount, "launch token"),
      burnedSeedDust: displayAmount(seedDust, "launch token"),
      exactRationalTokensPerPipedogWadFloor: mulDiv(
        startSquared,
        WAD,
        Q192,
      ).toString(),
      curveEconomicsTokensPerPipedogWad:
        curveEconomicsTokensPerPipedogWad.toString(),
      initialPipedogPerTokenWad: mulDiv(
        Q192,
        WAD,
        startSquared,
      ).toString(),
      impliedInitialFdv: displayAmount(
        impliedInitialFdv,
        "PIPEDOG",
      ),
      targetInitialFdv: displayAmount(
        parsed.targetInitialFdv,
        "PIPEDOG",
      ),
      curveEconomicsHelperImpliedInitialFdv:
        curveEconomicsHelperFdv === null
          ? "reverts-price-rounded-to-zero"
          : displayAmount(curveEconomicsHelperFdv, "PIPEDOG"),
      initialFdvErrorBpsCeiling: fdvErrorBps.toString(),
    },
    exhaustionBoundary: {
      netCapacityInterpretation:
        "path-independent cumulative zeroForOne PIPEDOG that can enter the pool before the lower tick is reached",
      grossBoundaryInterpretation:
        "fee-inclusive one-call arithmetic only; when it exceeds int128 it is not one executable swap, and cumulative gross fees depend on transaction partitioning because fees round per swap",
      netPoolPipedogCapacity: displayAmount(
        netCurveCapacity,
        "PIPEDOG",
      ),
      theoreticalSingleCallMaximumGrossBuyAtBaseFee: displayAmount(
        boundaryGross,
        "PIPEDOG",
      ),
      hookFeeAtBoundary: displayAmount(boundaryFee, "PIPEDOG"),
      netInputAtBoundary: displayAmount(
        boundaryGross - boundaryFee,
        "PIPEDOG",
      ),
      tokenOutputAtBoundary: displayAmount(
        boundaryTokenOut,
        "launch token",
      ),
      theoreticalOneBaseUnitAboveBoundaryNetInput: displayAmount(
        netQuoteAfterFee(
          boundaryGross + 1n,
          BigInt(parsed.baseFeeRatePips),
        ),
        "PIPEDOG",
      ),
      grossBoundaryFitsConservativeSingleSwapInt128:
        boundaryGross <= MAX_INT128,
      maximumConservativeSingleSwapGrossInput: displayAmount(
        boundaryGross <= MAX_INT128 ? boundaryGross : MAX_INT128,
        "PIPEDOG",
      ),
      oneBaseUnitAboveWouldBeExecutablePartialFill:
        boundaryGross + 1n <= MAX_INT128,
    },
    representativeBuys: scenarioReports,
    feeAssumptions: {
      zeroLpFee: true,
      hookFeeDenominatorPips: Number(FEE_DENOMINATOR),
      creatorFeeBps: parsed.creatorFeeBps,
      baseFeeRatePips: parsed.baseFeeRatePips,
      launchFeeRatePips: parsed.launchFeeRatePips,
      launchFeeDecaySeconds: parsed.launchFeeDecaySeconds,
      launchFee: displayAmount(parsed.launchFee, "PIPEDOG"),
      launchFeeBpsOfTargetFdvCeiling:
        launchFeeBpsOfTargetFdv.toString(),
      approvedMaximumLaunchFeeBpsOfTargetFdv:
        parsed.maxLaunchFeeBpsOfTargetFdv,
      note:
        "trade fees are removed from the PIPEDOG side with integer flooring, matching the current exact-input hook paths",
    },
    modelSources: sources,
    modelDependencyPins: MODEL_DEPENDENCY_PINS,
    limits: {
      exactBaseUnitsAreAuthoritative: true,
      displayAmountsAreRoundedDownToDecimals: 6,
      scope:
        "deterministic single-range v4 liquidity and exact-input hook-fee arithmetic for the current LayPipe contracts",
      excluded:
        "mempool ordering, MEV/sandwiching, latency, demand, alternate venues, oracle/TWAP protection, gas, token price discovery, RPC behavior, and adversarial transaction sequencing",
      warning:
        "a passing gate proves only that the exact approved arithmetic bounds hold; it is not an economic endorsement, market-quality forecast, security audit, or deployment authorization",
    },
  };
}

export function decimalToBaseUnits(label, raw, decimals = 18) {
  assert(
    typeof raw === "string" && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw),
    `${label} must be a positive base-10 decimal`,
  );
  const [wholePart, fractionPart = ""] = raw.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  if (fractionPart.length > decimals) {
    assert(
      /^0*$/.test(fractionPart.slice(decimals)),
      `${label} has more than ${decimals} decimal places`,
    );
  }
  const fraction = fractionPart.slice(0, decimals).padEnd(decimals, "0");
  const result =
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || "0");
  assert(result > 0n, `${label} must be greater than zero`);
  return result;
}

function relativeErrorFraction(supply, targetFdv, tick) {
  const sqrt = getSqrtPriceAtTick(tick);
  const denominator = targetFdv * sqrt * sqrt;
  const numeratorValue = supply * Q192;
  const numerator =
    numeratorValue >= denominator
      ? numeratorValue - denominator
      : denominator - numeratorValue;
  return { numerator, denominator };
}

function compareFractions(left, right) {
  const comparison =
    left.numerator * right.denominator -
    right.numerator * left.denominator;
  return comparison < 0n ? -1 : comparison > 0n ? 1 : 0;
}

export function calibrateAlignedTick({
  supplyWei,
  targetFdvPipedogWei,
  tickSpacing,
}) {
  assert(supplyWei > 0n && supplyWei <= MAX_UINT192, "invalid supply");
  assert(targetFdvPipedogWei > 0n, "invalid target FDV");
  assert(
    Number.isSafeInteger(tickSpacing) &&
      tickSpacing >= 1 &&
      tickSpacing <= MAX_TICK_SPACING,
    "invalid tick spacing",
  );
  const minimum = minimumUsableTick(tickSpacing) + tickSpacing;
  const maximum = maximumUsableTick(tickSpacing);
  const count = Math.floor((maximum - minimum) / tickSpacing) + 1;
  let low = 0;
  let high = count - 1;
  const targetScaled = targetFdvPipedogWei;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const tick = minimum + middle * tickSpacing;
    const sqrt = getSqrtPriceAtTick(tick);
    const fdvAtOrBelowTarget =
      supplyWei * Q192 <= targetScaled * sqrt * sqrt;
    if (fdvAtOrBelowTarget) high = middle;
    else low = middle + 1;
  }
  const upperIndex = low;
  const indices = [...new Set([upperIndex - 1, upperIndex])].filter(
    (index) => index >= 0 && index < count,
  );
  const candidates = indices.map((index) => {
    const tick = minimum + index * tickSpacing;
    const sqrt = getSqrtPriceAtTick(tick);
    const impliedFdv = (supplyWei * Q192) / (sqrt * sqrt);
    const error = relativeErrorFraction(
      supplyWei,
      targetFdvPipedogWei,
      tick,
    );
    return { tick, sqrtPriceX96: sqrt, impliedFdv, error };
  });
  candidates.sort(
    (left, right) =>
      compareFractions(left.error, right.error) || left.tick - right.tick,
  );
  return {
    selected: candidates[0],
    alternatives: candidates.slice(1),
    minimumUsableTick: minimum - tickSpacing,
    maximumUsableTick: maximum,
  };
}

export function relativeErrorBpsCeiling(error) {
  return bpsCeil(error.numerator, error.denominator);
}

export function describeBaseUnits(value, unit) {
  return displayAmount(value, unit);
}

export function sourcePathForDisplay(path, root = CONTRACTS_ROOT) {
  return relative(root, resolve(path)).split(sep).join("/");
}
