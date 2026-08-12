const IPFS_URI_PATTERN = /^ipfs:\/\/(b[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;

export type LaunchFeeMode = "creator" | "self-burn";

export interface LaunchSocials {
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  extra?: string;
}

export interface LaunchMetadataInput extends LaunchSocials {
  name: string;
  symbol: string;
  description: string;
  feeMode: LaunchFeeMode;
}

export interface LaunchMetadataDraft {
  name: string;
  symbol: string;
  description: string;
  external_url: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  extra?: string;
  attributes: Array<{ trait_type: string; value: string }>;
}

export interface LaunchTokenMetadata extends LaunchMetadataDraft {
  image: `ipfs://${string}`;
}

export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataValidationError";
  }
}

function cleanText(value: string, maxLength: number, label: string) {
  const cleaned = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();

  if (!cleaned) throw new MetadataValidationError(`${label} is required.`);
  if (cleaned.length > maxLength) {
    throw new MetadataValidationError(
      `${label} must be ${maxLength} characters or fewer.`,
    );
  }
  return cleaned;
}

function cleanOptionalUrl(value: string | undefined, label: string) {
  const cleaned = value?.normalize("NFKC").trim();
  if (!cleaned) return undefined;
  if (cleaned.length > 240) {
    throw new MetadataValidationError(`${label} URL is too long.`);
  }

  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    throw new MetadataValidationError(`${label} must be a complete HTTPS URL.`);
  }

  if (url.protocol !== "https:") {
    throw new MetadataValidationError(`${label} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new MetadataValidationError(`${label} cannot contain credentials.`);
  }
  url.hash = "";
  return url.toString();
}

export function normalizeMetadataDraft(
  input: LaunchMetadataInput,
): LaunchMetadataDraft {
  const name = cleanText(input.name, 32, "Coin name");
  const symbol = cleanText(input.symbol, 10, "Ticker").toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) {
    throw new MetadataValidationError(
      "Ticker can contain only A-Z and 0-9.",
    );
  }

  const description = cleanText(input.description, 240, "Description");
  const website = cleanOptionalUrl(input.website, "Website");
  const twitter = cleanOptionalUrl(input.twitter, "X / Twitter");
  const telegram = cleanOptionalUrl(input.telegram, "Telegram");
  const discord = cleanOptionalUrl(input.discord, "Discord");
  const extra = cleanOptionalUrl(input.extra, "Extra link");

  return {
    name,
    symbol,
    description,
    external_url: website ?? "https://laypipe.fun/",
    ...(website ? { website } : {}),
    ...(twitter ? { twitter } : {}),
    ...(telegram ? { telegram } : {}),
    ...(discord ? { discord } : {}),
    ...(extra ? { extra } : {}),
    attributes: [
      { trait_type: "launch_provider", value: "laypipe" },
      { trait_type: "chain", value: "robinhood" },
      { trait_type: "fee_mode", value: input.feeMode },
    ],
  };
}

export function isIpfsUri(value: string): value is `ipfs://${string}` {
  return IPFS_URI_PATTERN.test(value);
}

export function assertIpfsUri(value: string, label: string) {
  if (!isIpfsUri(value)) {
    throw new MetadataValidationError(`${label} did not return a valid IPFS URI.`);
  }
  return value;
}

export function buildTokenMetadata(
  draft: LaunchMetadataDraft,
  imageUri: string,
): LaunchTokenMetadata {
  return {
    name: draft.name,
    symbol: draft.symbol,
    description: draft.description,
    image: assertIpfsUri(imageUri, "Artwork"),
    external_url: draft.external_url,
    ...(draft.website ? { website: draft.website } : {}),
    ...(draft.twitter ? { twitter: draft.twitter } : {}),
    ...(draft.telegram ? { telegram: draft.telegram } : {}),
    ...(draft.discord ? { discord: draft.discord } : {}),
    ...(draft.extra ? { extra: draft.extra } : {}),
    attributes: draft.attributes.map((attribute) => ({ ...attribute })),
  };
}

export function serializeTokenMetadata(metadata: LaunchTokenMetadata) {
  return JSON.stringify(metadata);
}
