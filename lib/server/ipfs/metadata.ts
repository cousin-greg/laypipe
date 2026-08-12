import {
  buildTokenMetadata,
  normalizeMetadataDraft,
  type LaunchFeeMode,
  type LaunchMetadataDraft,
} from "@/lib/ipfs/metadata";
import { HttpError } from "@/lib/server/auth/http";
import { canonicalJson } from "@/lib/server/auth/request-digest";

export function parseMetadataDraft(value: unknown): LaunchMetadataDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_METADATA", "Token metadata is invalid.");
  }
  const input = value as Record<string, unknown>;
  const attributeArray = Array.isArray(input.attributes) ? input.attributes : [];
  const modeAttribute = attributeArray.find(
    (attribute) =>
      attribute &&
      typeof attribute === "object" &&
      (attribute as Record<string, unknown>).trait_type === "fee_mode",
  ) as Record<string, unknown> | undefined;
  const feeMode = modeAttribute?.value;
  if (feeMode !== "creator" && feeMode !== "self-burn") {
    throw new HttpError(400, "INVALID_METADATA", "Token fee mode is invalid.");
  }

  let normalized: LaunchMetadataDraft;
  try {
    normalized = normalizeMetadataDraft({
      name: typeof input.name === "string" ? input.name : "",
      symbol: typeof input.symbol === "string" ? input.symbol : "",
      description: typeof input.description === "string" ? input.description : "",
      feeMode: feeMode as LaunchFeeMode,
      website: typeof input.website === "string" ? input.website : undefined,
      twitter: typeof input.twitter === "string" ? input.twitter : undefined,
      telegram: typeof input.telegram === "string" ? input.telegram : undefined,
      discord: typeof input.discord === "string" ? input.discord : undefined,
      extra: typeof input.extra === "string" ? input.extra : undefined,
    });
  } catch (error) {
    throw new HttpError(
      400,
      "INVALID_METADATA",
      error instanceof Error ? error.message : "Token metadata is invalid.",
    );
  }
  if (canonicalJson(normalized) !== canonicalJson(value)) {
    throw new HttpError(
      400,
      "NONCANONICAL_METADATA",
      "Token metadata must match the reviewed canonical document.",
    );
  }
  return normalized;
}

export function buildMetadataBytes(draft: LaunchMetadataDraft, imageUri: string) {
  const document = buildTokenMetadata(draft, imageUri);
  return {
    document,
    bytes: Buffer.from(JSON.stringify(document), "utf8"),
  };
}
