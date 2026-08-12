import { MAX_ARTWORK_BYTES } from "@/lib/ipfs/artwork";
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
import {
  parseCid,
  pinAuthorizationDigest,
} from "@/lib/server/auth/request-digest";
import { sanitizeArtwork } from "@/lib/server/ipfs/image";
import { buildMetadataBytes, parseMetadataDraft } from "@/lib/server/ipfs/metadata";
import {
  deletePublicFile,
  fetchPublicCid,
  gatewayUrl,
  getStagedFile,
  requireIpfsPinningEnabled,
  uploadPublicFile,
} from "@/lib/server/ipfs/pinata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  let stagedFileId: string | undefined;
  let sanitizedFileId: string | undefined;
  let metadataFileId: string | undefined;
  try {
    sameOriginRequest(request);
    requireIpfsPinningEnabled();
    const ip = getRequestIp(request);
    await enforceRateLimit({
      namespace: "pin-ip",
      identity: ip,
      limit: 8,
      windowSeconds: 60 * 60,
    });
    const body = await readJsonObject(request, 24_576);
    const wallet = requireAddress(body.wallet);
    const stagedCid = parseCid(requireString(body.stagedCid, "Staged CID", 128));
    const requestedStagedFileId = requireString(
      body.stagedFileId,
      "Staged file ID",
      64,
    );
    const fileSha256 = requireString(body.fileSha256, "File digest", 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fileSha256)) {
      throw new HttpError(400, "INVALID_DIGEST", "File digest is invalid.");
    }
    const metadata = parseMetadataDraft(body.metadata);
    const digest = pinAuthorizationDigest({
      wallet,
      stagedCid,
      stagedFileId: requestedStagedFileId,
      fileSha256,
      metadata,
    });
    const challenge = requireString(body.challenge, "Challenge", 2048);
    const signature = requireString(body.signature, "Signature", 132);
    const authorization = await verifyWalletAuthorization({
      challenge,
      signature,
      wallet,
      action: "pin",
      contentDigest: digest,
    });
    await enforceRateLimit({
      namespace: "pin-wallet",
      identity: wallet,
      limit: 6,
      windowSeconds: 60 * 60,
    });
    await consumeNonce(authorization);

    const staged = await getStagedFile(requestedStagedFileId);
    if (
      staged.cid !== stagedCid ||
      staged.size > MAX_ARTWORK_BYTES ||
      staged.keyvalues?.laypipe_stage !== "true" ||
      staged.keyvalues?.wallet !== wallet.toLowerCase() ||
      staged.keyvalues?.file_sha256 !== fileSha256 ||
      !/^[0-9a-f]{64}$/.test(staged.keyvalues?.digest ?? "")
    ) {
      throw new HttpError(
        400,
        "STAGE_MISMATCH",
        "Staged artwork does not match this authorization.",
      );
    }
    stagedFileId = staged.id;
    const retrieved = await fetchPublicCid(stagedCid, { maxBytes: MAX_ARTWORK_BYTES });
    const sanitized = await sanitizeArtwork({
      bytes: retrieved.bytes,
      declaredMimeType: staged.mimeType || retrieved.contentType,
      expectedSha256: fileSha256,
    });
    const safeBaseName = metadata.symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const imagePin = await uploadPublicFile({
      bytes: sanitized.bytes,
      fileName: `${safeBaseName}-artwork.webp`,
      mimeType: sanitized.mimeType,
      keyvalues: {
        laypipe: "token-artwork",
        wallet: wallet.toLowerCase(),
        sha256: sanitized.sha256,
      },
    });
    sanitizedFileId = imagePin.id;
    const imageUri = `ipfs://${imagePin.cid}`;
    const metadataResult = buildMetadataBytes(metadata, imageUri);

    let metadataPin;
    try {
      metadataPin = await uploadPublicFile({
        bytes: metadataResult.bytes,
        fileName: `${safeBaseName}-metadata.json`,
        mimeType: "application/json",
        keyvalues: {
          laypipe: "token-metadata",
          wallet: wallet.toLowerCase(),
          image_cid: imagePin.cid,
        },
      });
      metadataFileId = metadataPin.id;
    } catch (error) {
      if (await deletePublicFile(imagePin.id)) {
        sanitizedFileId = undefined;
      }
      throw error;
    }

    if (!(await deletePublicFile(staged.id))) {
      console.warn("LayPipe temporary artwork cleanup failed", {
        error: "StageCleanupError",
      });
    }
    stagedFileId = undefined;
    const response = Response.json(
      {
        image: {
          cid: imagePin.cid,
          uri: imageUri,
          gatewayUrl: gatewayUrl(imagePin.cid),
        },
        metadata: {
          cid: metadataPin.cid,
          uri: `ipfs://${metadataPin.cid}`,
          gatewayUrl: gatewayUrl(metadataPin.cid),
        },
        metadataDocument: metadataResult.document,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
    sanitizedFileId = undefined;
    metadataFileId = undefined;
    return response;
  } catch (error) {
    if (metadataFileId) await deletePublicFile(metadataFileId);
    if (sanitizedFileId) await deletePublicFile(sanitizedFileId);
    if (stagedFileId) await deletePublicFile(stagedFileId);
    return jsonError(error);
  }
}
