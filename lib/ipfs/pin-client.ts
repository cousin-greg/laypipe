import { CID } from "multiformats/cid";
import {
  artworkContentHash,
  normalizeArtworkForPublicStage,
  validateArtworkFile,
  type ValidatedArtwork,
} from "./artwork";
import {
  buildTokenMetadata,
  type LaunchMetadataDraft,
  type LaunchTokenMetadata,
} from "./metadata";
import {
  buildChallengeMessage,
  WALLET_CHALLENGE_TTL_SECONDS,
  WALLET_CHALLENGE_VERSION,
  type WalletAction,
  type WalletChallengePayload,
} from "./challenge-message";
import {
  isAddress,
  sameAddress,
  type Address,
  type Eip1193Provider,
  type Hex,
} from "@/lib/web3/types";

export const IPFS_CHALLENGE_ENDPOINT = "/api/auth/challenge";
export const IPFS_STAGE_ENDPOINT = "/api/ipfs/stage";
export const IPFS_PIN_ENDPOINT = "/api/ipfs/pin";

export interface PinnedIpfsObject {
  cid: string;
  uri: `ipfs://${string}`;
  gatewayUrl?: string;
}

export interface PinnedLaunchAssets {
  image: PinnedIpfsObject;
  metadata: PinnedIpfsObject;
  metadataDocument: LaunchTokenMetadata;
  artwork: ValidatedArtwork;
}

interface JsonErrorResponse {
  error?: unknown;
  code?: unknown;
}

interface ChallengeResponse extends JsonErrorResponse {
  challenge?: unknown;
  message?: unknown;
  expiresAt?: unknown;
}

interface StageResponse extends JsonErrorResponse {
  uploadUrl?: unknown;
  expiresAt?: unknown;
}

interface PinataStageResponse {
  data?: { id?: unknown; cid?: unknown };
  error?: unknown;
}

interface PinResponse extends JsonErrorResponse {
  image?: { cid?: unknown; uri?: unknown; gatewayUrl?: unknown };
  metadata?: { cid?: unknown; uri?: unknown; gatewayUrl?: unknown };
  metadataDocument?: unknown;
}

const CHALLENGE_TOKEN_PATTERN = /^([A-Za-z0-9_-]{1,1536})\.([A-Za-z0-9_-]{43})$/;
const CHALLENGE_PAYLOAD_KEYS = [
  "action",
  "digest",
  "expiresAt",
  "issuedAt",
  "nonce",
  "v",
  "wallet",
];
const API_REQUEST_TIMEOUT_MS = 12_000;
const STAGE_UPLOAD_TIMEOUT_MS = 30_000;
const PIN_REQUEST_TIMEOUT_MS = 50_000;
const PIN_RETRY_BUDGET_MS = 65_000;
const PIN_RETRY_DELAY_MS = 1_000;
const PIN_MAX_ATTEMPTS = 2;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new IpfsPinError("Upload authorization contains an unsupported value.");
  }
  return serialized;
}

async function canonicalDigest(value: unknown) {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function stageAuthorizationDigest(options: {
  wallet: Address;
  fileName: string;
  mimeType: string;
  size: number;
  fileSha256: string;
}) {
  return canonicalDigest({
    action: "stage",
    wallet: options.wallet.toLowerCase(),
    fileName: options.fileName,
    mimeType: options.mimeType,
    size: options.size,
    fileSha256: options.fileSha256.toLowerCase(),
  });
}

export async function pinAuthorizationDigest(options: {
  wallet: Address;
  stagedCid: string;
  stagedFileId: string;
  fileSha256: string;
  metadata: LaunchMetadataDraft;
}) {
  return canonicalDigest({
    action: "pin",
    wallet: options.wallet.toLowerCase(),
    stagedCid: parseCid(options.stagedCid, "Staged artwork"),
    stagedFileId: options.stagedFileId,
    fileSha256: options.fileSha256.toLowerCase(),
    metadata: options.metadata,
  });
}

export class IpfsPinError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "IpfsPinError";
    this.status = status;
    this.code = code;
  }
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function endpoint(path: string, browserOrigin: string) {
  let origin: URL;
  let url: URL;
  try {
    origin = new URL(browserOrigin);
    url = new URL(path, origin);
  } catch {
    throw new IpfsPinError("The artwork upload origin is invalid.");
  }
  if (url.origin !== origin.origin) {
    throw new IpfsPinError("The artwork upload endpoint must be same-origin.");
  }
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new IpfsPinError("The artwork upload endpoint must use HTTPS.");
  }
  return url.toString();
}

async function readPayload<T extends JsonErrorResponse>(response: Response) {
  try {
    return (await response.json()) as T;
  } catch {
    throw new IpfsPinError(
      "The artwork service returned an unreadable response.",
      response.status,
      "UNREADABLE_RESPONSE",
    );
  }
}

