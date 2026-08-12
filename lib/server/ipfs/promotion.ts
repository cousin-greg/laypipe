import { createHash, randomUUID } from "node:crypto";
import { HttpError } from "@/lib/server/auth/http";
import { redisCommand } from "@/lib/server/auth/redis";
import { parseCid } from "@/lib/server/auth/request-digest";

const PROMOTION_LEASE_SECONDS = 50;
const PROMOTION_STATE_TTL_SECONDS = 90 * 24 * 60 * 60;
const PROMOTION_STATE_VERSION = 1;
const MAX_PROMOTION_STATE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024;
const FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface PromotionIdentity {
  promotionId: string;
  stageFileId: string;
  pinDigest: string;
}

export interface PromotionPin {
  id: string;
  cid: string;
  size: number;
  mimeType: string;
}

export interface PromotionState extends PromotionIdentity {
  v: typeof PROMOTION_STATE_VERSION;
  status: "pending" | "image-pinned" | "metadata-pinned" | "completed";
  updatedAt: number;
  image?: PromotionPin;
  metadata?: PromotionPin;
  responseJson?: string;
}

export interface PromotionLease extends PromotionIdentity {
  token: string;
  persisted: boolean;
}

export type PromotionLeaseResult =
  | { kind: "completed"; state: PromotionState }
  | { kind: "acquired"; state: PromotionState; lease: PromotionLease };

function promotionKey(namespace: string, identity: string) {
  const digest = createHash("sha256").update(identity).digest("hex");
  return `laypipe:${namespace}:${digest}`;
}

function keys(identity: PromotionIdentity) {
  const exact = `${identity.stageFileId}:${identity.pinDigest}`;
  return {
    state: promotionKey("ipfs-promotion", exact),
    lease: promotionKey("ipfs-promotion-lease", exact),
    stageBinding: promotionKey("ipfs-stage-binding", identity.stageFileId),
  };
}

function invalidState(): never {
  throw new HttpError(
    503,
    "PROMOTION_STATE_INVALID",
    "Artwork publishing state is unavailable.",
  );
}

function parsePin(value: unknown): PromotionPin {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidState();
  const pin = value as Record<string, unknown>;
  if (
    typeof pin.id !== "string" ||
    !FILE_ID_PATTERN.test(pin.id) ||
    typeof pin.cid !== "string" ||
    typeof pin.size !== "number" ||
    !Number.isSafeInteger(pin.size) ||
    pin.size < 0 ||
    typeof pin.mimeType !== "string" ||
    pin.mimeType.length === 0 ||
    pin.mimeType.length > 128
  ) {
    invalidState();
  }
  return {
    id: pin.id,
    cid: parseCid(pin.cid),
    size: pin.size,
    mimeType: pin.mimeType,
  };
}

function validateResponseJson(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RESPONSE_BYTES) {
    invalidState();
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidState();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalidState();
  }
  return value;
}

function parseState(raw: unknown, identity: PromotionIdentity): PromotionState {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PROMOTION_STATE_BYTES) {
    invalidState();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalidState();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidState();
  const state = value as Record<string, unknown>;
  const status = state.status;
  if (
    state.v !== PROMOTION_STATE_VERSION ||
    state.promotionId !== identity.promotionId ||
    state.stageFileId !== identity.stageFileId ||
    state.pinDigest !== identity.pinDigest ||
    !["pending", "image-pinned", "metadata-pinned", "completed"].includes(
      String(status),
    ) ||
    typeof state.updatedAt !== "number" ||
    !Number.isSafeInteger(state.updatedAt) ||
    state.updatedAt < 0
  ) {
    invalidState();
  }

  const image = state.image === undefined ? undefined : parsePin(state.image);
  const metadata = state.metadata === undefined ? undefined : parsePin(state.metadata);
  const responseJson =
    state.responseJson === undefined ? undefined : validateResponseJson(state.responseJson);
  if (
    (status !== "pending" && !image) ||
    ((status === "metadata-pinned" || status === "completed") && !metadata) ||
    (status === "completed" && !responseJson) ||
    (status !== "completed" && responseJson !== undefined)
  ) {
    invalidState();
  }
  return {
    v: PROMOTION_STATE_VERSION,
    promotionId: identity.promotionId,
    stageFileId: identity.stageFileId,
    pinDigest: identity.pinDigest,
    status: status as PromotionState["status"],
    updatedAt: state.updatedAt as number,
    ...(image ? { image } : {}),
    ...(metadata ? { metadata } : {}),
    ...(responseJson ? { responseJson } : {}),
  };
}

