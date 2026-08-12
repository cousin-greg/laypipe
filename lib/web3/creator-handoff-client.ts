import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toEventSelector,
} from "viem";

import {
  assertAuditedMaintenanceDeployment,
  type AuditedDeploymentManifest,
} from "./deployment-manifest";
import {
  abortableDelay,
  describeWalletError,
  ensureRobinhoodChain,
  WalletFlowError,
} from "./launch-client";
import {
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_PUBLIC_RPC_URL,
} from "./chains";
import type {
  Address,
  Eip1193Provider,
  Eip1193RequestArguments,
  Hex,
  RpcTransactionReceipt,
  RpcTransactionRequest,
} from "./types";
import {
  isAddress,
  isHexData,
  isHexQuantity,
  isTransactionHash,
  sameAddress,
} from "./types";

const CREATOR_HANDOFF_CONFIRMATION_BLOCKS = BigInt(2);
const CREATOR_HANDOFF_READ_TIMEOUT_MS = 15_000;
const CREATOR_HANDOFF_PROMPT_TIMEOUT_MS = 120_000;
const CREATOR_HANDOFF_ABI = parseAbi([
  "function poolConfigs(bytes32 poolId) view returns (address creator, uint40 launchTime, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool exists)",
  "function updateCreator(bytes32 poolId, address newCreator)",
  "event CreatorUpdated(bytes32 indexed poolId, address indexed oldCreator, address indexed newCreator)",
]);
const CREATOR_UPDATED_TOPIC = toEventSelector(
  "CreatorUpdated(bytes32,address,address)",
);

type MaintenanceVerifier = typeof assertAuditedMaintenanceDeployment;

export interface CreatorHandoffState {
  creator: Address;
  blockNumber: bigint;
  blockTag: Hex;
}

export interface CreatorHandoffClientDependencies {
  confirmationProvider?: Eip1193Provider;
  walletRequestTimeoutMs?: number;
}

export interface CreatorHandoffSubmissionCallbacks {
  onSubmissionInvoked?: () => void;
  onSubmitted?: (hash: Hex) => void;
}

export class CreatorHandoffSubmissionIndeterminateError extends WalletFlowError {
  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message, code, causeData);
    this.name = "CreatorHandoffSubmissionIndeterminateError";
  }
}

export function isCreatorHandoffSubmissionIndeterminate(error: unknown) {
  return error instanceof CreatorHandoffSubmissionIndeterminateError;
}

export class CanonicalCreatorHandoffRevertedError extends WalletFlowError {
  constructor(
    message = "The creator handoff reverted on-chain after canonical confirmation.",
  ) {
    super(message);
    this.name = "CanonicalCreatorHandoffRevertedError";
  }
}

export function isCanonicalCreatorHandoffReverted(error: unknown) {
  return error instanceof CanonicalCreatorHandoffRevertedError;
}

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string"
    ? code
    : undefined;
}

function explicitWalletRejection(error: unknown) {
  const code = errorCode(error);
  return code === 4001 || code === "4001";
}

function createBoundedWalletProvider(
  provider: Eip1193Provider,
  timeoutOverride?: number,
): Eip1193Provider {
  if (
    timeoutOverride !== undefined &&
    (!Number.isSafeInteger(timeoutOverride) || timeoutOverride <= 0)
  ) {
    throw new WalletFlowError(
      "Creator handoff wallet request timeout must be a positive integer.",
    );
  }
  return {
    async request<T>(args: Eip1193RequestArguments) {
      const timeoutMs =
        timeoutOverride ??
        (args.method === "eth_sendTransaction" ||
        args.method === "wallet_switchEthereumChain" ||
        args.method === "wallet_addEthereumChain"
          ? CREATOR_HANDOFF_PROMPT_TIMEOUT_MS
          : CREATOR_HANDOFF_READ_TIMEOUT_MS);
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new WalletFlowError(
              `Wallet RPC ${args.method} timed out during creator handoff.`,
            ),
          );
        }, timeoutMs);
        Promise.resolve().then(() => provider.request<T>(args)).then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    },
  };
}

