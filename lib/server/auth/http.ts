import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAddress, type Address } from "@/lib/web3/types";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function jsonError(error: unknown) {
  const headers = { "Cache-Control": "no-store" };
  if (error instanceof HttpError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers },
    );
  }

  console.error("LayPipe API request failed", {
    error: error instanceof Error ? error.name : "UnknownError",
  });
  return Response.json(
    { error: "The request could not be completed.", code: "INTERNAL_ERROR" },
    { status: 500, headers },
  );
}

export async function readJsonObject(request: Request, maxBytes = 16_384) {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new HttpError(415, "CONTENT_TYPE", "Send an application/json request.");
  }

  const rawDeclaredLength = request.headers.get("content-length");
  const declaredLength = rawDeclaredLength === null ? 0 : Number(rawDeclaredLength);
  if (
    rawDeclaredLength !== null &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0)
  ) {
    throw new HttpError(400, "CONTENT_LENGTH", "The request length is invalid.");
  }
  if (declaredLength > maxBytes) {
    throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }

  const reader = request.body?.getReader();
  if (!reader) {
    throw new HttpError(400, "INVALID_JSON", "The request JSON is invalid.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "BODY_TOO_LARGE", "The request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON", "The request JSON is invalid.");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request JSON is invalid.");
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "The request JSON is invalid.");
  }
}

export function requireString(
  value: unknown,
  label: string,
  maxLength: number,
) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HttpError(400, "INVALID_FIELD", `${label} is invalid.`);
  }
  return value;
}

export function requireAddress(value: unknown, label = "Wallet"): Address {
  const candidate = requireString(value, label, 42);
  if (!isAddress(candidate)) {
    throw new HttpError(400, "INVALID_WALLET", `${label} is invalid.`);
  }
  return candidate;
}

export function getRequestIp(request: Request) {
  const vercelForwarded = request.headers
    .get("x-vercel-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const ip = vercelForwarded || forwarded || realIp;
  if (!ip || isIP(ip) === 0) {
    if (process.env.NODE_ENV === "production") {
      throw new HttpError(503, "MISSING_IP", "Request identity is unavailable.");
    }
    return "127.0.0.1";
  }
  return ip.slice(0, 128);
}

export function anonymousRateLimitKey(prefix: string, value: string) {
  return `${prefix}:${createHash("sha256").update(value).digest("hex")}`;
}

export function sameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let providedOrigin: string;
  let requestOrigin: string;
  try {
    providedOrigin = new URL(origin).origin;
    requestOrigin = new URL(request.url).origin;
  } catch {
    throw new HttpError(403, "ORIGIN", "Cross-origin requests are not allowed.");
  }

  const allowedOrigins = new Set([requestOrigin]);
  const canonical = process.env.NEXT_PUBLIC_SITE_URL;
  if (canonical) {
    try {
      allowedOrigins.add(new URL(canonical).origin);
    } catch {
      throw new HttpError(
        503,
        "SITE_URL",
        "The application origin is not configured correctly.",
      );
    }
  }
  if (!allowedOrigins.has(providedOrigin)) {
    throw new HttpError(403, "ORIGIN", "Cross-origin requests are not allowed.");
  }
}
