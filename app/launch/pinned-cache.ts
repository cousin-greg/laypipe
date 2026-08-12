import type { PinnedLaunchAssets } from "../../lib/ipfs/pin-client";
import { assertAddress, type Address } from "../../lib/web3/types";

export interface WalletBoundPinnedCache {
  wallet: Address;
  fingerprint: string;
  assets: PinnedLaunchAssets;
}

function normalizeWallet(wallet: Address) {
  return assertAddress(wallet, "Pinned artwork wallet").toLowerCase() as Address;
}

export function createWalletBoundPinnedCache(options: {
  wallet: Address;
  fingerprint: string;
  assets: PinnedLaunchAssets;
}): WalletBoundPinnedCache {
  return {
    wallet: normalizeWallet(options.wallet),
    fingerprint: options.fingerprint,
    assets: options.assets,
  };
}

export function readWalletBoundPinnedAssets(
  cache: WalletBoundPinnedCache | null,
  wallet: Address,
  fingerprint: string,
) {
  if (
    !cache ||
    cache.wallet !== normalizeWallet(wallet) ||
    cache.fingerprint !== fingerprint
  ) {
    return null;
  }
  return cache.assets;
}

export function retainPinnedCacheForWallet(
  cache: WalletBoundPinnedCache | null,
  wallet: Address | null,
) {
  if (!cache || !wallet || cache.wallet !== normalizeWallet(wallet)) return null;
  return cache;
}