/**
 * The destination is intentionally strict: the UI never silently fixes a
 * mistyped mixed-case address for an irreversible creator-fee handoff.
 */
export function parseChecksummedCreatorAddress(
  value: string,
  currentCreator?: Address,
): Address {
  if (value !== value.trim() || !isAddress(value)) {
    throw new WalletFlowError(
      "Enter a complete checksummed EVM address with no surrounding spaces.",
    );
  }
  let checksummed: Address;
  try {
    checksummed = getAddress(value);
  } catch {
    throw new WalletFlowError("The new creator address checksum is invalid.");
  }
  if (checksummed !== value) {
    throw new WalletFlowError(
      `Use the checksummed address exactly: ${checksummed}`,
    );
  }
  if (BigInt(checksummed) === BigInt(0)) {
    throw new WalletFlowError("The new creator cannot be the zero address.");
  }
  if (currentCreator && sameAddress(checksummed, currentCreator)) {
    throw new WalletFlowError(
      "The new creator must differ from the current creator.",
    );
  }
  return checksummed;
}

export function createRobinhoodCreatorHandoffConfirmationProvider(
  fetcher: typeof fetch = fetch,
): Eip1193Provider {
  let requestId = 0;
  return {
    async request<T>(args: Eip1193RequestArguments) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(ROBINHOOD_PUBLIC_RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: (requestId += 1),
            method: args.method,
            ...(args.params === undefined ? {} : { params: args.params }),
          }),
          cache: "no-store",
          credentials: "omit",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new WalletFlowError(
            `Independent Robinhood RPC returned HTTP ${response.status}.`,
          );
        }
        const payload = (await response.json()) as {
          result?: unknown;
          error?: { code?: number; message?: string };
        };
        if (payload.error) {
          throw new WalletFlowError(
            payload.error.message ??
              "Independent Robinhood RPC request failed.",
            payload.error.code,
            payload.error,
          );
        }
        if (!("result" in payload)) {
          throw new WalletFlowError(
            "Independent Robinhood RPC response omitted its result.",
          );
        }
        return payload.result as T;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function rpcData(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexData(value)) {
    throw new WalletFlowError(`${label} returned malformed RPC data.`);
  }
  return value;
}

function rpcQuantity(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexQuantity(value)) {
    throw new WalletFlowError(`${label} returned a malformed RPC quantity.`);
  }
  return value;
}

async function boundedProviderRequest<T>(
  provider: Eip1193Provider,
  args: Eip1193RequestArguments,
  options: { signal?: AbortSignal; deadlineAt: number; label: string },
) {
  if (options.signal?.aborted) {
    throw new WalletFlowError("Creator handoff receipt check cancelled.");
  }
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new WalletFlowError(
      "The creator handoff is still pending. Check the explorer before trying again.",
    );
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    function finish(callback: () => void) {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    }
    function onAbort() {
      finish(() =>
        reject(
          new WalletFlowError("Creator handoff receipt check cancelled."),
        ),
      );
    }
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new WalletFlowError(
              `${options.label} timed out. The creator handoff remains pending-unknown.`,
            ),
          ),
        ),
      remaining,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    provider.request<T>(args).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function currentAccount(provider: Eip1193Provider, expected: Address) {
  const accounts = await provider.request<unknown>({ method: "eth_accounts" });
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !isAddress(accounts[0]) ||
    !sameAddress(accounts[0], expected)
  ) {
    throw new WalletFlowError(
      "The active wallet account changed. Reconnect and try again.",
    );
  }
}

