export const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
export const MIN_ARTWORK_DIMENSION = 256;
export const MAX_ARTWORK_DIMENSION = 4096;

export const SUPPORTED_ARTWORK_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type ArtworkMimeType = (typeof SUPPORTED_ARTWORK_TYPES)[number];

export interface ValidatedArtwork {
  file: File;
  mimeType: ArtworkMimeType;
  width: number;
  height: number;
  safeName: string;
}

export class ArtworkValidationError extends Error {
  readonly code:
    | "EMPTY"
    | "TOO_LARGE"
    | "UNSUPPORTED_TYPE"
    | "MIME_MISMATCH"
    | "INVALID_IMAGE"
    | "NOT_SQUARE"
    | "DIMENSIONS_OUT_OF_RANGE";

  constructor(code: ArtworkValidationError["code"], message: string) {
    super(message);
    this.name = "ArtworkValidationError";
    this.code = code;
  }
}

function readBigEndian16(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readBigEndian32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function parsePng(bytes: Uint8Array) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length < 24 ||
    !hasBytes(bytes, 0, signature) ||
    !hasBytes(bytes, 12, [0x49, 0x48, 0x44, 0x52])
  ) {
    return null;
  }

  return {
    mimeType: "image/png" as const,
    width: readBigEndian32(bytes, 16),
    height: readBigEndian32(bytes, 20),
  };
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

function parseJpeg(bytes: Uint8Array) {
  if (bytes.length < 4 || !hasBytes(bytes, 0, [0xff, 0xd8])) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 1 >= bytes.length) break;

    const segmentLength = readBigEndian16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return {
        mimeType: "image/jpeg" as const,
        height: readBigEndian16(bytes, offset + 3),
        width: readBigEndian16(bytes, offset + 5),
      };
    }

    offset += segmentLength;
  }

  return null;
}

function readLittleEndian24(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseWebp(bytes: Uint8Array) {
  if (
    bytes.length < 30 ||
    !hasBytes(bytes, 0, [0x52, 0x49, 0x46, 0x46]) ||
    !hasBytes(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return null;
  }

  if (hasBytes(bytes, 12, [0x56, 0x50, 0x38, 0x58])) {
    return {
      mimeType: "image/webp" as const,
      width: readLittleEndian24(bytes, 24) + 1,
      height: readLittleEndian24(bytes, 27) + 1,
    };
  }

  if (
    hasBytes(bytes, 12, [0x56, 0x50, 0x38, 0x20]) &&
    hasBytes(bytes, 23, [0x9d, 0x01, 0x2a])
  ) {
    return {
      mimeType: "image/webp" as const,
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }

  if (hasBytes(bytes, 12, [0x56, 0x50, 0x38, 0x4c]) && bytes[20] === 0x2f) {
    return {
      mimeType: "image/webp" as const,
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height:
        1 +
        ((bytes[22] & 0xc0) >> 6) +
        (bytes[23] << 2) +
        ((bytes[24] & 0x0f) << 10),
    };
  }

  return null;
}

function inspectArtwork(bytes: Uint8Array) {
  return parsePng(bytes) ?? parseJpeg(bytes) ?? parseWebp(bytes);
}

export function sanitizeArtworkName(name: string) {
  const normalized = name
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 96);

  return normalized || "token-artwork";
}

export async function artworkContentHash(file: Blob) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function validateArtworkFile(file: File): Promise<ValidatedArtwork> {
  if (file.size === 0) {
    throw new ArtworkValidationError("EMPTY", "Choose a non-empty image file.");
  }

  if (file.size > MAX_ARTWORK_BYTES) {
    throw new ArtworkValidationError(
      "TOO_LARGE",
      "Artwork must be 5 MB or smaller.",
    );
  }

  if (!SUPPORTED_ARTWORK_TYPES.includes(file.type as ArtworkMimeType)) {
    throw new ArtworkValidationError(
      "UNSUPPORTED_TYPE",
      "Artwork must be a PNG, JPG, or WEBP file.",
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const inspected = inspectArtwork(bytes);
  if (!inspected || inspected.width <= 0 || inspected.height <= 0) {
    throw new ArtworkValidationError(
      "INVALID_IMAGE",
      "The file contents are not a valid supported image.",
    );
  }

  if (file.type !== inspected.mimeType) {
    throw new ArtworkValidationError(
      "MIME_MISMATCH",
      "The file extension or MIME type does not match its image contents.",
    );
  }

  if (inspected.width !== inspected.height) {
    throw new ArtworkValidationError(
      "NOT_SQUARE",
      `Artwork must be square; this file is ${inspected.width} by ${inspected.height}px.`,
    );
  }

  if (
    inspected.width < MIN_ARTWORK_DIMENSION ||
    inspected.width > MAX_ARTWORK_DIMENSION
  ) {
    throw new ArtworkValidationError(
      "DIMENSIONS_OUT_OF_RANGE",
      `Artwork must be between ${MIN_ARTWORK_DIMENSION} and ${MAX_ARTWORK_DIMENSION}px square.`,
    );
  }

  return {
    file,
    mimeType: inspected.mimeType,
    width: inspected.width,
    height: inspected.height,
    safeName: sanitizeArtworkName(file.name),
  };
}
