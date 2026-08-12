import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError, jsonError } from "@/lib/server/auth/http";
import { sweepStaleStageFiles } from "@/lib/server/ipfs/pinata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorizeCleanup(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(
      503,
      "CLEANUP_NOT_CONFIGURED",
      "Artwork cleanup is unavailable.",
    );
  }
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const expectedHash = createHash("sha256").update(secret).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  if (!provided || !timingSafeEqual(expectedHash, providedHash)) {
    throw new HttpError(401, "UNAUTHORIZED", "Cleanup authorization failed.");
  }
}

async function run(request: Request) {
  try {
    authorizeCleanup(request);
    const result = await sweepStaleStageFiles();
    return Response.json(result, {
      status: result.failed > 0 ? 502 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export const GET = run;
export const POST = run;
