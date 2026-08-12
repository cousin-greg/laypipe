import type { BoardToken } from "../_data/adapter";
import {
  compareExactPercentChanges,
  compareUint256Decimals,
  exactPercentChangeDirection,
  formatExactPercentChange,
  formatPipedogBaseUnits,
  formatPipedogPriceRatio,
} from "@/lib/market/exact-numbers";
import { compactMoney, formatMoney } from "./format";

export function formatTokenPrice(token: BoardToken) {
  if (token.source === "fixture") return formatMoney(token.price);
  if (token.price === null) return "Unavailable";
  return `${formatPipedogPriceRatio(token.price)} PIPEDOG`;
}

export function formatTokenVolume(token: BoardToken) {
  if (token.source === "fixture") return compactMoney(token.volume24h);
  return `${formatPipedogBaseUnits(token.volume24h)} PIPEDOG`;
}

export function formatTokenChange(token: BoardToken) {
  if (token.change24h === null) return "Unavailable";
  if (token.source === "fixture") {
    return `${token.change24h >= 0 ? "+" : ""}${token.change24h.toFixed(1)}%`;
  }
  return formatExactPercentChange(token.change24h);
}

export function tokenChangeDirection(token: BoardToken) {
  if (token.change24h === null) return null;
  if (token.source === "fixture") {
    return token.change24h < 0 ? -1 : token.change24h > 0 ? 1 : 0;
  }
  return exactPercentChangeDirection(token.change24h);
}

export function compareTokenVolumes(left: BoardToken, right: BoardToken) {
  if (left.source === "live" && right.source === "live") {
    return compareUint256Decimals(left.volume24h, right.volume24h);
  }
  if (left.source === "fixture" && right.source === "fixture") {
    return left.volume24h - right.volume24h;
  }
  return left.source === "live" ? 1 : -1;
}

export function compareTokenChanges(left: BoardToken, right: BoardToken) {
  if (left.change24h === null) return right.change24h === null ? 0 : -1;
  if (right.change24h === null) return 1;
  if (left.source === "live" && right.source === "live") {
    return compareExactPercentChanges(left.change24h, right.change24h);
  }
  if (left.source === "fixture" && right.source === "fixture") {
    return left.change24h - right.change24h;
  }
  return left.source === "live" ? 1 : -1;
}
