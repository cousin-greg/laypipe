import { verifyWalletAuthorization } from "@/lib/server/auth/challenge";
import {
  getRequestIp,
  HttpError,
  jsonError,
  readJsonObject,
  requireAddress,
  requireString,
  sameOriginRequest,
} from "@/lib/server/auth/http";
import { consumeNonce, enforceRateLimit } from "@/lib/server/auth/redis";
import { stageAuthorizationDigest } from "@/lib/server/auth/request-digest";
import { ALLOWED_IMAGE_TYPES } from "@/lib/server/ipfs/image";
import {
  createPresignedStageUrl,
  requireIpfsPinningEnabled,
} from "@/lib/server/ipfs/pinata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    sameOriginRequest(request);
    requireIpfsPinningEnabled();
    const ip = getRequestIp(request);
    await enforceRateLimit({
      namespace: "stage-ip",
      identity: ip,
      limit: 12,
      windowSeconds: 60 * 60,
    });
    const body = await readJsonObject(request);
    const wallet = requireAddress(body.wallet);
    const fileName = requireString(body.fileName, "File name", 96);
    const mimeType = requireString(body.mimeType, "MIME type", 32);
    const fileSha256 = requireString(body.fileSha256, "File digest", 64).toLowerCase();
    const size = body.size;
    if (
      !Number.isInteger(size) ||
      (size as number) < 1 ||
      (size as number) > 5 * 1024 * 1024 ||
      !ALLOWED_IMAGE_TYPES.includes(mimeType as never) ||
      !/^[0-9a-f]{64}$/.test(fileSha256)
    ) {
      throw new HttpError(
        400,
        "INVALID_UPLOAD",
        "Artwork upload details are invalid.",
      );
    }
    const digest = stageAuthorizationDigest({
      wallet,
      fileName,
      mimeType,
      size: size as number,
      fileSha256,
    });
    const challenge = requireString(body.challenge, "Challenge", 2048);
    const signature = requireString(body.signature, "Signature", 132);
    const authorization = await verifyWalletAuthorization({
      challenge,
      signature,
      wallet,
      action: "stage",
      contentDigest: digest,
    });
    await enforceRateLimit({
      namespace: "stage-wallet",
      identity: wallet,
      limit: 10,
      windowSeconds: 60 * 60,
    });
    await consumeNonce(authorization);
    return Response.json(
      await createPresignedStageUrl({
        fileName,
        mimeType,
        wallet,
        digest,
        fileSha256,
      }),
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
