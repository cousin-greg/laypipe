import { ROBINHOOD_CHAIN_ID } from "@/lib/web3/chains";

export const WALLET_CHALLENGE_VERSION = 1;
export const WALLET_CHALLENGE_TTL_SECONDS = 5 * 60;

export type WalletAction = "stage" | "pin";

export interface WalletChallengePayload {
  v: number;
  wallet: string;
  action: WalletAction;
  digest: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export function buildChallengeMessage(payload: WalletChallengePayload) {
  return [
    "laypipe.fun wants you to authorize token artwork.",
    "",
    "This signature does not submit a transaction or approve tokens.",
    `Wallet: ${payload.wallet}`,
    `Chain ID: ${ROBINHOOD_CHAIN_ID}`,
    `Action: ${payload.action}`,
    `Content digest: ${payload.digest}`,
    `Nonce: ${payload.nonce}`,
    `Issued at: ${new Date(payload.issuedAt * 1000).toISOString()}`,
    `Expiration time: ${new Date(payload.expiresAt * 1000).toISOString()}`,
  ].join("\n");
}
