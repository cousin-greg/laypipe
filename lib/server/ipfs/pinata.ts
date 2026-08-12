import { BlackHoleBlockstore } from "blockstore-core/black-hole";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import { HttpError } from "@/lib/server/auth/http";
import { parseCid } from "@/lib/server/auth/request-digest";
import { pinataGatewayBaseUrl } from "@/lib/ipfs/gateway";

const PINATA_API = "https://api.pinata.cloud";
const PINATA_UPLOADS = "https://uploads.pinata.cloud";

interface PinataUploadData {
  id?: unknown;
  cid?: unknown;
  size?: unknown;
  mime_type?: unknown;
}

interface PinataFileData extends PinataUploadData {
  keyvalues?: unknown;
  name?: unknown;
}

interface PinataListFileData {
  id?: unknown;
  created_at?: unknown;
  keyvalues?: unknown;
}

interface PinataListPayload {
  data?: {
    files?: unknown;
    next_page_token?: unknown;
  };
}

export interface PinataFile {
  id: string;
  cid: string;
  size: number;
  mimeType: string;
  name?: string;
  keyvalues?: Record<string, string>;
}

interface ListedPinataFile {
  id: string;
  createdAt: number;
  keyvalues: Record<string, string>;
}

export interface StageCleanupResult {
  scanned: number;
  stale: number;
  deleted: number;
  failed: number;
  truncated: boolean;
}

