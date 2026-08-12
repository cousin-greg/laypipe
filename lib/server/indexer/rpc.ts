import type { Eip1193Provider, Eip1193RequestArguments } from "../../web3/types";

const DEFAULT_RESPONSE_LIMIT = 4 * 1024 * 1024;

export class IndexerRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexerRpcError";
  }
}

function rpcUrl(value: string | undefined) {
  if (!value?.trim()) throw new Error("ROBINHOOD_RPC_HTTP_URL is required.");
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("ROBINHOOD_RPC_HTTP_URL is invalid.");
  }
  const localTestUrl =
    process.env.NODE_ENV === "test" &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (
    (parsed.protocol !== "https:" && !localTestUrl) ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("ROBINHOOD_RPC_HTTP_URL must be a secure HTTPS endpoint.");
  }
  return parsed.toString();
}

async function boundedText(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new IndexerRpcError("RPC response exceeded the configured byte limit.");
  }
  if (!response.body) throw new IndexerRpcError("RPC response body is missing.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new IndexerRpcError("RPC response exceeded the configured byte limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function createHttpIndexerRpc(options: {
  url?: string;
  deadlineAt: number;
  fetcher?: typeof fetch;
  responseLimitBytes?: number;
}): Eip1193Provider {
  const endpoint = rpcUrl(options.url);
  const fetcher = options.fetcher ?? fetch;
  const responseLimit = options.responseLimitBytes ?? DEFAULT_RESPONSE_LIMIT;
  if (
    !Number.isSafeInteger(responseLimit) ||
    responseLimit < 65_536 ||
    responseLimit > 16 * 1024 * 1024
  ) {
    throw new Error("RPC response byte limit is invalid.");
  }
  let requestId = 0;

  return {
    async request<T = unknown>(args: Eip1193RequestArguments): Promise<T> {
      const remaining = options.deadlineAt - Date.now();
      if (remaining <= 0) throw new IndexerRpcError("Indexer run deadline expired.");
      const id = ++requestId;
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: args.method,
        ...(args.params === undefined ? {} : { params: args.params }),
      });
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(8_000, remaining)),
        });
      } catch {
        throw new IndexerRpcError("Robinhood RPC request failed.");
      }
      if (!response.ok) {
        throw new IndexerRpcError(`Robinhood RPC returned HTTP ${response.status}.`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await boundedText(response, responseLimit));
      } catch (error) {
        if (error instanceof IndexerRpcError) throw error;
        throw new IndexerRpcError("Robinhood RPC returned invalid JSON.");
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new IndexerRpcError("Robinhood RPC returned an invalid envelope.");
      }
      const envelope = payload as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: { code?: unknown };
      };
      if (envelope.jsonrpc !== "2.0" || envelope.id !== id) {
        throw new IndexerRpcError("Robinhood RPC response identity did not match.");
      }
      if (envelope.error) {
        const code =
          typeof envelope.error.code === "number" ? envelope.error.code : "unknown";
        throw new IndexerRpcError(`Robinhood RPC rejected ${args.method} (${code}).`);
      }
      if (!("result" in envelope)) {
        throw new IndexerRpcError("Robinhood RPC response omitted its result.");
      }
      return envelope.result as T;
    },
  };
}
