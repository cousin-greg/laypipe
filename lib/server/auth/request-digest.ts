import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import type { Address } from "@/lib/web3/types";
import type { LaunchMetadataDraft } from "@/lib/ipfs/metadata";
import { HttpError } from "./http";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseCid(value: string) {
  try {
    return CID.parse(value).toV1().toString();
  } catch {
    throw new HttpError(400, "INVALID_CID", "IPFS CID is invalid.");
  }
}

export function contentDigest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stageAuthorizationDigest(options: {
  wallet: Address;
  fileName: string;
  mimeType: string;
  size: number;
  fileSha256: string;
}) {
  return contentDigest({
    action: "stage",
    wallet: options.wallet.toLowerCase(),
    fileName: options.fileName,
    mimeType: options.mimeType,
    size: options.size,
    fileSha256: options.fileSha256.toLowerCase(),
  });
}

export function pinAuthorizationDigest(options: {
  wallet: Address;
  stagedCid: string;
  stagedFileId: string;
  fileSha256: string;
  metadata: LaunchMetadataDraft;
}) {
  return contentDigest({
    action: "pin",
    wallet: options.wallet.toLowerCase(),
    stagedCid: parseCid(options.stagedCid),
    stagedFileId: options.stagedFileId,
    fileSha256: options.fileSha256.toLowerCase(),
    metadata: options.metadata,
  });
}

export { canonicalJson };