const STAGE_MAX_AGE_MS = 60 * 60 * 1000;
const CLEANUP_PAGE_SIZE = 100;
const CLEANUP_MAX_PAGES = 10;
const CLEANUP_MAX_DELETES = 100;
const PINATA_REQUEST_TIMEOUT_MS = 15_000;
const MISMATCH_CLEANUP_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 45_000;
const CLEANUP_DELETE_CONCURRENCY = 20;
const PINATA_FILE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function boundedPinataSignal(signal?: AbortSignal | null) {
  const timeout = AbortSignal.timeout(PINATA_REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request(
  fetcher: typeof fetch,
  input: string | URL,
  init: RequestInit,
  code: string,
  message: string,
) {
  try {
    return await fetcher(input, {
      ...init,
      redirect: "error",
      signal: boundedPinataSignal(init.signal),
    });
  } catch {
    throw new HttpError(502, code, message);
  }
}

function jwt() {
  const value = process.env.PINATA_JWT;
  if (!value) {
    throw new HttpError(503, "IPFS_NOT_CONFIGURED", "Artwork storage is unavailable.");
  }
  return value;
}

export function requireIpfsPinningEnabled() {
  if (process.env.IPFS_PINNING_ENABLED !== "true") {
    throw new HttpError(
      503,
      "IPFS_DISABLED",
      "Artwork publishing is currently disabled.",
    );
  }
}

function gatewayBaseUrl() {
  try {
    return pinataGatewayBaseUrl(
      process.env.IPFS_GATEWAY_BASE_URL,
      process.env.NODE_ENV === "production",
    );
  } catch {
    throw new HttpError(
      503,
      process.env.IPFS_GATEWAY_BASE_URL
        ? "IPFS_GATEWAY_INVALID"
        : "IPFS_GATEWAY_NOT_CONFIGURED",
      "Artwork storage is unavailable.",
    );
  }
}

function pinataHeaders(extra?: HeadersInit) {
  return {
    Authorization: `Bearer ${jwt()}`,
    ...extra,
  };
}

function parsePinataFile(payload: unknown): PinataFile {
  const data = (payload as { data?: PinataFileData } | null)?.data;
  if (
    !data ||
    typeof data.id !== "string" ||
    !PINATA_FILE_ID_PATTERN.test(data.id) ||
    typeof data.cid !== "string" ||
    typeof data.size !== "number" ||
    !Number.isSafeInteger(data.size) ||
    data.size < 0 ||
    typeof data.mime_type !== "string" ||
    data.mime_type.length > 128
  ) {
    throw new HttpError(502, "IPFS_RESPONSE", "Artwork storage returned invalid data.");
  }
  const keyvalues =
    data.keyvalues && typeof data.keyvalues === "object" && !Array.isArray(data.keyvalues)
      ? Object.fromEntries(
          Object.entries(data.keyvalues as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
  let cid: string;
  try {
    cid = CID.parse(data.cid).toV1().toString();
  } catch {
    throw new HttpError(502, "IPFS_RESPONSE", "Artwork storage returned invalid data.");
  }
  return {
    id: data.id,
    cid,
    size: data.size,
    mimeType: data.mime_type,
    ...(typeof data.name === "string" ? { name: data.name } : {}),
    ...(keyvalues ? { keyvalues } : {}),
  };
}

function parseListedFile(value: unknown): ListedPinataFile {
  const file = value as PinataListFileData | null;
  if (
    !file ||
    typeof file.id !== "string" ||
    !PINATA_FILE_ID_PATTERN.test(file.id) ||
    typeof file.created_at !== "string" ||
    !ISO_INSTANT_PATTERN.test(file.created_at) ||
    !file.keyvalues ||
    typeof file.keyvalues !== "object" ||
    Array.isArray(file.keyvalues)
  ) {
    throw new HttpError(
      502,
      "IPFS_LIST_RESPONSE",
      "Artwork storage returned an invalid cleanup page.",
    );
  }
  const createdAt = Date.parse(file.created_at);
  const entries = Object.entries(file.keyvalues as Record<string, unknown>);
  if (
    !Number.isFinite(createdAt) ||
    entries.some(([key, value]) => !key || typeof value !== "string")
  ) {
    throw new HttpError(
      502,
      "IPFS_LIST_RESPONSE",
      "Artwork storage returned an invalid cleanup page.",
    );
  }
  return {
    id: file.id,
    createdAt,
    keyvalues: Object.fromEntries(entries) as Record<string, string>,
  };
}

async function listStagePage(options: {
  pageToken?: string;
  fetcher: typeof fetch;
  signal: AbortSignal;
}) {
  const url = new URL(`${PINATA_API}/v3/files/public`);
  url.searchParams.set("keyvalues[laypipe_stage]", "true");
  url.searchParams.set("limit", String(CLEANUP_PAGE_SIZE));
  url.searchParams.set("order", "ASC");
  if (options.pageToken) url.searchParams.set("pageToken", options.pageToken);
  const response = await request(
    options.fetcher,
    url,
    { headers: pinataHeaders(), cache: "no-store", signal: options.signal },
    "IPFS_LIST",
    "Artwork cleanup could not query storage.",
  );
  const payload = (await response.json().catch(() => null)) as PinataListPayload | null;
  if (!response.ok || !payload?.data || !Array.isArray(payload.data.files)) {
    throw new HttpError(
      502,
      "IPFS_LIST_RESPONSE",
      "Artwork storage returned an invalid cleanup page.",
    );
  }
  if (payload.data.files.length > CLEANUP_PAGE_SIZE) {
    throw new HttpError(
      502,
      "IPFS_LIST_RESPONSE",
      "Artwork storage returned an invalid cleanup page.",
    );
  }
  const rawNext = payload.data.next_page_token;
  if (
    rawNext !== undefined &&
    rawNext !== null &&
    rawNext !== "" &&
    (typeof rawNext !== "string" ||
      rawNext.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(rawNext))
  ) {
    throw new HttpError(
      502,
      "IPFS_LIST_RESPONSE",
      "Artwork storage returned an invalid cleanup page.",
    );
  }
  return {
    files: payload.data.files.map(parseListedFile),
    nextPageToken: typeof rawNext === "string" && rawNext ? rawNext : undefined,
  };
}

function isOwnedStage(file: ListedPinataFile) {
  return (
    file.keyvalues.laypipe_stage === "true" &&
    /^0x[0-9a-f]{40}$/.test(file.keyvalues.wallet ?? "") &&
    /^[0-9a-f]{64}$/.test(file.keyvalues.digest ?? "") &&
    /^[0-9a-f]{64}$/.test(file.keyvalues.file_sha256 ?? "")
  );
}

export async function sweepStaleStageFiles(options?: {
  now?: number;
  fetcher?: typeof fetch;
}): Promise<StageCleanupResult> {
  const now = options?.now ?? Date.now();
  const fetcher = options?.fetcher ?? fetch;
  const cleanupSignal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
  const pages: ListedPinataFile[][] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  let truncated = false;

  for (let page = 0; page < CLEANUP_MAX_PAGES; page += 1) {
    const result = await listStagePage({ pageToken, fetcher, signal: cleanupSignal });
    pages.push(result.files);
    if (!result.nextPageToken) {
      pageToken = undefined;
      break;
    }
    if (seenTokens.has(result.nextPageToken)) {
      throw new HttpError(
        502,
        "IPFS_LIST_RESPONSE",
        "Artwork storage returned an invalid cleanup page.",
      );
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
    if (page === CLEANUP_MAX_PAGES - 1) truncated = true;
  }

  const files = pages.flat();
  const eligibleById = new Map(
    files
      .filter(
        (file) =>
          isOwnedStage(file) && now - file.createdAt >= STAGE_MAX_AGE_MS,
      )
      .map((file) => [file.id, file]),
  );
  const eligible = [...eligibleById.values()];
  const candidates = eligible.slice(0, CLEANUP_MAX_DELETES);
  if (eligible.length > CLEANUP_MAX_DELETES) truncated = true;

  let deleted = 0;
  let failed = 0;
  for (
    let offset = 0;
    offset < candidates.length;
    offset += CLEANUP_DELETE_CONCURRENCY
  ) {
    const outcomes = await Promise.all(
      candidates
        .slice(offset, offset + CLEANUP_DELETE_CONCURRENCY)
        .map((file) => deletePublicFile(file.id, fetcher, cleanupSignal)),
    );
    deleted += outcomes.filter(Boolean).length;
    failed += outcomes.filter((outcome) => !outcome).length;
  }
  return {
    scanned: files.length,
    stale: candidates.length,
    deleted,
    failed,
    truncated,
  };
}

export async function createPresignedStageUrl(options: {
  fileName: string;
  mimeType: string;
  wallet: string;
  digest: string;
  fileSha256: string;
  fetcher?: typeof fetch;
}) {
  const response = await request(
    options.fetcher ?? fetch,
    `${PINATA_UPLOADS}/v3/files/sign`,
    {
      method: "POST",
      headers: pinataHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        date: Math.floor(Date.now() / 1000),
        expires: 60,
        network: "public",
        cid_version: "v1",
        max_file_size: 5 * 1024 * 1024,
        allow_mime_types: [options.mimeType],
        filename: options.fileName,
        keyvalues: {
          laypipe_stage: "true",
          wallet: options.wallet.toLowerCase(),
          digest: options.digest,
          file_sha256: options.fileSha256,
        },
      }),
      cache: "no-store",
    },
    "IPFS_STAGE",
    "Artwork staging is unavailable.",
  );
  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!response.ok || typeof payload?.data !== "string") {
    throw new HttpError(502, "IPFS_STAGE", "Artwork staging is unavailable.");
  }
  let url: URL;
  try {
    url = new URL(payload.data);
  } catch {
    throw new HttpError(502, "IPFS_STAGE", "Artwork staging returned an invalid URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "uploads.pinata.cloud" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !(url.pathname === "/v3/files" || url.pathname.startsWith("/v3/files/"))
  ) {
    throw new HttpError(502, "IPFS_STAGE", "Artwork staging returned an invalid URL.");
  }
  return { uploadUrl: url.toString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
}

export async function predictPublicFileCid(bytes: Uint8Array) {
  const blockstore = new BlackHoleBlockstore();
  let root: CID | undefined;
  for await (const entry of importer([{ content: bytes }], blockstore, {
    cidVersion: 1,
    rawLeaves: true,
  })) {
    root = entry.cid;
  }
  if (!root) {
    throw new HttpError(500, "IPFS_CID", "Artwork storage integrity check failed.");
  }
  return root.toV1().toString();
}

export async function getStagedFile(
  fileId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (!PINATA_FILE_ID_PATTERN.test(fileId)) {
    throw new HttpError(400, "INVALID_FILE_ID", "Staged file ID is invalid.");
  }
  const response = await request(
    fetcher,
    `${PINATA_API}/v3/files/public/${encodeURIComponent(fileId)}`,
    { headers: pinataHeaders(), cache: "no-store", signal },
    "STAGE_NOT_FOUND",
    "Staged artwork was not found.",
  );
  if (!response.ok) {
    throw new HttpError(400, "STAGE_NOT_FOUND", "Staged artwork was not found.");
  }
  const file = parsePinataFile(await response.json().catch(() => null));
  if (file.id.toLowerCase() !== fileId.toLowerCase()) {
    throw new HttpError(502, "IPFS_RESPONSE", "Artwork storage returned invalid data.");
  }
  return file;
}

export async function fetchPublicCid(
  cid: string,
  options: { maxBytes: number; fetcher?: typeof fetch; signal?: AbortSignal },
) {
  const normalized = parseCid(cid);
  const response = await request(
    options.fetcher ?? fetch,
    `${gatewayBaseUrl()}/${encodeURIComponent(normalized)}`,
    { cache: "no-store", signal: options.signal },
    "STAGE_FETCH",
    "Staged artwork could not be retrieved.",
  );
  if (!response.ok) {
    throw new HttpError(502, "STAGE_FETCH", "Staged artwork could not be retrieved.");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    throw new HttpError(413, "IMAGE_SIZE", "Artwork must be 5 MB or smaller.");
  }
  if (!response.body) {
    throw new HttpError(502, "STAGE_FETCH", "Staged artwork could not be retrieved.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(413, "IMAGE_SIZE", "Artwork must be 5 MB or smaller.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "STAGE_FETCH", "Staged artwork could not be retrieved.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: response.headers.get("content-type")?.split(";")[0] ?? "" };
}

export async function uploadPublicFile(options: {
  bytes: Uint8Array;
  fileName: string;
  mimeType: string;
  keyvalues: Record<string, string>;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}) {
  const expectedCid = await predictPublicFileCid(options.bytes);
  const form = new FormData();
  form.set("network", "public");
  form.set("cid_version", "v1");
  form.set("name", options.fileName);
  form.set("keyvalues", JSON.stringify(options.keyvalues));
  form.set(
    "file",
    new File([new Uint8Array(options.bytes)], options.fileName, { type: options.mimeType }),
  );
  const response = await request(
    options.fetcher ?? fetch,
    `${PINATA_UPLOADS}/v3/files`,
    {
      method: "POST",
      headers: pinataHeaders(),
      body: form,
      cache: "no-store",
      signal: options.signal,
    },
    "IPFS_UPLOAD",
    "Artwork storage failed.",
  );
  if (!response.ok) {
    throw new HttpError(502, "IPFS_UPLOAD", "Artwork storage failed.");
  }
  const uploaded = parsePinataFile(await response.json().catch(() => null));
  if (uploaded.cid !== expectedCid) {
    const cleaned = await deletePublicFile(
      uploaded.id,
      options.fetcher ?? fetch,
      AbortSignal.timeout(MISMATCH_CLEANUP_TIMEOUT_MS),
    );
    if (!cleaned) {
      console.warn("LayPipe mismatched permanent pin cleanup failed", {
        error: "PinMismatchCleanupError",
        fileId: uploaded.id,
      });
    }
    throw new HttpError(
      502,
      "IPFS_CID_MISMATCH",
      "Artwork storage failed its integrity check.",
    );
  }
  return uploaded;
}

export async function deletePublicFile(
  fileId: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
) {
  if (!PINATA_FILE_ID_PATTERN.test(fileId)) return false;
  try {
    const response = await request(
      fetcher,
      `${PINATA_API}/v3/files/public/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: pinataHeaders(),
        cache: "no-store",
        signal,
      },
      "IPFS_DELETE",
      "Artwork cleanup failed.",
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function gatewayUrl(cid: string) {
  const normalized = CID.parse(cid).toV1().toString();
  return `${gatewayBaseUrl()}/${normalized}`;
}
