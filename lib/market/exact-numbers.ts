import type { PipedogPriceRatio } from "./live";

const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_TEN = BigInt(10);
const UINT256_MAX = (BIGINT_ONE << BigInt(256)) - BIGINT_ONE;
const UINT256_DECIMAL = /^(0|[1-9][0-9]{0,77})$/;
const BOUNDED_UNSIGNED_DECIMAL = /^(0|[1-9][0-9]{0,155})$/;
const SIGNED_DERIVED_DECIMAL = /^-?(0|[1-9][0-9]{0,157})$/;
const PIPEDOG_DECIMALS = 18;

export type ExactPercentChange = {
  /** The signed numerator of the percentage value, after multiplying by 100. */
  percentNumerator: string;
  /** The positive denominator shared by the percentage value. */
  denominator: string;
};

function invalid(label: string) {
  return new Error(`${label} is invalid.`);
}

export function requireUint256Decimal(
  value: unknown,
  label: string,
  options: { positive?: boolean } = {},
) {
  if (typeof value !== "string" || !UINT256_DECIMAL.test(value)) {
    throw invalid(label);
  }

  const parsed = BigInt(value);
  if (parsed > UINT256_MAX || (options.positive && parsed === BIGINT_ZERO)) {
    throw invalid(label);
  }
  return value;
}

export function requireBoundedUnsignedDecimal(value: unknown, label: string) {
  if (typeof value !== "string" || !BOUNDED_UNSIGNED_DECIMAL.test(value)) {
    throw invalid(label);
  }
  return value;
}

export function requirePipedogPriceRatio(
  value: unknown,
  label = "Indexed PIPEDOG price ratio",
): PipedogPriceRatio {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(label);
  }

  const ratio = value as Record<string, unknown>;
  return {
    pipedogAmount: requireUint256Decimal(
      ratio.pipedogAmount,
      `${label} PIPEDOG amount`,
    ),
    tokenAmount: requireUint256Decimal(
      ratio.tokenAmount,
      `${label} token amount`,
      { positive: true },
    ),
  };
}

function parseExactPercentChange(value: ExactPercentChange) {
  if (
    typeof value.percentNumerator !== "string" ||
    !SIGNED_DERIVED_DECIMAL.test(value.percentNumerator) ||
    value.percentNumerator === "-0" ||
    typeof value.denominator !== "string" ||
    !/^[1-9][0-9]{0,154}$/.test(value.denominator)
  ) {
    throw invalid("Exact percentage change");
  }

  return {
    numerator: BigInt(value.percentNumerator),
    denominator: BigInt(value.denominator),
  };
}

export function exactPercentChange(
  lastValue: PipedogPriceRatio,
  baselineValue: PipedogPriceRatio,
): ExactPercentChange | null {
  const last = requirePipedogPriceRatio(lastValue, "Last indexed price ratio");
  const baseline = requirePipedogPriceRatio(
    baselineValue,
    "Baseline indexed price ratio",
  );
  const baselinePipedog = BigInt(baseline.pipedogAmount);
  if (baselinePipedog === BIGINT_ZERO) return null;

  const lastPipedog = BigInt(last.pipedogAmount);
  const lastToken = BigInt(last.tokenAmount);
  const baselineToken = BigInt(baseline.tokenAmount);
  const percentNumerator =
    (lastPipedog * baselineToken - baselinePipedog * lastToken) * BigInt(100);
  const denominator = baselinePipedog * lastToken;

  return {
    percentNumerator: percentNumerator.toString(),
    denominator: denominator.toString(),
  };
}