async function postJson<T extends JsonErrorResponse>(options: {
  path: string;
  body: unknown;
  browserOrigin: string;
  signal?: AbortSignal;
  fetcher: typeof fetch;
  timeoutMs?: number;
}) {
  let response: Response;
  try {
    response = await options.fetcher(endpoint(options.path, options.browserOrigin), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options.body),
      credentials: "same-origin",
      signal: boundedSignal(options.signal, options.timeoutMs ?? API_REQUEST_TIMEOUT_MS),
    });
  } catch {
    if (options.signal?.aborted) {
      throw new IpfsPinError("Artwork publishing was cancelled.", undefined, "CANCELLED");
    }
    throw new IpfsPinError(
      "The artwork service did not respond in time. Nothing was sent on-chain.",
      undefined,
      "NETWORK",
    );
  }
  const payload = await readPayload<T>(response);
  if (!response.ok) {
    throw new IpfsPinError(
      typeof payload.error === "string"
        ? payload.error
        : "Artwork pinning failed. Nothing was sent on-chain.",
      response.status,
      typeof payload.code === "string" ? payload.code : undefined,
    );
  }
  return { payload, status: response.status };
}

function decodeChallengePayload(challenge: string): WalletChallengePayload {
  const match = CHALLENGE_TOKEN_PATTERN.exec(challenge);
  if (!match) {
    throw new IpfsPinError("The artwork service returned an invalid challenge.");
  }
  const encoded = match[1] ?? "";
  try {
    const standard = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(`${standard}${"=".repeat((4 - (standard.length % 4)) % 4)}`);
    const canonical = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    if (canonical !== encoded) throw new Error("Non-canonical base64url");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected an object");
    }
    const keys = Object.keys(value).sort();
    if (
      keys.length !== CHALLENGE_PAYLOAD_KEYS.length ||
      keys.some((key, index) => key !== CHALLENGE_PAYLOAD_KEYS[index])
    ) {
      throw new Error("Unexpected challenge fields");
    }
    return value as WalletChallengePayload;
  } catch {
    throw new IpfsPinError("The artwork service returned an invalid challenge.");
  }
}

function validateChallengeResponse(options: {
  challenge: string;
  message: string;
  expiresAt: string;
  action: WalletAction;
  digest: string;
  wallet: Address;
}) {
  const challenge = decodeChallengePayload(options.challenge);
  const now = Math.floor(Date.now() / 1000);
  if (
    challenge.v !== WALLET_CHALLENGE_VERSION ||
    challenge.wallet !== options.wallet.toLowerCase() ||
    challenge.action !== options.action ||
    challenge.digest !== options.digest ||
    !/^[0-9a-f]{64}$/.test(challenge.digest) ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(challenge.nonce) ||
    !Number.isInteger(challenge.issuedAt) ||
    !Number.isInteger(challenge.expiresAt) ||
    challenge.expiresAt - challenge.issuedAt !== WALLET_CHALLENGE_TTL_SECONDS ||
    challenge.issuedAt > now + 30 ||
    challenge.expiresAt <= now ||
    options.expiresAt !== new Date(challenge.expiresAt * 1000).toISOString() ||
    options.message !== buildChallengeMessage(challenge)
  ) {
    throw new IpfsPinError("The artwork service returned an invalid challenge.");
  }
}

function parseCid(value: unknown, label: string) {
  if (typeof value !== "string") {
    throw new IpfsPinError(`${label} returned an invalid CID.`);
  }
  try {
    return CID.parse(value).toV1().toString();
  } catch {
    throw new IpfsPinError(`${label} returned an invalid CID.`);
  }
}

function parsePinnedObject(
  value: PinResponse["image"],
  label: string,
): PinnedIpfsObject {
  if (!value || typeof value.uri !== "string") {
    throw new IpfsPinError(`${label} pinning returned an incomplete response.`);
  }
  const cid = parseCid(value.cid, label);
  const uri = `ipfs://${cid}` as const;
  if (value.uri !== uri) {
    throw new IpfsPinError(`${label} CID and URI do not match.`);
  }

  let gatewayUrl: string | undefined;
  if (typeof value.gatewayUrl === "string") {
    let parsed: URL;
    try {
      parsed = new URL(value.gatewayUrl);
    } catch {
      throw new IpfsPinError(`${label} gateway URL is invalid.`);
    }
    const expectedPath = `/ipfs/${cid}`;
    const hostname = parsed.hostname.toLowerCase();
    const isPinataGateway =
      hostname === "gateway.pinata.cloud" || hostname.endsWith(".mypinata.cloud");
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      !isPinataGateway ||
      !(parsed.pathname === expectedPath || parsed.pathname.startsWith(`${expectedPath}/`))
    ) {
      throw new IpfsPinError(
        `${label} gateway URL must use the configured Pinata HTTPS CID path.`,
      );
    }
    gatewayUrl = parsed.toString();
  }

  return { cid, uri, ...(gatewayUrl ? { gatewayUrl } : {}) };
}

