import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ROBINHOOD_CHAIN_ID = 4663n;
export const TRANSIENT_STORAGE_PROBE_INITCODE =
  "0x602a60005d60005c60005260206000f3";
export const INVALID_OPCODE_CONTROL_INITCODE = "0xfe";
export const EXPECTED_PROBE_RESULT = `0x${"0".repeat(62)}2a`;

const HASH_PATTERN = /^0x[0-9a-f]{64}$/i;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const INVALID_OPCODE_PATTERN = /invalid (?:opcode|instruction)/i;

export class JsonRpcResponseError extends Error {
  constructor(method, error) {
    const code = Number.isInteger(error?.code) ? error.code : null;
    const message =
      typeof error?.message === "string" ? error.message : "unknown RPC error";
    super(
      `JSON-RPC ${method} failed${code === null ? "" : ` (${code})`}: ${message}`,
    );
    this.name = "JsonRpcResponseError";
    this.code = code;
    this.rpcMessage = message;
    this.data = error?.data;
  }
}

function assertRpcUrl(value) {
  if (!value) {
    throw new Error(
      "ROBINHOOD_RPC_URL is required. Keep provider credentials in the environment, not the command line.",
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ROBINHOOD_RPC_URL must be a valid HTTP(S) URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error("ROBINHOOD_RPC_URL must be a secure HTTPS endpoint.");
  }
}

function parseQuantity(value, label) {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) {
    throw new Error(`${label} was not a canonical JSON-RPC hex quantity.`);
  }
  return BigInt(value);
}

function assertHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} was not a 32-byte hex hash.`);
  }
  return value.toLowerCase();
}

function stringifyErrorData(data) {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data ?? "");
  } catch {
    return "";
  }
}

function isInvalidOpcodeError(error) {
  if (!(error instanceof JsonRpcResponseError)) return false;
  return INVALID_OPCODE_PATTERN.test(
    `${error.rpcMessage} ${stringifyErrorData(error.data)}`,
  );
}

function createRpcClient({ rpcUrl, fetchImpl, timeoutMs }) {
  let nextId = 1;

  return async function rpc(method, params) {
    const id = nextId++;
    let response;
    try {
      response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new Error(`RPC transport failed while calling ${method}.`, { cause });
    }

    if (!response?.ok) {
      throw new Error(
        `RPC HTTP request failed while calling ${method} (status ${response?.status ?? "unknown"}).`,
      );
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch (cause) {
      throw new Error(`RPC returned invalid JSON for ${method}.`, { cause });
    }

    if (payload?.jsonrpc !== "2.0" || payload.id !== id) {
      throw new Error(`RPC returned a mismatched JSON-RPC envelope for ${method}.`);
    }
    if (payload.error !== undefined) {
      if (
        payload.error === null ||
        typeof payload.error !== "object" ||
        Array.isArray(payload.error)
      ) {
        throw new Error(`RPC returned a malformed error object for ${method}.`);
      }
      throw new JsonRpcResponseError(method, payload.error);
    }
    if (!Object.hasOwn(payload, "result")) {
      throw new Error(`RPC response for ${method} did not contain a result.`);
    }
    return payload.result;
  };
}

export async function runRobinhoodEip1153Gate({
  rpcUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20_000,
} = {}) {
  assertRpcUrl(rpcUrl);
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible implementation is required.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive safe integer.");
  }

  const rpc = createRpcClient({ rpcUrl, fetchImpl, timeoutMs });
  const chainIdHex = await rpc("eth_chainId", []);
  const chainId = parseQuantity(chainIdHex, "eth_chainId");
  if (chainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error(
      `Wrong chain: expected Robinhood Chain 4663, received ${chainId.toString(10)}.`,
    );
  }

  const clientVersion = await rpc("web3_clientVersion", []);
  if (typeof clientVersion !== "string" || clientVersion.length === 0) {
    throw new Error("web3_clientVersion returned an invalid value.");
  }

  const block = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("eth_getBlockByNumber did not return a block object.");
  }
  const blockNumber = parseQuantity(block.number, "latest block number");
  const blockHash = assertHash(block.hash, "latest block hash");

  // EIP-1898 binds both calls to the exact canonical block hash returned above.
  // Omitting `to` makes these read-only eth_call contract-creation simulations.
  const pinnedBlock = { blockHash, requireCanonical: true };
  const from = "0x0000000000000000000000000000000000000001";
  const probeResult = await rpc("eth_call", [
    { from, data: TRANSIENT_STORAGE_PROBE_INITCODE },
    pinnedBlock,
  ]);
  if (
    typeof probeResult !== "string" ||
    probeResult.toLowerCase() !== EXPECTED_PROBE_RESULT
  ) {
    throw new Error(
      `EIP-1153 semantic probe returned ${String(probeResult)} instead of ${EXPECTED_PROBE_RESULT}.`,
    );
  }

  let controlError;
  try {
    await rpc("eth_call", [
      { from, data: INVALID_OPCODE_CONTROL_INITCODE },
      pinnedBlock,
    ]);
  } catch (error) {
    controlError = error;
  }
  if (!controlError) {
    throw new Error(
      "Invalid-opcode control unexpectedly succeeded; the RPC did not prove opcode execution semantics.",
    );
  }
  if (!isInvalidOpcodeError(controlError)) {
    throw new Error(
      "Invalid-opcode control did not fail with a JSON-RPC invalid-opcode error.",
      { cause: controlError },
    );
  }

  return {
    ok: true,
    chainId: Number(chainId),
    clientVersion,
    pinnedBlockNumber: blockNumber.toString(10),
    pinnedBlockHash: blockHash,
    transientStorageInitcode: TRANSIENT_STORAGE_PROBE_INITCODE,
    probeResult: EXPECTED_PROBE_RESULT,
    invalidOpcodeControl: {
      initcode: INVALID_OPCODE_CONTROL_INITCODE,
      rpcErrorCode: controlError.code,
      rpcErrorMessage: controlError.rpcMessage,
    },
    checkedAt: new Date().toISOString(),
  };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  runRobinhoodEip1153Gate({ rpcUrl: process.env.ROBINHOOD_RPC_URL })
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      console.error(
        `Robinhood EIP-1153 release gate failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    });
}