export function compareUint256Decimals(left: string, right: string) {
  const leftValue = BigInt(requireUint256Decimal(left, "Left indexed amount"));
  const rightValue = BigInt(requireUint256Decimal(right, "Right indexed amount"));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function compareBoundedUnsignedDecimals(left: string, right: string) {
  const leftValue = BigInt(requireBoundedUnsignedDecimal(left, "Left indexed amount"));
  const rightValue = BigInt(requireBoundedUnsignedDecimal(right, "Right indexed amount"));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function compareExactPercentChanges(
  left: ExactPercentChange,
  right: ExactPercentChange,
) {
  const leftValue = parseExactPercentChange(left);
  const rightValue = parseExactPercentChange(right);
  const leftScaled = leftValue.numerator * rightValue.denominator;
  const rightScaled = rightValue.numerator * leftValue.denominator;
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

export function exactPercentChangeDirection(value: ExactPercentChange) {
  const { numerator } = parseExactPercentChange(value);
  return numerator < BIGINT_ZERO ? -1 : numerator > BIGINT_ZERO ? 1 : 0;
}

function powerOfTen(exponent: number) {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 200) {
    throw new Error("Decimal formatting exponent is outside the supported range.");
  }
  return BIGINT_TEN ** BigInt(exponent);
}

function roundedDivide(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * BigInt(2) >= denominator ? quotient + BIGINT_ONE : quotient;
}

function decimalExponent(numerator: bigint, denominator: bigint) {
  let exponent =
    numerator.toString().length - denominator.toString().length;

  if (exponent >= 0) {
    if (numerator < denominator * powerOfTen(exponent)) exponent -= 1;
  } else if (numerator * powerOfTen(-exponent) < denominator) {
    exponent -= 1;
  }

  return exponent;
}

function formatUnsignedRatio(
  numerator: bigint,
  denominator: bigint,
  options: {
    significantDigits: number;
    scientificBelow: number;
    scientificAtOrAbove: number;
  },
) {
  if (numerator < BIGINT_ZERO || denominator <= BIGINT_ZERO) {
    throw new Error("Unsigned decimal ratio is invalid.");
  }
  if (numerator === BIGINT_ZERO) return "0";

  const { significantDigits, scientificBelow, scientificAtOrAbove } = options;
  if (
    !Number.isSafeInteger(significantDigits) ||
    significantDigits < 1 ||
    significantDigits > 12
  ) {
    throw new Error("Decimal precision is outside the supported range.");
  }

  let exponent = decimalExponent(numerator, denominator);
  const scaleExponent = significantDigits - 1 - exponent;
  let significand =
    scaleExponent >= 0
      ? roundedDivide(numerator * powerOfTen(scaleExponent), denominator)
      : roundedDivide(numerator, denominator * powerOfTen(-scaleExponent));
  const significandCeiling = powerOfTen(significantDigits);
  if (significand >= significandCeiling) {
    significand /= BIGINT_TEN;
    exponent += 1;
  }

  const digits = significand.toString().padStart(significantDigits, "0");
  if (exponent < scientificBelow || exponent >= scientificAtOrAbove) {
    const fractional = digits.slice(1).replace(/0+$/, "");
    return `${digits[0]}${fractional ? `.${fractional}` : ""}e${
      exponent >= 0 ? "+" : ""
    }${exponent}`;
  }

  const decimalPosition = exponent + 1;
  let rendered: string;
  if (decimalPosition <= 0) {
    rendered = `0.${"0".repeat(-decimalPosition)}${digits}`;
  } else if (decimalPosition >= digits.length) {
    rendered = `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  } else {
    rendered = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  }

  return rendered.includes(".")
    ? rendered.replace(/0+$/, "").replace(/\.$/, "")
    : rendered;
}

export function formatPipedogPriceRatio(value: PipedogPriceRatio) {
  const ratio = requirePipedogPriceRatio(value);
  return formatUnsignedRatio(
    BigInt(ratio.pipedogAmount),
    BigInt(ratio.tokenAmount),
    {
      significantDigits: 6,
      scientificBelow: -5,
      scientificAtOrAbove: 9,
    },
  );
}

export function formatPipedogBaseUnits(value: string) {
  const normalized = requireBoundedUnsignedDecimal(value, "Indexed PIPEDOG volume");
  const amount = BigInt(normalized);
  const tokenScale = powerOfTen(PIPEDOG_DECIMALS);
  const suffixes = [
    { exponent: 12, suffix: "T" },
    { exponent: 9, suffix: "B" },
    { exponent: 6, suffix: "M" },
    { exponent: 3, suffix: "K" },
  ] as const;

  for (const { exponent, suffix } of suffixes) {
    const denominator = tokenScale * powerOfTen(exponent);
    if (amount >= denominator && amount < tokenScale * powerOfTen(15)) {
      return `${formatUnsignedRatio(amount, denominator, {
        significantDigits: 4,
        scientificBelow: -20,
        scientificAtOrAbove: 4,
      })}${suffix}`;
    }
  }

  return formatUnsignedRatio(amount, tokenScale, {
    significantDigits: 4,
    scientificBelow: -5,
    scientificAtOrAbove: 15,
  });
}

export function formatExactPercentChange(value: ExactPercentChange) {
  const parsed = parseExactPercentChange(value);
  if (parsed.numerator === BIGINT_ZERO) return "0.0%";

  const negative = parsed.numerator < BIGINT_ZERO;
  const absoluteNumerator = negative ? -parsed.numerator : parsed.numerator;
  const exponent = decimalExponent(absoluteNumerator, parsed.denominator);
  if (exponent >= 6) {
    const rendered = formatUnsignedRatio(
      absoluteNumerator,
      parsed.denominator,
      {
        significantDigits: 4,
        scientificBelow: -20,
        scientificAtOrAbove: 6,
      },
    );
    return `${negative ? "-" : "+"}${rendered}%`;
  }

  const tenths = roundedDivide(absoluteNumerator * BIGINT_TEN, parsed.denominator);
  if (tenths === BIGINT_ZERO) return `${negative ? "-" : "+"}<0.1%`;
  return `${negative ? "-" : "+"}${tenths / BIGINT_TEN}.${tenths % BIGINT_TEN}%`;
}
