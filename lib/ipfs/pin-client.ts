import { validateArtworkFile, type ValidatedArtwork } from "./artwork";
import {
  assertIpfsUri,
  buildTokenMetadata,
  type LaunchMetadataDraft,
  type LaunchTokenMetadata,
} from "./metadata";

export interface PinnedIpfsObject {
  cid: string;
  uri: `ipfs://${string}`;
  gatewayUrl?: string;
}

export interface PinnedLaunchAssets {
  image: PinnedIpfsObject;
  metadata: PinnedIpfsObject;
  metadataDocument: LaunchTokenMetadata;
  artwork: ValidatedArtwork;
}

interface PinResponse {
  image?: { cid?: unknown; uri?: unknown; gatewayUrl?: unknown };
  metadata?: { cid?: unknown; uri?: unknown; gatewayUrl?: unknown };
  metadataDocument?: unknown;
  error?: unknown;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export class IpfsPinError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "IpfsPinError";
    this.status = status;
  }
}

function assertSameOriginEndpoint(endpoint: string, browserOrigin: string) {
  const url = new URL(endpoint, browserOrigin);
  if (url.origin !== browserOrigin) {
    throw new IpfsPinError("The artwork upload endpoint must be same-origin.");
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new IpfsPinError("The artwork upload endpoint must use HTTPS.");
  }
  return url.toString();
}

function parsePinnedObject(
  value: PinResponse["image"],
  label: string,
): PinnedIpfsObject {
  if (!value || typeof value.cid !== "string" || typeof value.uri !== "string") {
    throw new IpfsPinError(`${label} pinning returned an incomplete response.`);
  }

  const uri = assertIpfsUri(value.uri, label);
  if (uri !== `ipfs://${value.cid}`) {
    throw new IpfsPinError(`${label} CID and URI do not match.`);
  }

  let gatewayUrl: string | undefined;
  if (typeof value.gatewayUrl === "string") {
    let parsed: URL;
    try {
      parsed = new URL(value.gatewayUrl);
    } catch {
      throw new IpfsPinError(`${label} gateway URL is invalid.`);
    }
    const expectedPath = `/ipfs/${value.cid}`;
    if (
      parsed.protocol !== "https:" ||
      !(parsed.pathname === expectedPath || parsed.pathname.startsWith(`${expectedPath}/`))
    ) {
      throw new IpfsPinError(
        `${label} gateway URL must use HTTPS and match its CID path.`,
      );
    }
    gatewayUrl = parsed.toString();
  }

  return {
    cid: value.cid,
    uri,
    ...(gatewayUrl ? { gatewayUrl } : {}),
  };
}

export async function pinLaunchAssets(options: {
  endpoint: string;
  file: File;
  metadata: LaunchMetadataDraft;
  browserOrigin: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<PinnedLaunchAssets> {
  const artwork = await validateArtworkFile(options.file);
  const endpoint = assertSameOriginEndpoint(
    options.endpoint,
    options.browserOrigin,
  );
  const body = new FormData();
  body.set("file", artwork.file, artwork.safeName);
  body.set("metadata", JSON.stringify(options.metadata));

  const response = await (options.fetcher ?? fetch)(endpoint, {
    method: "POST",
    body,
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    signal: options.signal,
  });

  let payload: PinResponse;
  try {
    payload = (await response.json()) as PinResponse;
  } catch {
    throw new IpfsPinError(
      "The artwork service returned an unreadable response.",
      response.status,
    );
  }

  if (!response.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : "Artwork pinning failed. Nothing was sent on-chain.";
    throw new IpfsPinError(message, response.status);
  }

  const image = parsePinnedObject(payload.image, "Artwork");
  const metadata = parsePinnedObject(payload.metadata, "Metadata");
  const metadataDocument = buildTokenMetadata(options.metadata, image.uri);
  if (
    !payload.metadataDocument ||
    canonicalJson(payload.metadataDocument) !== canonicalJson(metadataDocument)
  ) {
    throw new IpfsPinError(
      "Pinned metadata does not match the reviewed launch metadata.",
      response.status,
    );
  }
  return {
    image,
    metadata,
    metadataDocument,
    artwork,
  };
}
