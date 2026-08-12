import { HttpError, jsonError } from "@/lib/server/auth/http";
import {
  parseAlchemyWebhookEnvelope,
  verifyAlchemyWebhookSignature,
} from "@/lib/server/indexer/auth";
import { runCanonicalIndexer } from "@/lib/server/indexer/ingestion";
import { acquireIndexerLease } from "@/lib/server/indexer/lease";
import { readBoundedWebhookBody } from "@/lib/server/indexer/webhook";
import {
  emitOperationalSummary,
  observeOperationalRequest,
} from "@/lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  try {
    if (
      !process.env.ALCHEMY_WEBHOOK_SIGNING_KEY ||
      process.env.ALCHEMY_WEBHOOK_SIGNING_KEY.length < 32
    ) {
      throw new HttpError(503, "WEBHOOK_NOT_CONFIGURED", "Indexer webhook is unavailable.");
    }
    const rawBody = await readBoundedWebhookBody(request);
    try {
      // Alchemy signs the exact raw UTF-8 bytes. Never parse and re-serialize
      // this body before checking X-Alchemy-Signature.
      verifyAlchemyWebhookSignature({
        rawBody: rawBody.bytes,
        signature: request.headers.get("x-alchemy-signature"),
      });
    } catch {
      throw new HttpError(401, "UNAUTHORIZED", "Webhook authorization failed.");
    }
    let envelope: ReturnType<typeof parseAlchemyWebhookEnvelope>;
    try {
      envelope = parseAlchemyWebhookEnvelope(rawBody.text);
    } catch {
      throw new HttpError(400, "INVALID_WEBHOOK", "Webhook envelope is invalid.");
    }
    const lease = await acquireIndexerLease();
    if (!lease.acquired) {
      emitOperationalSummary(
        "laypipe.indexer.completed",
        { runStatus: "busy", source: "webhook" },
        "warn",
      );
      return Response.json(
        { accepted: true, eventId: envelope.id, sync: { status: "busy" } },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      const result = await runCanonicalIndexer();
      const blockLag = result.nextBlock === null
        ? null
        : (BigInt(result.safeHead) - BigInt(result.nextBlock) + BigInt(1)).toString();
      emitOperationalSummary(
        "laypipe.indexer.completed",
        {
          runStatus: result.status,
          source: "webhook",
          safeHead: result.safeHead,
          nextBlock: result.nextBlock,
          blockLag,
          batches: result.batches,
          rolledBackBlocks: result.rolledBackBlocks,
        },
        result.status === "caught-up" ? "info" : "warn",
      );
      return Response.json(
        { accepted: true, eventId: envelope.id, sync: result },
        { headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      await lease.release();
    }
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  return observeOperationalRequest(request, "/api/indexer/webhook", () =>
    handle(request),
  );
}
