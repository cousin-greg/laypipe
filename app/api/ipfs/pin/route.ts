import { MAX_ARTWORK_BYTES, sanitizeArtworkName } from "@/lib/ipfs/artwork";
import type { LaunchMetadataDraft } from "@/lib/ipfs/metadata";
import { verifyWalletAuthorization } from "@/lib/server/auth/challenge";
import {
  getRequestIp,
  HttpError,
  jsonError,
  readJsonObject,
  requireAddress,
  requireString,
  sameOriginBrowserRequest,
} from "@/lib/server/auth/http";
import { consumeNonce, enforceRateLimit } from "@/lib/server/auth/redis";
import {
  parseCid,
  pinAuthorizationDigest,
  stageAuthorizationDigest,
} from "@/lib/server/auth/request-digest";
import { ALLOWED_IMAGE_TYPES, sanitizeArtwork } from "@/lib/server/ipfs/image";
import { buildMetadataBytes, parseMetadataDraft } from "@/lib/server/ipfs/metadata";
import {
  deletePublicFile,
  fetchPublicCid,
  gatewayUrl,
  getStagedFile,
  requireIpfsPinningEnabled,
  uploadPublicFile,
  type PinataFile,
} from "@/lib/server/ipfs/pinata";
import {
  acquirePromotionLease,
  completedState,
  completePromotion,
  createPromotionIdentity,
  getPromotionState,
  imagePinnedState,
  metadataPinnedState,
  releasePromotionLease,
  savePromotionState,
  type PromotionLease,
  type PromotionPin,
  type PromotionState,
} from "@/lib/server/ipfs/promotion";
import {
  assertPromotionRegistryReady,
  recordCompletedPromotion,
  requirePromotionRegistryDatabase,
} from "@/lib/server/ipfs/registry";
import type { DbTransactionQuery } from "@/lib/server/db/neon";
import type { Address } from "@/lib/web3/types";
import { observeOperationalRequest } from "@/lib/server/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const IPFS_PIN_UPSTREAM_DEADLINE_MS = 45_000;

function assertUploadResult(
  file: { size: number; mimeType: string },
  expected: { size: number; mimeType: string },
) {
  if (file.size !== expected.size || file.mimeType !== expected.mimeType) {
    throw new HttpError(
      502,
      "IPFS_UPLOAD_MISMATCH",
      "Artwork storage did not confirm the uploaded bytes.",
    );
  }
}

function requireCreatorMode(metadata: LaunchMetadataDraft) {
  const feeMode = metadata.attributes.find(
    (attribute) => attribute.trait_type === "fee_mode",
  )?.value;
  if (feeMode !== "creator") {
    throw new HttpError(
      400,
      "SELF_BURN_DISABLED",
      "Self-burn launches are not available in this release.",
    );
  }
}