async function assertSubmissionContext(
  provider: Eip1193Provider,
  expected: Address,
) {
  const [accounts, chainId] = await Promise.all([
    provider.request<unknown>({ method: "eth_accounts" }),
    provider.request<unknown>({ method: "eth_chainId" }),
  ]);
  if (
    typeof chainId !== "string" ||
    !isHexQuantity(chainId) ||
    BigInt(chainId) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    throw new WalletFlowError(
      "The active wallet chain changed. Switch back to Robinhood Chain.",
    );
  }
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !isAddress(accounts[0]) ||
    !sameAddress(accounts[0], expected)
  ) {
    throw new WalletFlowError(
      "The active wallet account changed. Reconnect and try again.",
    );
  }
}

function transactionReceipt(value: unknown): RpcTransactionReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletFlowError(
      "Independent RPC returned a malformed creator handoff receipt.",
    );
  }
  const receipt = value as Partial<RpcTransactionReceipt>;
  if (
    typeof receipt.transactionHash !== "string" ||
    !isTransactionHash(receipt.transactionHash) ||
    typeof receipt.blockHash !== "string" ||
    !isTransactionHash(receipt.blockHash) ||
    typeof receipt.blockNumber !== "string" ||
    !isHexQuantity(receipt.blockNumber) ||
    typeof receipt.status !== "string" ||
    !isHexQuantity(receipt.status) ||
    typeof receipt.from !== "string" ||
    !isAddress(receipt.from) ||
    (receipt.to !== null &&
      (typeof receipt.to !== "string" || !isAddress(receipt.to))) ||
    !Array.isArray(receipt.logs)
  ) {
    throw new WalletFlowError(
      "Independent RPC returned an incomplete creator handoff receipt.",
    );
  }
  return receipt as RpcTransactionReceipt;
}

function assertCanonicalCreatorHandoffTransaction(options: {
  transactionValue: unknown;
  blockValue: unknown;
  receipt: RpcTransactionReceipt;
  hash: Hex;
  account: Address;
  hook: Address;
  calldata: Hex;
}) {
  const {
    transactionValue,
    blockValue,
    receipt,
    hash,
    account,
    hook,
    calldata,
  } = options;
  if (
    !transactionValue ||
    typeof transactionValue !== "object" ||
    Array.isArray(transactionValue)
  ) {
    throw new WalletFlowError(
      "Canonical creator handoff transaction is malformed.",
    );
  }
  const transaction = transactionValue as {
    hash?: unknown;
    from?: unknown;
    to?: unknown;
    input?: unknown;
    value?: unknown;
    blockHash?: unknown;
    blockNumber?: unknown;
  };
  if (
    typeof transaction.hash !== "string" ||
    !isTransactionHash(transaction.hash) ||
    transaction.hash.toLowerCase() !== hash.toLowerCase() ||
    typeof transaction.from !== "string" ||
    !isAddress(transaction.from) ||
    !sameAddress(transaction.from, account) ||
    typeof transaction.to !== "string" ||
    !isAddress(transaction.to) ||
    !sameAddress(transaction.to, hook) ||
    typeof transaction.input !== "string" ||
    !isHexData(transaction.input) ||
    transaction.input.toLowerCase() !== calldata.toLowerCase() ||
    typeof transaction.value !== "string" ||
    !isHexQuantity(transaction.value) ||
    BigInt(transaction.value) !== BigInt(0) ||
    typeof transaction.blockHash !== "string" ||
    transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof transaction.blockNumber !== "string" ||
    transaction.blockNumber.toLowerCase() !== receipt.blockNumber.toLowerCase()
  ) {
    throw new WalletFlowError(
      "Canonical creator handoff calldata, value, sender, target, or block did not match the saved intent.",
    );
  }

  if (!blockValue || typeof blockValue !== "object" || Array.isArray(blockValue)) {
    throw new WalletFlowError("Canonical creator handoff block is malformed.");
  }
  const block = blockValue as {
    hash?: unknown;
    number?: unknown;
    transactions?: unknown;
  };
  if (
    typeof block.hash !== "string" ||
    !isTransactionHash(block.hash) ||
    block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof block.number !== "string" ||
    !isHexQuantity(block.number) ||
    BigInt(block.number) !== BigInt(receipt.blockNumber) ||
    !Array.isArray(block.transactions) ||
    !block.transactions.some(
      (transactionHash) =>
        typeof transactionHash === "string" &&
        isTransactionHash(transactionHash) &&
        transactionHash.toLowerCase() === hash.toLowerCase(),
    )
  ) {
    throw new WalletFlowError(
      "Creator handoff receipt block is not the canonical block containing the transaction.",
    );
  }
}