function serializeState(state: PromotionState) {
  const serialized = JSON.stringify(state);
  if (serialized.length > MAX_PROMOTION_STATE_BYTES) invalidState();
  return serialized;
}

function initialState(identity: PromotionIdentity): PromotionState {
  return {
    v: PROMOTION_STATE_VERSION,
    ...identity,
    status: "pending",
    updatedAt: Date.now(),
  };
}

function assertStateIdentity(state: PromotionState, identity: PromotionIdentity) {
  if (
    state.promotionId !== identity.promotionId ||
    state.stageFileId !== identity.stageFileId ||
    state.pinDigest !== identity.pinDigest
  ) {
    invalidState();
  }
}

export function createPromotionIdentity(options: {
  stageFileId: string;
  pinDigest: string;
}): PromotionIdentity {
  const stageFileId = options.stageFileId.toLowerCase();
  const pinDigest = options.pinDigest.toLowerCase();
  if (!FILE_ID_PATTERN.test(stageFileId) || !DIGEST_PATTERN.test(pinDigest)) {
    throw new HttpError(400, "INVALID_PROMOTION", "Artwork promotion is invalid.");
  }
  return {
    stageFileId,
    pinDigest,
    promotionId: createHash("sha256")
      .update(`laypipe-ipfs-promotion-v1:${stageFileId}:${pinDigest}`)
      .digest("hex"),
  };
}

export async function getPromotionState(
  identity: PromotionIdentity,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
) {
  const raw = await redisCommand(
    ["GET", keys(identity).state],
    options?.fetcher,
    options?.signal,
  );
  if (raw === undefined || raw === null) return undefined;
  return parseState(raw, identity);
}

export async function acquirePromotionLease(
  identity: PromotionIdentity,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
): Promise<PromotionLeaseResult> {
  const fetcher = options?.fetcher;
  const signal = options?.signal;
  const key = keys(identity);
  const bindingResult = await redisCommand(
    [
      "SET",
      key.stageBinding,
      identity.pinDigest,
      "NX",
      "EX",
      PROMOTION_STATE_TTL_SECONDS,
    ],
    fetcher,
    signal,
  );
  if (bindingResult === undefined) {
    return {
      kind: "acquired",
      state: initialState(identity),
      lease: { ...identity, token: randomUUID(), persisted: false },
    };
  }
  if (bindingResult !== "OK") {
    const existingBinding = await redisCommand(["GET", key.stageBinding], fetcher, signal);
    if (existingBinding !== identity.pinDigest) {
      throw new HttpError(
        409,
        "STAGE_BOUND_TO_DIFFERENT_PROMOTION",
        "This staged artwork is already bound to different launch metadata.",
      );
    }
  }

  const pending = initialState(identity);
  const stateSet = await redisCommand(
    [
      "SET",
      key.state,
      serializeState(pending),
      "NX",
      "EX",
      PROMOTION_STATE_TTL_SECONDS,
    ],
    fetcher,
    signal,
  );
  if (stateSet !== "OK" && stateSet !== null) invalidState();
  let state = await getPromotionState(identity, { fetcher, signal });
  if (!state) invalidState();
  if (state.status === "completed") return { kind: "completed", state };

  const lease: PromotionLease = {
    ...identity,
    token: randomUUID(),
    persisted: true,
  };
  const leaseResult = await redisCommand(
    ["SET", key.lease, lease.token, "NX", "EX", PROMOTION_LEASE_SECONDS],
    fetcher,
    signal,
  );
  if (leaseResult !== "OK") {
    state = (await getPromotionState(identity, { fetcher, signal })) ?? state;
    if (state.status === "completed") return { kind: "completed", state };
    throw new HttpError(
      409,
      "PROMOTION_IN_PROGRESS",
      "Artwork publishing is already in progress. Retry shortly.",
    );
  }

  state = (await getPromotionState(identity, { fetcher, signal })) ?? state;
  if (state.status === "completed") {
    await releasePromotionLease(lease, { fetcher, signal });
    return { kind: "completed", state };
  }
  return { kind: "acquired", state, lease };
}