function exactSuccess(responseJson: string) {
  return new Response(responseJson, {
    status: 201,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function registerCompletedPromotion(options: {
  database: DbTransactionQuery;
  state: PromotionState;
  wallet: Address;
  fileSha256: string;
}) {
  if (
    options.state.status !== "completed" ||
    !options.state.image ||
    !options.state.metadata
  ) {
    throw new HttpError(
      503,
      "PROMOTION_STATE_INVALID",
      "Artwork publishing state is unavailable.",
    );
  }
  await recordCompletedPromotion(options.database, {
    promotionId: options.state.promotionId,
    stageFileId: options.state.stageFileId,
    pinDigest: options.state.pinDigest,
    wallet: options.wallet,
    fileSha256: options.fileSha256,
    image: options.state.image,
    metadata: options.state.metadata,
    completedAt: options.state.updatedAt,
  });
}

function promotionPin(file: {
  id: string;
  cid: string;
  size: number;
  mimeType: string;
}): PromotionPin {
  return {
    id: file.id,
    cid: file.cid,
    size: file.size,
    mimeType: file.mimeType,
  };
}

function requireDeadline(signal: AbortSignal) {
  if (signal.aborted) {
    throw new HttpError(
      503,
      "IPFS_DEADLINE",
      "Artwork publishing took too long. Retry the same request.",
    );
  }
}

async function loadValidatedStage(options: {
  wallet: Address;
  stagedCid: string;
  stagedFileId: string;
  fileSha256: string;
  signal: AbortSignal;
}): Promise<PinataFile> {
  const staged = await getStagedFile(options.stagedFileId, fetch, options.signal);
  const expectedStageDigest =
    staged.name &&
    stageAuthorizationDigest({
      wallet: options.wallet,
      fileName: staged.name,
      mimeType: staged.mimeType,
      size: staged.size,
      fileSha256: options.fileSha256,
    });
  if (
    staged.cid !== options.stagedCid ||
    staged.size < 1 ||
    staged.size > MAX_ARTWORK_BYTES ||
    !staged.name ||
    sanitizeArtworkName(staged.name) !== staged.name ||
    !ALLOWED_IMAGE_TYPES.includes(staged.mimeType as never) ||
    staged.keyvalues?.laypipe_stage !== "true" ||
    staged.keyvalues?.wallet !== options.wallet.toLowerCase() ||
    staged.keyvalues?.file_sha256 !== options.fileSha256 ||
    staged.keyvalues?.digest !== expectedStageDigest
  ) {
    throw new HttpError(
      400,
      "STAGE_MISMATCH",
      "Staged artwork does not match this authorization.",
    );
  }
  return staged;
}

async function handlePinRequest(request: Request) {
  const upstreamSignal = AbortSignal.timeout(IPFS_PIN_UPSTREAM_DEADLINE_MS);
  let lease: PromotionLease | undefined;
  let promotionDatabase: DbTransactionQuery | undefined;
  const promotionRegistry = async () => {
    promotionDatabase ??= await requirePromotionRegistryDatabase();
    return promotionDatabase;
  };
  try {
    sameOriginBrowserRequest(request);
    requireIpfsPinningEnabled();
    const ip = getRequestIp(request);
    await enforceRateLimit({
      namespace: "pin-ip",
      identity: ip,
      limit: 8,
      windowSeconds: 60 * 60,
      signal: upstreamSignal,
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
    requireCreatorMode(metadata);
    const digest = pinAuthorizationDigest({
      wallet,
      stagedCid,
      stagedFileId: requestedStagedFileId,
      fileSha256,
      metadata,
    });
    const promotion = createPromotionIdentity({
      stageFileId: requestedStagedFileId,
      pinDigest: digest,
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
      signal: upstreamSignal,
    });
    await consumeNonce({
      ...authorization,
      idempotencyKey: promotion.promotionId,
      signal: upstreamSignal,
    });

    const cached = await getPromotionState(promotion, { signal: upstreamSignal });
    if (cached?.status === "completed") {
      await registerCompletedPromotion({
        database: await promotionRegistry(),
        state: cached,
        wallet,
        fileSha256,
      });
      return exactSuccess(cached.responseJson!);
    }

    let staged: PinataFile | undefined;
    if (!cached || cached.status === "pending") {
      staged = await loadValidatedStage({
        wallet,
        stagedCid,
        stagedFileId: requestedStagedFileId,
        fileSha256,
        signal: upstreamSignal,
      });
    }

    const acquired = await acquirePromotionLease(promotion, { signal: upstreamSignal });
    if (acquired.kind === "completed") {
      await registerCompletedPromotion({
        database: await promotionRegistry(),
        state: acquired.state,
        wallet,
        fileSha256,
      });
      return exactSuccess(acquired.state.responseJson!);
    }
    lease = acquired.lease;
    let state = acquired.state;
    if (state.status === "pending" && !staged) {
      staged = await loadValidatedStage({
        wallet,
        stagedCid,
        stagedFileId: requestedStagedFileId,
        fileSha256,
        signal: upstreamSignal,
      });
    }
    await assertPromotionRegistryReady(await promotionRegistry());
    const safeBaseName = metadata.symbol.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    let imagePin = state.image;
    if (!imagePin) {
      if (!staged) {
        throw new HttpError(
          409,
          "PROMOTION_STATE_INVALID",
          "The saved promotion cannot resume without its staged artwork.",
        );
      }
      const retrieved = await fetchPublicCid(stagedCid, {
        maxBytes: MAX_ARTWORK_BYTES,
        signal: upstreamSignal,
      });
      const sanitized = await sanitizeArtwork({
        bytes: retrieved.bytes,
        declaredMimeType: staged.mimeType || retrieved.contentType,
        expectedSha256: fileSha256,
      });
      requireDeadline(upstreamSignal);
      const uploaded = await uploadPublicFile({
        bytes: sanitized.bytes,
        fileName: `${safeBaseName}-artwork.webp`,
        mimeType: sanitized.mimeType,
        keyvalues: {
          laypipe: "token-artwork",
          wallet: wallet.toLowerCase(),
          sha256: sanitized.sha256,
          laypipe_promotion: promotion.promotionId,
          laypipe_promotion_part: "image",
          laypipe_pin_digest: promotion.pinDigest,
          laypipe_stage_file: promotion.stageFileId,
        },
        signal: upstreamSignal,
      });
      assertUploadResult(uploaded, {
        size: sanitized.bytes.byteLength,
        mimeType: sanitized.mimeType,
      });
      imagePin = promotionPin(uploaded);
      state = imagePinnedState(state, imagePin);
      await savePromotionState(lease, state, { signal: upstreamSignal });
    }

    const imageUri = `ipfs://${imagePin.cid}`;
    const metadataResult = buildMetadataBytes(metadata, imageUri);
    let metadataPin = state.metadata;
    if (!metadataPin) {
      const uploaded = await uploadPublicFile({
        bytes: metadataResult.bytes,
        fileName: `${safeBaseName}-metadata.json`,
        mimeType: "application/json",
        keyvalues: {
          laypipe: "token-metadata",
          wallet: wallet.toLowerCase(),
          image_cid: imagePin.cid,
          laypipe_promotion: promotion.promotionId,
          laypipe_promotion_part: "metadata",
          laypipe_pin_digest: promotion.pinDigest,
          laypipe_stage_file: promotion.stageFileId,
        },
        signal: upstreamSignal,
      });
      assertUploadResult(uploaded, {
        size: metadataResult.bytes.byteLength,
        mimeType: "application/json",
      });
      metadataPin = promotionPin(uploaded);
      state = metadataPinnedState(state, metadataPin);
      await savePromotionState(lease, state, { signal: upstreamSignal });
    }

    const responseJson = JSON.stringify({
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
    });
    state = completedState(state, responseJson);
    await completePromotion(lease, state, { signal: upstreamSignal });
    lease = undefined;
    await registerCompletedPromotion({
      database: await promotionRegistry(),
      state,
      wallet,
      fileSha256,
    });

    if (staged && !(await deletePublicFile(staged.id, fetch))) {
      console.warn("LayPipe temporary artwork cleanup failed", {
        error: "StageCleanupError",
        promotionId: promotion.promotionId,
      });
    }
    return exactSuccess(responseJson);
  } catch (error) {
    if (lease) {
      try {
        await releasePromotionLease(lease);
      } catch {
        console.warn("LayPipe promotion lease cleanup failed", {
          error: "PromotionLeaseCleanupError",
          promotionId: lease.promotionId,
        });
      }
    }
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  return observeOperationalRequest(request, "/api/ipfs/pin", () =>
    handlePinRequest(request),
  );
}
