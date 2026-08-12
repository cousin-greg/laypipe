import { HttpError, jsonError } from "@/lib/server/auth/http";
import { authorizeIndexerCron } from "@/lib/server/indexer/auth";
import { runCanonicalIndexer } from "@/lib/server/indexer/ingestion";
import { acquireIndexerLease } from "@/lib/server/indexer/lease";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorize(request: Request) {
  if (!process.env.CRON_SECRET || process.env.CRON_SECRET.length < 32) {
    throw new HttpError(503, "INDEXER_NOT_CONFIGURED", "Indexer sync is unavailable.");
  }
  try {
    authorizeIndexerCron(request.headers.get("authorization"));
  } catch {
    throw new HttpError(401, "UNAUTHORIZED", "Indexer authorization failed.");
  }
}

async function run(request: Request) {
  try {
    authorize(request);
    const lease = await acquireIndexerLease();
    if (!lease.acquired) {
      return Response.json(
        { status: "busy", accepted: true },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    }
    try {
      const result = await runCanonicalIndexer();
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } finally {
      await lease.release();
    }
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = run;
export const POST = run;
