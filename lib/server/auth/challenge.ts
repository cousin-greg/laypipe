import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { ROBINHOOD_CHAIN_ID } from "@/lib/web3/robinhood";
import type { Address, Hex } from "@/lib/web3/types";
import { HttpError } from "./http";

const CHALLENGE_VERSION = 1;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TOKEN_PATTERN = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export type WalletAction = "stage" | "pin";

interface ChallengePayload {
  v: number;
  wallet: string;
  action: WalletAction;
  digest: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface IssuedChallenge {
  challenge: string;
  message: string;
  expiresAt: string;
}

function challengeSecret() {
  const secret = process.env.WALLET_CHALLENGE_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(
      503,
      "AUTH_NOT_CONFIGURED",
      "Wallet authorization is not configured.",
    );
  }
  return secret;
}

function base64UrlEncode(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function hmac(value: string) {
  return createHmac("sha256", challengeSecret()).update(value).digest();
}

function assertDigest(digest: string) {
  const normalized = digest.toLowerCase();
  if (!DIGEST_PATTERN.test(normalized)) {
    throw new HttpError(400, "INVALID_DIGEST", "Content digest is invalid.");
  }
  return normalized;
}

export function buildChallengeMessage(payload: ChallengePayload) {
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

export function issueWalletChallenge(options: {
  wallet: Address;
  action: WalletAction;
  contentDigest: string;
  now?: number;
}): IssuedChallenge {
  const issuedAt = Math.floor(options.now ?? Date.now() / 1000);
  const payload: ChallengePayload = {
    v: CHALLENGE_VERSION,
    wallet: options.wallet.toLowerCase(),
    action: options.action,
    digest: assertDigest(options.contentDigest),
    nonce: randomBytes(18).toString("base64url"),
    issuedAt,
    expiresAt: issuedAt + CHALLENGE_TTL_SECONDS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(hmac(encoded));
  return {
    challenge: `${encoded}.${signature}`,
    message: buildChallengeMessage(payload),
    expiresAt: new Date(payload.expiresAt * 1000).toISOString(),
  };
}

export function decodeWalletChallenge(challenge: string, now?: number) {
  const match = TOKEN_PATTERN.exec(challenge);
  if (!match) throw new HttpError(401, "INVALID_CHALLENGE", "Challenge is invalid.");
  const [, encoded = "", providedSignature = ""] = match;
  let provided: Buffer;
  let expected: Buffer;
  try {
    provided = Buffer.from(providedSignature, "base64url");
    expected = hmac(encoded);
  } catch {
    throw new HttpError(401, "INVALID_CHALLENGE", "Challenge is invalid.");
  }
  if (
    provided.toString("base64url") !== providedSignature ||
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new HttpError(401, "INVALID_CHALLENGE", "Challenge is invalid.");
  }

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded)) as ChallengePayload;
  } catch {
    throw new HttpError(401, "INVALID_CHALLENGE", "Challenge is invalid.");
  }
  const currentTime = Math.floor(now ?? Date.now() / 1000);
  if (
    payload.v !== CHALLENGE_VERSION ||
    !/^0x[0-9a-f]{40}$/.test(payload.wallet) ||
    !["stage", "pin"].includes(payload.action) ||
    !DIGEST_PATTERN.test(payload.digest) ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(payload.nonce) ||
    !Number.isInteger(payload.issuedAt) ||
    !Number.isInteger(payload.expiresAt) ||
    payload.expiresAt - payload.issuedAt !== CHALLENGE_TTL_SECONDS ||
    payload.issuedAt > currentTime + 30 ||
    payload.expiresAt < currentTime
  ) {
    throw new HttpError(401, "EXPIRED_CHALLENGE", "Challenge is invalid or expired.");
  }
  return payload;
}

export async function verifyWalletAuthorization(options: {
  challenge: string;
  signature: string;
  wallet: Address;
  action: WalletAction;
  contentDigest: string;
  now?: number;
}) {
  const payload = decodeWalletChallenge(options.challenge, options.now);
  if (
    payload.wallet !== options.wallet.toLowerCase() ||
    payload.action !== options.action ||
    payload.digest !== assertDigest(options.contentDigest)
  ) {
    throw new HttpError(401, "CHALLENGE_MISMATCH", "Challenge does not match this request.");
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(options.signature)) {
    throw new HttpError(401, "INVALID_SIGNATURE", "Wallet signature is invalid.");
  }
  const valid = await verifyMessage({
    address: options.wallet,
    message: buildChallengeMessage(payload),
    signature: options.signature as Hex,
  });
  if (!valid) {
    throw new HttpError(401, "INVALID_SIGNATURE", "Wallet signature is invalid.");
  }
  return payload;
}