export class CreatorHandoffClient {
  readonly provider: Eip1193Provider;
  readonly manifest: AuditedDeploymentManifest;
  private readonly verify: MaintenanceVerifier;
  private readonly confirmationProvider: Eip1193Provider;

  constructor(
    provider: Eip1193Provider,
    manifest: AuditedDeploymentManifest,
    verify: MaintenanceVerifier = assertAuditedMaintenanceDeployment,
    dependencies: CreatorHandoffClientDependencies = {},
  ) {
    this.provider = createBoundedWalletProvider(
      provider,
      dependencies.walletRequestTimeoutMs,
    );
    this.manifest = manifest;
    this.verify = verify;
    this.confirmationProvider =
      dependencies.confirmationProvider ??
      createRobinhoodCreatorHandoffConfirmationProvider();
  }

  async readCreatorState(
    account: Address,
    poolId: Hex,
    indexedCurrentCreator: Address,
  ): Promise<CreatorHandoffState> {
    if (!sameAddress(account, indexedCurrentCreator)) {
      throw new WalletFlowError(
        "The connected wallet is not the freshly indexed current creator.",
      );
    }
    await currentAccount(this.provider, account);
    const snapshot = await this.verify(this.provider, this.manifest);
    const hook = this.manifest.contracts.hook.address;
    const configData = rpcData(
      await this.provider.request<unknown>({
        method: "eth_call",
        params: [
          {
            to: hook,
            data: encodeFunctionData({
              abi: CREATOR_HANDOFF_ABI,
              functionName: "poolConfigs",
              args: [poolId],
            }),
          },
          snapshot.blockTag,
        ],
      }),
      "Hook poolConfigs",
    );
    const [creator, , , , , , exists] = decodeFunctionResult({
      abi: CREATOR_HANDOFF_ABI,
      functionName: "poolConfigs",
      data: configData,
    });
    if (!exists) {
      throw new WalletFlowError("The indexed pool is not registered in the audited hook.");
    }
    if (!sameAddress(creator, indexedCurrentCreator)) {
      throw new WalletFlowError(
        "The fresh index and audited hook disagree about the current creator. Wait for reconciliation before handing off.",
      );
    }
    if (!sameAddress(creator, account)) {
      throw new WalletFlowError(
        "This wallet is no longer the current creator for that pool.",
      );
    }
    return {
      creator,
      blockNumber: snapshot.blockNumber,
      blockTag: snapshot.blockTag,
    };
  }

