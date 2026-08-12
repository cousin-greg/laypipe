const TEN = BigInt(10);

export function parseUnits(value: string, decimals: number) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error("Invalid token decimals.");
  }

  const normalized = value.trim();
  if (!/^(?:\d+|\d*\.\d+)$/.test(normalized)) {
    throw new Error("Enter a non-negative decimal amount.");
  }

  const [whole = "0", fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Use no more than ${decimals} decimal places.`);
  }

  const scale = TEN ** BigInt(decimals);
  return BigInt(whole || "0") * scale + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatUnits(
  value: bigint,
  decimals: number,
  maximumFractionDigits = 6,
) {
  if (value < BigInt(0)) throw new Error("Token amount cannot be negative.");
  const scale = TEN ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, Math.max(0, maximumFractionDigits))
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function bigintToQuantity(value: bigint) {
  if (value < BigInt(0)) throw new Error("RPC quantities cannot be negative.");
  return `0x${value.toString(16)}` as const;
}
