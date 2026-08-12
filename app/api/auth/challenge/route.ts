import { issueWalletChallenge, type WalletAction } from "@/lib/server/auth/challenge";
import {
  getRequestIp,
  HttpError,
  jsonError,
  readJsonObject,
  requireAddress,
  requireString,
  sameOriginBrowserRequest,
} from "@/lib/server/auth/http";
import { enforceRateLimit } from "@/lib/server/auth/redis";
import { requireIpfsPinningEnabled } from "@/lib/server/ipfs/pinata";
import { observeOperationalRequest } from "@/lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleChallengeRequest(request: Request) {
  try {
    sameOriginBrowserRequest(request);
    requireIpfsPinningEnabled();
    const body = await readJsonObject(request);
    const wallet = requireAddress(body.wallet);
    const contentDigest = requireString(body.contentDigest, "Content digest", 64);
    const action = body.action;
    if (action !== "stage" && action !== "pin") {
      throw new HttpError(400, "INVALID_ACTION", "Action is invalid.");
    }
    const ip = getRequestIp(request);
    await Promise.all([
      enforceRateLimit({
        namespace: "challenge-ip",
        identity: ip,
        limit: 30,
        windowSeconds: 60 * 60,
      }),
      enforceRateLimit({
        namespace: "challenge-ip-wallet",
        identity: `${ip}\n${wallet.toLowerCase()}`,
        limit: 20,
        windowSeconds: 60 * 60,
      }),
    ]);
    return Response.json(
      issueWalletChallenge({
        wallet,
        action: action as WalletAction,
        contentDigest,
      }),
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  return observeOperationalRequest(request, "/api/auth/challenge", () =>
    handleChallengeRequest(request),
  );
}