  async updateCreator(
    account: Address,
    poolId: Hex,
    indexedCurrentCreator: Address,
    newCreatorInput: string,
    callbacks: CreatorHandoffSubmissionCallbacks = {},
  ) {
    const newCreator = parseChecksummedCreatorAddress(
      newCreatorInput,
      indexedCurrentCreator,
    );
    await ensureRobinhoodChain(this.provider);
    const initial = await this.readCreatorState(
      account,
      poolId,
      indexedCurrentCreator,
    );
    const transaction = {
      from: account,
      to: this.manifest.contracts.hook.address,
      data: encodeFunctionData({
        abi: CREATOR_HANDOFF_ABI,
        functionName: "updateCreator",
        args: [poolId, newCreator],
      }),
      value: "0x0",
    } satisfies RpcTransactionRequest;

    try {
      const [simulation, estimate] = await Promise.all([
        this.provider.request<unknown>({
          method: "eth_call",
          params: [transaction, initial.blockTag],
        }),
        this.provider.request<unknown>({
          method: "eth_estimateGas",
          params: [transaction],
        }),
      ]);
      if (simulation !== "0x") {
        throw new WalletFlowError(
          "Creator handoff simulation returned unexpected data.",
        );
      }
      if (
        typeof estimate !== "string" ||
        !isHexQuantity(estimate) ||
        BigInt(estimate) === BigInt(0)
      ) {
        throw new WalletFlowError(
          "Creator handoff gas estimation returned a malformed quantity.",
        );
      }
    } catch (error) {
      if (error instanceof WalletFlowError) throw error;
      throw new WalletFlowError(
        `Creator handoff simulation failed: ${describeWalletError(error)}`,
      );
    }

    await ensureRobinhoodChain(this.provider);
    await this.readCreatorState(account, poolId, indexedCurrentCreator);
    // These are deliberately the final asynchronous checks. No cached manifest,
    // indexed eligibility, account, or chain result can authorize the prompt.
    await ensureRobinhoodChain(this.provider);
    await assertSubmissionContext(this.provider, account);
    callbacks.onSubmissionInvoked?.();
    try {
      const hash = await this.provider.request<unknown>({
        method: "eth_sendTransaction",
        params: [transaction],
      });
      if (typeof hash !== "string" || !isTransactionHash(hash)) {
        throw new CreatorHandoffSubmissionIndeterminateError(
          "The wallet may have broadcast the creator handoff but returned an invalid hash. Do not retry until wallet activity is reconciled.",
        );
      }
      callbacks.onSubmitted?.(hash);
      return { hash, oldCreator: account, newCreator };
    } catch (error) {
      if (explicitWalletRejection(error)) {
        throw new WalletFlowError(
          "You rejected the wallet request.",
          errorCode(error),
          error,
        );
      }
      if (isCreatorHandoffSubmissionIndeterminate(error)) throw error;
      throw new CreatorHandoffSubmissionIndeterminateError(
        "The wallet may have broadcast the creator handoff. Do not retry until wallet activity is reconciled.",
        errorCode(error),
        error,
      );
    }
  }

