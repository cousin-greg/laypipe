import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/i;

function secret(value: string | undefined, label: string) {
  if (!value || value.length < 32) throw new Error(`${label} is not configured.`);
  return value;
}

export function authorizeIndexerCron(
  authorization: string | null,
  configuredSecret = process.env.CRON_SECRET,
) {
  const expected = secret(configuredSecret, "CRON_SECRET");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedHash = createHash("sha256").update(expected).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
    throw new Error("Indexer authorization failed.");
  }
}

export function verifyAlchemyWebhookSignature(options: {
  rawBody: string | Uint8Array;
  signature: string | null;
  signingKey?: string;
}) {
  const signingKey = secret(
    options.signingKey ?? process.env.ALCHEMY_WEBHOOK_SIGNING_KEY,
    "ALCHEMY_WEBHOOK_SIGNING_KEY",
  );
  if (!options.signature || !SIGNATURE_PATTERN.test(options.signature)) {
    throw new Error("Alchemy webhook signature is invalid.");
  }
  const expected = createHmac("sha256", signingKey)
    .update(options.rawBody)
    .digest();
  const provided = Buffer.from(options.signature, "hex");
  if (!timingSafeEqual(expected, provided)) {
    throw new Error("Alchemy webhook signature is invalid.");
  }
}

export function parseAlchemyWebhookEnvelope(rawBody: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error("Alchemy webhook body is invalid JSON.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Alchemy webhook body is invalid.");
  }
  const value = payload as Record<string, unknown>;
  for (const field of ["id", "webhookId", "type"] as const) {
    if (
      typeof value[field] !== "string" ||
      value[field].length < 1 ||
      value[field].length > 256
    ) {
      throw new Error(`Alchemy webhook ${field} is invalid.`);
    }
  }
  return {
    id: value.id as string,
    webhookId: value.webhookId as string,
    type: value.type as string,
  };
}
