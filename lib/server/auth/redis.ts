import { createHash } from "node:crypto";
import { HttpError } from "./http";

interface RedisCredentials {
  url: string;
  token: string;
}

interface RedisCommandResponse {
  result: unknown;
  error?: unknown;
}

const REDIS_REQUEST_TIMEOUT_MS = 3_000;

function boundedRedisSignal(signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(REDIS_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function credentials(): RedisCredentials | null {
  const url =
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ??
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ??
    process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(
      503,
      "RATE_LIMIT_NOT_CONFIGURED",
      "Request protection is unavailable.",
    );
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.toLowerCase().endsWith(".upstash.io") ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new HttpError(
      503,
      "RATE_LIMIT_NOT_CONFIGURED",
      "Request protection is unavailable.",
    );
  }
  return { url: parsed.origin, token };
}

export async function redisCommand(
  command: Array<string | number>,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  const configured = credentials();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(
        503,
        "RATE_LIMIT_NOT_CONFIGURED",
        "Request protection is unavailable.",
      );
    }
    return undefined;
  }

  let response: Response;
  try {
    response = await fetcher(configured.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configured.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
      redirect: "error",
      signal: boundedRedisSignal(signal),
    });
  } catch {
    throw new HttpError(503, "RATE_LIMIT_UNAVAILABLE", "Request protection is unavailable.");
  }
  if (!response.ok) {
    throw new HttpError(503, "RATE_LIMIT_UNAVAILABLE", "Request protection is unavailable.");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(503, "RATE_LIMIT_UNAVAILABLE", "Request protection is unavailable.");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !("result" in payload) ||
    ("error" in payload && (payload as RedisCommandResponse).error != null)
  ) {
    throw new HttpError(503, "RATE_LIMIT_UNAVAILABLE", "Request protection is unavailable.");
  }
  return (payload as RedisCommandResponse).result;
}

function safeKey(namespace: string, identity: string) {
  const digest = createHash("sha256").update(identity).digest("hex");
  return `laypipe:${namespace}:${digest}`;
}

export async function enforceRateLimit(options: {
  namespace: string;
  identity: string;
  limit: number;
  windowSeconds: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const key = safeKey(options.namespace, options.identity);
  const result = await redisCommand(
    ["EVAL", RATE_LIMIT_SCRIPT, "1", key, options.limit, options.windowSeconds],
    options.fetcher,
    options.signal,
  );
  if (result === undefined) return;
  if (!Array.isArray(result) || result.length < 2) {
    throw new HttpError(503, "RATE_LIMIT_UNAVAILABLE", "Request protection is unavailable.");
  }
  if (Number(result[0]) !== 1) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }
}

export async function consumeNonce(options: {
  nonce: string;
  expiresAt: number;
  now?: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  idempotencyKey?: string;
}) {
  const now = Math.floor(options.now ?? Date.now() / 1000);
  const ttl = Math.max(1, options.expiresAt - now + 60);
  const key = safeKey("nonce", options.nonce);
  const value = options.idempotencyKey
    ? `idempotent:${createHash("sha256").update(options.idempotencyKey).digest("hex")}`
    : "1";
  const result = await redisCommand(
    ["SET", key, value, "NX", "EX", ttl],
    options.fetcher,
    options.signal,
  );
  if (result === undefined) return;
  if (result === "OK") return;
  if (options.idempotencyKey) {
    const existing = await redisCommand(["GET", key], options.fetcher, options.signal);
    if (existing === value) return;
  }
  throw new HttpError(409, "REPLAY", "This wallet authorization was already used.");
}

const RATE_LIMIT_SCRIPT = [
  "local current = redis.call('INCR', KEYS[1])",
  "if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end",
  "if current > tonumber(ARGV[1]) then return {0, current} end",
  "return {1, current}",
].join("\n");
