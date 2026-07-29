export function formatMoney(value: number, digits = 2) {
  if (value < 0.01) {
    return `$${value.toFixed(6)}`;
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
}

export function compactMoney(value: number) {
  return `$${new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)}`;
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatAge(hours: number) {
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
