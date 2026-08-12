#!/usr/bin/env node

import {
  calibrateAlignedTick,
  decimalToBaseUnits,
  describeBaseUnits,
  getSqrtPriceAtTick,
  MAX_TICK_SPACING,
  MAX_UINT192,
  MODEL_ID,
  Q96,
  Q192,
  relativeErrorBpsCeiling,
  WAD,
} from "./curve-model.mjs";

const LEGACY_TICK = 204_200;
const LEGACY_SUPPLY_WEI = 1_000_000_000n * WAD;

function usage() {
  return `Usage:
  node scripts/calibrate-curve.mjs --supply <tokens> --fdv <PIPEDOG> --tick-spacing <integer>

Environment equivalents:
  LAYPIPE_SUPPLY_TOKENS
  LAYPIPE_TARGET_FDV_PIPEDOG
  LAYPIPE_TICK_SPACING

Inputs are decimal whole-token amounts, not wei. Candidate selection uses the
same integer TickMath ratios as the contracts. Calibration is only step one:
an approved curve-review JSON must then pass scripts/simulate-curve.mjs.`;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      values.help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const equals = argument.indexOf("=");
    const key = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const value =
      equals === -1 ? argv[index + 1] : argument.slice(equals + 1);
    if (!["supply", "fdv", "tick-spacing"].includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    if (equals === -1) index += 1;
    values[key] = value;
  }
  return values;
}

function parseTickSpacing(raw) {
  if (!/^\d+$/.test(raw ?? "")) {
    throw new Error("tick spacing must be a positive integer");
  }
  const spacing = Number(raw);
  if (
    !Number.isSafeInteger(spacing) ||
    spacing < 1 ||
    spacing > MAX_TICK_SPACING
  ) {
    throw new Error(
      `tick spacing must be between 1 and ${MAX_TICK_SPACING}`,
    );
  }
  return spacing;
}

function candidateReport(candidate) {
  const sqrtSquared = candidate.sqrtPriceX96 * candidate.sqrtPriceX96;
  const curveEconomicsPriceX96 = sqrtSquared / Q96;
  return {
    startTick: candidate.tick,
    sqrtPriceX96: candidate.sqrtPriceX96.toString(),
    exactRationalTokensPerPipedogWadFloor: (
      (sqrtSquared * WAD) /
      Q192
    ).toString(),
    curveEconomicsTokensPerPipedogWad: (
      (curveEconomicsPriceX96 * WAD) /
      Q96
    ).toString(),
    impliedFdv: describeBaseUnits(candidate.impliedFdv, "PIPEDOG"),
    targetErrorBpsCeiling: relativeErrorBpsCeiling(
      candidate.error,
    ).toString(),
  };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const supplyRaw = args.supply ?? process.env.LAYPIPE_SUPPLY_TOKENS;
  const fdvRaw = args.fdv ?? process.env.LAYPIPE_TARGET_FDV_PIPEDOG;
  const spacingRaw =
    args["tick-spacing"] ?? process.env.LAYPIPE_TICK_SPACING;
  const missing = [
    ["supply", supplyRaw],
    ["fdv", fdvRaw],
    ["tick-spacing", spacingRaw],
  ]
    .filter(([, value]) => value === undefined || value === "")
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required input(s): ${missing.join(", ")}`);
  }

  const supplyWei = decimalToBaseUnits("supply", supplyRaw);
  const targetFdvWei = decimalToBaseUnits("fdv", fdvRaw);
  const tickSpacing = parseTickSpacing(spacingRaw);
  if (supplyWei > MAX_UINT192) {
    throw new Error("supply exceeds the factory uint192 limit");
  }

  const calibration = calibrateAlignedTick({
    supplyWei,
    targetFdvPipedogWei: targetFdvWei,
    tickSpacing,
  });
  const legacySqrt = getSqrtPriceAtTick(LEGACY_TICK);
  const legacyFdvWei =
    (LEGACY_SUPPLY_WEI * Q192) / (legacySqrt * legacySqrt);

  console.log(
    JSON.stringify(
      {
        model: MODEL_ID,
        method:
          "exact integer TickMath candidate search for equal 18-decimal assets at the one-sided launch boundary",
        inputs: {
          supply: describeBaseUnits(supplyWei, "launch token"),
          targetFdv: describeBaseUnits(targetFdvWei, "PIPEDOG"),
          tickSpacing,
        },
        usableTicks: {
          minimumExclusive: calibration.minimumUsableTick,
          maximumInclusive: calibration.maximumUsableTick,
        },
        selected: candidateReport(calibration.selected),
        alternatives: calibration.alternatives.map(candidateReport),
        deploymentEnvironment: {
          LAYPIPE_SUPPLY_WEI: supplyWei.toString(),
          LAYPIPE_TICK_SPACING: String(tickSpacing),
          LAYPIPE_START_TICK: String(calibration.selected.tick),
        },
        requiredNextGate: {
          command:
            "node scripts/simulate-curve.mjs --review <curve-review.json>",
          note:
            "Calibration does not approve executable depth, price impact, fees, reversals, or production economics.",
        },
        warning:
          `Tick ${LEGACY_TICK} is an unsafe legacy example: with ` +
          `1,000,000,000 tokens it implies ${describeBaseUnits(
            legacyFdvWei,
            "PIPEDOG",
          ).display} PIPEDOG FDV. It is not a default.`,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Curve calibration failed: ${error.message}`);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
}
