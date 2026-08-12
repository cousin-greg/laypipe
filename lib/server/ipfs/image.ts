import { createHash } from "node:crypto";
import sharp from "sharp";
import { MAX_ARTWORK_BYTES } from "@/lib/ipfs/artwork";
import { HttpError } from "@/lib/server/auth/http";

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export interface SanitizedArtwork {
  bytes: Buffer;
  mimeType: "image/webp";
  extension: "webp";
  width: number;
  height: number;
  sha256: string;
}

function sniffImageType(bytes: Uint8Array) {
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function sanitizeArtwork(options: {
  bytes: Uint8Array;
  declaredMimeType: string;
  expectedSha256: string;
}): Promise<SanitizedArtwork> {
  if (options.bytes.byteLength === 0 || options.bytes.byteLength > MAX_ARTWORK_BYTES) {
    throw new HttpError(413, "IMAGE_SIZE", "Artwork must be 5 MB or smaller.");
  }
  if (!ALLOWED_IMAGE_TYPES.includes(options.declaredMimeType as never)) {
    throw new HttpError(415, "IMAGE_TYPE", "Artwork must be PNG, JPG, or WEBP.");
  }
  const sniffed = sniffImageType(options.bytes);
  if (!sniffed || sniffed !== options.declaredMimeType) {
    throw new HttpError(415, "IMAGE_SIGNATURE", "Artwork type does not match its bytes.");
  }
  const rawSha256 = createHash("sha256").update(options.bytes).digest("hex");
  if (rawSha256 !== options.expectedSha256.toLowerCase()) {
    throw new HttpError(400, "IMAGE_DIGEST", "Artwork digest does not match the upload.");
  }

  try {
    const decoded = sharp(options.bytes, {
      failOn: "warning",
      limitInputPixels: 4096 * 4096,
      sequentialRead: true,
    });
    const info = await decoded.metadata();
    if (
      !info.width ||
      !info.height ||
      info.width !== info.height ||
      info.width < 256 ||
      info.width > 4096 ||
      info.pages !== undefined && info.pages !== 1
    ) {
      throw new HttpError(
        400,
        "IMAGE_DIMENSIONS",
        "Artwork must be one square frame between 256 and 4096 pixels.",
      );
    }
    const bytes = await decoded
      .rotate()
      .webp({ quality: 90, alphaQuality: 100, effort: 6, smartSubsample: true })
      .toBuffer();
    return {
      bytes,
      mimeType: "image/webp",
      extension: "webp",
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "IMAGE_DECODE", "Artwork could not be safely decoded.");
  }
}