function utf8Hex(value: string): Hex {
  return `0x${Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export async function assertWalletAccount(
  provider: Eip1193Provider,
  expectedWallet: Address,
) {
  const accounts = await provider.request<unknown>({ method: "eth_accounts" });
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !isAddress(accounts[0]) ||
    !sameAddress(accounts[0], expectedWallet)
  ) {
    throw new IpfsPinError(
      "The connected wallet changed. Reconnect it before publishing artwork.",
    );
  }
}

async function signChallenge(options: {
  provider: Eip1193Provider;
  wallet: Address;
  message: string;
}) {
  await assertWalletAccount(options.provider, options.wallet);
  const signature = await options.provider.request<unknown>({
    method: "personal_sign",
    params: [utf8Hex(options.message), options.wallet],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new IpfsPinError("The wallet returned an invalid artwork signature.");
  }
  return signature;
}

async function requestChallenge(options: {
  action: WalletAction;
  digest: string;
  wallet: Address;
  browserOrigin: string;
  signal?: AbortSignal;
  fetcher: typeof fetch;
}) {
  const { payload } = await postJson<ChallengeResponse>({
    path: IPFS_CHALLENGE_ENDPOINT,
    body: {
      wallet: options.wallet,
      action: options.action,
      contentDigest: options.digest,
    },
    browserOrigin: options.browserOrigin,
    signal: options.signal,
    fetcher: options.fetcher,
  });
  if (
    typeof payload.challenge !== "string" ||
    payload.challenge.length === 0 ||
    payload.challenge.length > 2048 ||
    typeof payload.message !== "string" ||
    payload.message.length === 0 ||
    payload.message.length > 4096 ||
    typeof payload.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(payload.expiresAt)) ||
    Date.parse(payload.expiresAt) <= Date.now()
  ) {
    throw new IpfsPinError("The artwork service returned an invalid challenge.");
  }
  validateChallengeResponse({
    challenge: payload.challenge,
    message: payload.message,
    expiresAt: payload.expiresAt,
    action: options.action,
    digest: options.digest,
    wallet: options.wallet,
  });
  return {
    challenge: payload.challenge,
    message: payload.message,
  };
}

function parseUploadUrl(value: unknown) {
  if (typeof value !== "string") {
    throw new IpfsPinError("Artwork staging returned an invalid upload URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IpfsPinError("Artwork staging returned an invalid upload URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "uploads.pinata.cloud" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(url.pathname === "/v3/files" || url.pathname.startsWith("/v3/files/"))
  ) {
    throw new IpfsPinError("Artwork staging returned an invalid upload URL.");
  }
  return url.toString();
}

async function stageFile(options: {
  uploadUrl: string;
  artwork: ValidatedArtwork;
  signal?: AbortSignal;
  fetcher: typeof fetch;
}) {
  const body = new FormData();
  body.set("network", "public");
  body.set("file", options.artwork.file, options.artwork.safeName);
  let response: Response;
  try {
    response = await options.fetcher(options.uploadUrl, {
      method: "POST",
      headers: { Accept: "application/json" },
      body,
      redirect: "error",
      signal: boundedSignal(options.signal, STAGE_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    if (options.signal?.aborted) {
      throw new IpfsPinError("Artwork publishing was cancelled.", undefined, "CANCELLED");
    }
    throw new IpfsPinError(
      "Artwork staging timed out. Nothing was sent on-chain.",
      undefined,
      "NETWORK",
    );
  }
  const payload = await readPayload<PinataStageResponse>(response);
  if (!response.ok) {
    throw new IpfsPinError("Artwork staging failed. Nothing was sent on-chain.");
  }
  const id = payload.data?.id;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new IpfsPinError("Artwork staging returned an invalid file ID.");
  }
  return { id, cid: parseCid(payload.data?.cid, "Artwork staging") };
}

function creatorModeOnly(metadata: LaunchMetadataDraft) {
  const feeMode = metadata.attributes.find(
    (attribute) => attribute.trait_type === "fee_mode",
  )?.value;
  if (feeMode !== "creator") {
    throw new IpfsPinError(
      "Self-burn launches are not available in this release.",
      400,
      "SELF_BURN_DISABLED",
    );
  }
}

function retryablePinError(error: unknown) {
  if (!(error instanceof IpfsPinError) || error.code === "CANCELLED") return false;
  return (
    error.status === undefined ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504 ||
    (error.status === 409 &&
      (error.code === "PROMOTION_IN_PROGRESS" ||
        error.code === "PROMOTION_LEASE_LOST")) ||
    error.code === "UNREADABLE_RESPONSE"
  );
}

async function retryDelay(signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new IpfsPinError("Artwork publishing was cancelled.", undefined, "CANCELLED"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, PIN_RETRY_DELAY_MS);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new IpfsPinError("Artwork publishing was cancelled.", undefined, "CANCELLED"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postPinWithRetry(options: {
  body: unknown;
  browserOrigin: string;
  signal?: AbortSignal;
  fetcher: typeof fetch;
}) {
  const startedAt = Date.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < PIN_MAX_ATTEMPTS; attempt += 1) {
    const remaining = PIN_RETRY_BUDGET_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    try {
      return await postJson<PinResponse>({
        path: IPFS_PIN_ENDPOINT,
        body: options.body,
        browserOrigin: options.browserOrigin,
        signal: options.signal,
        fetcher: options.fetcher,
        timeoutMs: Math.min(PIN_REQUEST_TIMEOUT_MS, remaining),
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= PIN_MAX_ATTEMPTS || !retryablePinError(error)) throw error;
      await retryDelay(options.signal);
    }
  }
  throw (
    lastError ??
    new IpfsPinError(
      "Artwork publishing timed out. Retry the launch; nothing was sent on-chain.",
      undefined,
      "NETWORK",
    )
  );
}

export async function pinLaunchAssets(options: {
  file: File;
  metadata: LaunchMetadataDraft;
  wallet: Address;
  provider: Eip1193Provider;
  browserOrigin: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  normalizeArtwork?: (file: File) => Promise<ValidatedArtwork>;
}): Promise<PinnedLaunchAssets> {
  const fetcher = options.fetcher ?? fetch;
  creatorModeOnly(options.metadata);
  await validateArtworkFile(options.file);
  const artwork = await (options.normalizeArtwork ?? normalizeArtworkForPublicStage)(
    options.file,
  );
  await validateArtworkFile(artwork.file);
  const fileSha256 = await artworkContentHash(artwork.file);
  const stageDetails = {
    wallet: options.wallet,
    fileName: artwork.safeName,
    mimeType: artwork.mimeType,
    size: artwork.file.size,
    fileSha256,
  };
  const stageDigest = await stageAuthorizationDigest(stageDetails);
  const stageChallenge = await requestChallenge({
    action: "stage",
    digest: stageDigest,
    wallet: options.wallet,
    browserOrigin: options.browserOrigin,
    signal: options.signal,
    fetcher,
  });
  const stageSignature = await signChallenge({
    provider: options.provider,
    wallet: options.wallet,
    message: stageChallenge.message,
  });
  const { payload: stagePayload } = await postJson<StageResponse>({
    path: IPFS_STAGE_ENDPOINT,
    body: {
      ...stageDetails,
      challenge: stageChallenge.challenge,
      signature: stageSignature,
    },
    browserOrigin: options.browserOrigin,
    signal: options.signal,
    fetcher,
  });
  const uploadUrl = parseUploadUrl(stagePayload.uploadUrl);
  const staged = await stageFile({ uploadUrl, artwork, signal: options.signal, fetcher });

  const pinDigest = await pinAuthorizationDigest({
    wallet: options.wallet,
    stagedCid: staged.cid,
    stagedFileId: staged.id,
    fileSha256,
    metadata: options.metadata,
  });
  const pinChallenge = await requestChallenge({
    action: "pin",
    digest: pinDigest,
    wallet: options.wallet,
    browserOrigin: options.browserOrigin,
    signal: options.signal,
    fetcher,
  });
  const pinSignature = await signChallenge({
    provider: options.provider,
    wallet: options.wallet,
    message: pinChallenge.message,
  });
  await assertWalletAccount(options.provider, options.wallet);
  const { payload, status } = await postPinWithRetry({
    body: {
      wallet: options.wallet,
      stagedCid: staged.cid,
      stagedFileId: staged.id,
      fileSha256,
      metadata: options.metadata,
      challenge: pinChallenge.challenge,
      signature: pinSignature,
    },
    browserOrigin: options.browserOrigin,
    signal: options.signal,
    fetcher,
  });

  const image = parsePinnedObject(payload.image, "Artwork");
  const metadata = parsePinnedObject(payload.metadata, "Metadata");
  const metadataDocument = buildTokenMetadata(options.metadata, image.uri);
  if (
    !payload.metadataDocument ||
    canonicalJson(payload.metadataDocument) !== canonicalJson(metadataDocument)
  ) {
    throw new IpfsPinError(
      "Pinned metadata does not match the reviewed launch metadata.",
      status,
    );
  }
  return { image, metadata, metadataDocument, artwork };
}