export function imagePinnedState(
  state: PromotionState,
  image: PromotionPin,
): PromotionState {
  if (state.status !== "pending" || state.image || state.metadata) invalidState();
  return {
    v: PROMOTION_STATE_VERSION,
    promotionId: state.promotionId,
    stageFileId: state.stageFileId,
    pinDigest: state.pinDigest,
    status: "image-pinned",
    updatedAt: Date.now(),
    image: parsePin(image),
  };
}

export function metadataPinnedState(
  state: PromotionState,
  metadata: PromotionPin,
): PromotionState {
  if (state.status !== "image-pinned" || !state.image || state.metadata) invalidState();
  return {
    v: PROMOTION_STATE_VERSION,
    promotionId: state.promotionId,
    stageFileId: state.stageFileId,
    pinDigest: state.pinDigest,
    status: "metadata-pinned",
    updatedAt: Date.now(),
    image: state.image,
    metadata: parsePin(metadata),
  };
}

export function completedState(state: PromotionState, responseJson: string): PromotionState {
  if (state.status !== "metadata-pinned" || !state.image || !state.metadata) invalidState();
  return {
    v: PROMOTION_STATE_VERSION,
    promotionId: state.promotionId,
    stageFileId: state.stageFileId,
    pinDigest: state.pinDigest,
    status: "completed",
    updatedAt: Date.now(),
    image: state.image,
    metadata: state.metadata,
    responseJson: validateResponseJson(responseJson),
  };
}

export async function savePromotionState(
  lease: PromotionLease,
  state: PromotionState,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
) {
  assertStateIdentity(state, lease);
  if (!lease.persisted) return;
  const key = keys(lease);
  const result = await redisCommand(
    [
      "EVAL",
      SAVE_STATE_SCRIPT,
      "3",
      key.lease,
      key.state,
      key.stageBinding,
      lease.token,
      lease.pinDigest,
      serializeState(state),
    ],
    options?.fetcher,
    options?.signal,
  );
  if (Number(result) !== 1) {
    throw new HttpError(
      409,
      "PROMOTION_LEASE_LOST",
      "Artwork publishing must be retried.",
    );
  }
}

export async function completePromotion(
  lease: PromotionLease,
  state: PromotionState,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
) {
  assertStateIdentity(state, lease);
  if (!lease.persisted) return;
  const key = keys(lease);
  const result = await redisCommand(
    [
      "EVAL",
      COMPLETE_STATE_SCRIPT,
      "3",
      key.lease,
      key.state,
      key.stageBinding,
      lease.token,
      lease.pinDigest,
      serializeState(state),
    ],
    options?.fetcher,
    options?.signal,
  );
  if (Number(result) !== 1) {
    throw new HttpError(
      409,
      "PROMOTION_LEASE_LOST",
      "Artwork publishing must be retried.",
    );
  }
}

export async function releasePromotionLease(
  lease: PromotionLease,
  options?: { fetcher?: typeof fetch; signal?: AbortSignal },
) {
  if (!lease.persisted) return true;
  const result = await redisCommand(
    ["EVAL", RELEASE_LEASE_SCRIPT, "1", keys(lease).lease, lease.token],
    options?.fetcher,
    options?.signal,
  );
  return Number(result) === 1;
}

const SAVE_STATE_SCRIPT = [
  "-- laypipe:ipfs-promotion:save",
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "if redis.call('GET', KEYS[3]) ~= ARGV[2] then return -1 end",
  `redis.call('SET', KEYS[2], ARGV[3], 'EX', '${PROMOTION_STATE_TTL_SECONDS}')`,
  "return 1",
].join("\n");

const COMPLETE_STATE_SCRIPT = [
  "-- laypipe:ipfs-promotion:complete",
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "if redis.call('GET', KEYS[3]) ~= ARGV[2] then return -1 end",
  `redis.call('SET', KEYS[2], ARGV[3], 'EX', '${PROMOTION_STATE_TTL_SECONDS}')`,
  "redis.call('DEL', KEYS[1])",
  "return 1",
].join("\n");

const RELEASE_LEASE_SCRIPT = [
  "-- laypipe:ipfs-promotion:release",
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('DEL', KEYS[1])",
  "return 1",
].join("\n");