  async confirmCreatorHandoff(
    hash: Hex,
    expected: {
      account: Address;
      poolId: Hex;
      oldCreator: Address;
      newCreator: Address;
    },
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
    } = {},
  ) {
    if (!sameAddress(expected.account, expected.oldCreator)) {
      throw new WalletFlowError(
        "The saved handoff sender and old creator do not match.",
      );
    }
    const newCreator = parseChecksummedCreatorAddress(
      expected.newCreator,
      expected.oldCreator,
    );
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const started = Date.now();
    const deadlineAt = started + timeoutMs;
    const calldata = encodeFunctionData({
      abi: CREATOR_HANDOFF_ABI,
      functionName: "updateCreator",
      args: [expected.poolId, newCreator],
    });
    const confirmationChain = rpcQuantity(
      await boundedProviderRequest<unknown>(
        this.confirmationProvider,
        { method: "eth_chainId" },
        {
          signal: options.signal,
          deadlineAt,
          label: "Independent chain confirmation request",
        },
      ),
      "Independent confirmation chain ID",
    );
    if (BigInt(confirmationChain) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)) {
      throw new WalletFlowError(
        "Independent confirmation RPC is not on Robinhood Chain.",
      );
    }

    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) {
        throw new WalletFlowError("Creator handoff receipt check cancelled.");
      }
      const receipt = transactionReceipt(
        await boundedProviderRequest<unknown>(
          this.confirmationProvider,
          {
            method: "eth_getTransactionReceipt",
            params: [hash],
          },
          {
            signal: options.signal,
            deadlineAt,
            label: "Independent creator handoff receipt request",
          },
        ),
      );
      if (!receipt) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
        throw new WalletFlowError(
          "Independent RPC returned a receipt for a different transaction.",
        );
      }
      if (!sameAddress(receipt.from, expected.account)) {
        throw new WalletFlowError(
          "Creator handoff receipt sender does not match the saved creator.",
        );
      }
      if (
        !receipt.to ||
        !sameAddress(receipt.to, this.manifest.contracts.hook.address)
      ) {
        throw new WalletFlowError(
          "Creator handoff receipt target does not match the audited hook.",
        );
      }
      const receiptStatus = BigInt(receipt.status);
      if (receiptStatus !== BigInt(0) && receiptStatus !== BigInt(1)) {
        throw new WalletFlowError(
          "Creator handoff receipt returned an invalid status value.",
        );
      }

      const [transactionValue, blockValue, headValue] = await Promise.all([
        boundedProviderRequest<unknown>(
          this.confirmationProvider,
          { method: "eth_getTransactionByHash", params: [hash] },
          {
            signal: options.signal,
            deadlineAt,
            label: "Independent creator handoff transaction request",
          },
        ),
        boundedProviderRequest<unknown>(
          this.confirmationProvider,
          {
            method: "eth_getBlockByNumber",
            params: [receipt.blockNumber, false],
          },
          {
            signal: options.signal,
            deadlineAt,
            label: "Independent creator handoff block request",
          },
        ),
        boundedProviderRequest<unknown>(
          this.confirmationProvider,
          { method: "eth_blockNumber" },
          {
            signal: options.signal,
            deadlineAt,
            label: "Independent creator handoff head request",
          },
        ),
      ]);
      if (!transactionValue || !blockValue) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      assertCanonicalCreatorHandoffTransaction({
        transactionValue,
        blockValue,
        receipt,
        hash,
        account: expected.account,
        hook: this.manifest.contracts.hook.address,
        calldata,
      });
      const head = BigInt(
        rpcQuantity(headValue, "Independent confirmation head"),
      );
      const receiptBlock = BigInt(receipt.blockNumber);
      if (
        head < receiptBlock ||
        head - receiptBlock + BigInt(1) <
          CREATOR_HANDOFF_CONFIRMATION_BLOCKS
      ) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      if (receiptStatus === BigInt(0)) {
        throw new CanonicalCreatorHandoffRevertedError();
      }

      let updateEventCount = 0;
      let exactEventCount = 0;
      for (const log of receipt.logs) {
        if (
          !log ||
          typeof log !== "object" ||
          typeof log.address !== "string" ||
          !isAddress(log.address) ||
          !sameAddress(log.address, this.manifest.contracts.hook.address) ||
          !Array.isArray(log.topics) ||
          typeof log.topics[0] !== "string" ||
          log.topics[0].toLowerCase() !== CREATOR_UPDATED_TOPIC.toLowerCase()
        ) {
          continue;
        }
        updateEventCount += 1;
        if (
          typeof log.data !== "string" ||
          !isHexData(log.data) ||
          log.topics.some(
            (topic) => typeof topic !== "string" || !isHexData(topic),
          )
        ) {
          throw new WalletFlowError(
            "Confirmed receipt contains a malformed CreatorUpdated event.",
          );
        }
        try {
          const decoded = decodeEventLog({
            abi: CREATOR_HANDOFF_ABI,
            eventName: "CreatorUpdated",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
            strict: true,
          });
          if (
            decoded.args.poolId.toLowerCase() ===
              expected.poolId.toLowerCase() &&
            sameAddress(decoded.args.oldCreator, expected.oldCreator) &&
            sameAddress(decoded.args.newCreator, newCreator)
          ) {
            exactEventCount += 1;
          }
        } catch (error) {
          throw new WalletFlowError(
            "Confirmed receipt contains an undecodable CreatorUpdated event.",
            undefined,
            error,
          );
        }
      }
      if (updateEventCount !== 1 || exactEventCount !== 1) {
        throw new WalletFlowError(
          "Confirmed receipt does not contain exactly the saved CreatorUpdated event.",
        );
      }
      return {
        receipt,
        oldCreator: expected.oldCreator,
        newCreator,
      };
    }
    throw new WalletFlowError(
      "The creator handoff is still pending. Check the explorer before trying again.",
    );
  }
}
