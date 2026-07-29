#!/usr/bin/env node

const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MAX_TICK_SPACING = 32767;
const LEGACY_TICK = 204200;
const LEGACY_SUPPLY = 1_000_000_000;
const LOG_TICK_BASE = Math.log1p(0.0001);
const MAX_SUPPLY_WEI = (1n << 192n) - 1n;

function usage() {
  return `Usage:
  node scripts/calibrate-curve.mjs --supply <tokens> --fdv <PIPEDOG> --tick-spacing <integer>

Environment equivalents:
  LAYPIPE_SUPPLY_TOKENS
  LAYPIPE_TARGET_FDV_PIPEDOG
  LAYPIPE_TICK_SPACING

Inputs are whole-token decimal amounts, not wei. The output includes the
18-decimal LAYPIPE_SUPPLY_WEI value expected by the deployment script.`;
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
    const key =
      equals === -1 ? argument.slice(2) : argument.slice(2, equals);
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

function parsePositiveDecimal(label, raw) {
  if (
    typeof raw !== "string" ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)
  ) {
    throw new Error(`${label} must be a positive base-10 decimal`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be finite and greater than zero`);
  }
  return value;
}

function decimalToWei(label, raw) {
  const [wholePart, fractionPart = ""] = raw.split(".");
  const whole = wholePart === "" ? "0" : wholePart;
  if (fractionPart.length > 18) {
    const discarded = fractionPart.slice(18);
    if (!/^0*$/.test(discarded)) {
      throw new Error(`${label} has more than 18 decimal places`);
    }
  }
  const fraction = fractionPart.slice(0, 18).padEnd(18, "0");
  return (
    BigInt(whole) * 10n ** 18n + BigInt(fraction || "0")
  ).toString();
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

function alignedCandidates(rawTick, spacing) {
  const lower = Math.floor(rawTick / spacing) * spacing;
  const upper = Math.ceil(rawTick / spacing) * spacing;
  const minimumUsable = Math.ceil(MIN_TICK / spacing) * spacing;
  const maximumUsable = Math.floor(MAX_TICK / spacing) * spacing;
  const candidates = [...new Set([lower, upper])].filter(
    (tick) => tick > minimumUsable && tick <= maximumUsable,
  );
  if (candidates.length === 0) {
    throw new Error(
      `target tick is outside the usable range (${minimumUsable}, ${maximumUsable}]`,
    );
  }
  return candidates.sort(
    (left, right) =>
      Math.abs(left - rawTick) - Math.abs(right - rawTick) ||
      left - right,
  );
}

function economics(logSupply, tick) {
  const tokensPerPipedog = Math.exp(LOG_TICK_BASE * tick);
  const impliedFdvPipedog = Math.exp(
    logSupply - LOG_TICK_BASE * tick,
  );
  return { tick, tokensPerPipedog, impliedFdvPipedog };
}

function significant(value) {
  return Number(value.toPrecision(15));
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const supplyRaw =
    args.supply ?? process.env.LAYPIPE_SUPPLY_TOKENS;
  const fdvRaw =
    args.fdv ?? process.env.LAYPIPE_TARGET_FDV_PIPEDOG;
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

  const supply = parsePositiveDecimal("supply", supplyRaw);
  const targetFdv = parsePositiveDecimal("fdv", fdvRaw);
  const tickSpacing = parseTickSpacing(spacingRaw);
  const supplyWei = BigInt(decimalToWei("supply", supplyRaw));
  if (supplyWei > MAX_SUPPLY_WEI) {
    throw new Error("supply exceeds the factory uint192 limit");
  }
  const logSupply = Math.log(supply);
  const rawTick =
    (logSupply - Math.log(targetFdv)) / LOG_TICK_BASE;
  if (!Number.isFinite(rawTick)) {
    throw new Error("inputs do not produce a finite tick");
  }

  const candidates = alignedCandidates(rawTick, tickSpacing);
  const selected = economics(logSupply, candidates[0]);
  const alternatives = candidates
    .slice(1)
    .map((tick) => economics(logSupply, tick));
  const legacyFdv = economics(
    Math.log(LEGACY_SUPPLY),
    LEGACY_TICK,
  ).impliedFdvPipedog;

  console.log(
    JSON.stringify(
      {
        model:
          "equal 18-decimal assets at the one-sided launch boundary",
        inputs: {
          supplyTokens: supplyRaw,
          targetFdvPipedog: fdvRaw,
          tickSpacing,
        },
        rawTick: significant(rawTick),
        selected: {
          startTick: selected.tick,
          tokensPerPipedog: significant(
            selected.tokensPerPipedog,
          ),
          impliedFdvPipedog: significant(
            selected.impliedFdvPipedog,
          ),
          targetErrorPercent: significant(
            ((selected.impliedFdvPipedog - targetFdv) /
              targetFdv) *
              100,
          ),
        },
        alternatives: alternatives.map((candidate) => ({
          startTick: candidate.tick,
          tokensPerPipedog: significant(
            candidate.tokensPerPipedog,
          ),
          impliedFdvPipedog: significant(
            candidate.impliedFdvPipedog,
          ),
        })),
        deploymentEnvironment: {
          LAYPIPE_SUPPLY_WEI: supplyWei.toString(),
          LAYPIPE_TICK_SPACING: String(tickSpacing),
          LAYPIPE_START_TICK: String(selected.tick),
        },
        warning:
          `Tick ${LEGACY_TICK} is an unsafe legacy example: ` +
          `with 1,000,000,000 tokens it implies approximately ` +
          `${legacyFdv.toFixed(9)} PIPEDOG FDV. Calibrate and review ` +
          "executable depth before deployment.",
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
