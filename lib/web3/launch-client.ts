import {
  decodeAddress,
  decodeBool,
  decodeLaunchConfig,
  decodeLaunchResult,
  decodeMineSaltResult,
  decodeUint,
  encodeAllowanceCall,
  encodeApproveCall,
  encodeBalanceOfCall,
  encodeGetLaunchConfigCall,
  encodeLaunchCall,
  encodeLaunchEnabledCall,
  encodeLaunchFeeCall,
  encodeMineSaltCall,
  encodeQuoteTokenCall,
  type FactoryLaunchConfig,
  type FactoryTokenParams,
} from "./abi";
import {
  PIPEDOG_ADDRESS,
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_PUBLIC_RPC_URL,
  ROBINHOOD_WALLET_CHAIN,
  robinhoodWalletAddChainParameters,
} from "./robinhood";
import {
  assertAuditedDeployment,
  DeploymentIntegrityError,
  type AuditedDeploymentManifest,
} from "./deployment-manifest";
import {
  assertAddress,
  isAddress,
  isHexData,
  isHexQuantity,
  isTransactionHash,
  sameAddress,
  type Address,
  type Eip1193RequestArguments,
  type Eip1193Provider,
  type Hex,
  type RpcTransactionReceipt,
  type RpcTransactionRequest,
} from "./types";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_POOL_ID = `0x${"00".repeat(32)}` as Hex;
const LAUNCH_CONFIRMATION_BLOCKS = BigInt(2);
const TOKEN_POOL_ID_CALL = "0x3e0dc34e" as Hex;
const FIRST_BUY_SLIPPAGE_SELECTOR = "0x7cc1d120";
const Q96 = BigInt(1) << BigInt(96);
const MAX_UINT128 = (BigInt(1) << BigInt(128)) - BigInt(1);
const MAX_INT128 = (BigInt(1) << BigInt(127)) - BigInt(1);
const MAX_UINT160 = (BigInt(1) << BigInt(160)) - BigInt(1);
const MAX_UINT256 = (BigInt(1) << BigInt(256)) - BigInt(1);
const MIN_TICK = -887_272;
const MAX_TICK = 887_272;
const FEE_DENOMINATOR = BigInt(1_000_000);
const BASIS_POINTS = BigInt(10_000);

export const MIN_FIRST_BUY_SLIPPAGE_BPS = 50;
export const MAX_FIRST_BUY_SLIPPAGE_BPS = 500;
export const FIRST_BUY_QUOTE_TTL_MS = 30_000;
// Client-side drift bound only. LaypipeFactory.launch has no deadline field, so
// this cannot and must not be presented as an on-chain transaction deadline.
export const FIRST_BUY_QUOTE_BLOCK_BUDGET = BigInt(600);

const TICK_RATIOS = [
  BigInt("0xfffcb933bd6fad37aa2d162d1a594001"),
  BigInt("0xfff97272373d413259a46990580e213a"),
  BigInt("0xfff2e50f5f656932ef12357cf3c7fdcc"),
  BigInt("0xffe5caca7e10e4e61c3624eaa0941cd0"),
  BigInt("0xffcb9843d60f6159c9db58835c926644"),
  BigInt("0xff973b41fa98c081472e6896dfb254c0"),
  BigInt("0xff2ea16466c96a3843ec78b326b52861"),
  BigInt("0xfe5dee046a99a2a811c461f1969c3053"),
  BigInt("0xfcbe86c7900a88aedcffc83b479aa3a4"),
  BigInt("0xf987a7253ac413176f2b074cf7815e54"),
  BigInt("0xf3392b0822b70005940c7a398e4b70f3"),
  BigInt("0xe7159475a2c29b7443b29c7fa6e889d9"),
  BigInt("0xd097f3bdfd2022b8845ad8f792aa5825"),
  BigInt("0xa9f746462d870fdf8a65dc1f90e061e5"),
  BigInt("0x70d869a156d2a1b890bb3df62baf32f7"),
  BigInt("0x31be135f97d08fd981231505542fcfa6"),
  BigInt("0x9aa508b5b7a84e1c677de54f3e99bc9"),
  BigInt("0x5d6af8dedb81196699c329225ee604"),
  BigInt("0x2216e584f5fa1ea926041bedfe98"),
  BigInt("0x48a170391f7dc42444e8fa2"),
] as const;
export const TOKEN_LAUNCHED_TOPIC =
  "0x17091df68f499cf4e20dcfc5d42f064dd22359e785b77691c4c4ed0322608897";

export interface FactoryPreflight {
  blockNumber: bigint;
  blockTag: Hex;
  launchFee: bigint;
  launchEnabled: boolean;
  quoteToken: Address;
  launchConfig: FactoryLaunchConfig;
  allowance: bigint;
  pipedogBalance: bigint;
}

export interface LaunchCallInput {
  params: FactoryTokenParams;
  configId: bigint;
  firstBuyIn: bigint;
  firstBuyMinOut: bigint;
  salt: Hex;
}

export interface ExactApprovalPlan {
  currentAllowance: bigint;
  requiredAllowance: bigint;
  steps: Array<{
    kind: "reset" | "approve-exact";
    amount: bigint;
    label: string;
  }>;
}

export interface ConfirmedLaunch {
  receipt: RpcTransactionReceipt;
  token: Address;
  poolId: Hex;
}

export interface FirstBuyQuote {
  owner: Address;
  predictedToken: Address;
  inputIdentityCalldata: Hex;
  expectedOutput: bigint;
  minimumOutput: bigint;
  slippageBps: number;
  verifiedBlockNumber: bigint;
  maxSubmissionBlock: bigint;
  createdAtMs: number;
  expiresAtMs: number;
}

type DeploymentVerifier = typeof assertAuditedDeployment;

export interface LaunchClientDependencies {
  confirmationProvider?: Eip1193Provider;
  verifyDeployment?: DeploymentVerifier;
  now?: () => number;
}

export interface LaunchSubmissionCallbacks {
  onSubmissionInvoked?: () => void | Promise<void>;
  onSubmitted?: (hash: Hex) => void | Promise<void>;
  firstBuyQuote?: FirstBuyQuote;
  predictedToken?: Address;
}

export interface LaunchConfirmationOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export class WalletFlowError extends Error {
  readonly code?: number | string;
  readonly causeData?: unknown;

  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message);
    this.name = "WalletFlowError";
    this.code = code;
    this.causeData = causeData;
  }
}

export class LaunchSubmissionIndeterminateError extends WalletFlowError {
  constructor(message: string, code?: number | string, causeData?: unknown) {
    super(message, code, causeData);
    this.name = "LaunchSubmissionIndeterminateError";
  }
}

export class CanonicalTransactionRevertedError extends WalletFlowError {
  constructor(message = "The transaction reverted on-chain.") {
    super(message);
    this.name = "CanonicalTransactionRevertedError";
  }
}

export function isLaunchSubmissionIndeterminate(error: unknown) {
  return error instanceof LaunchSubmissionIndeterminateError;
}

export function isCanonicalTransactionReverted(error: unknown) {
  return error instanceof CanonicalTransactionRevertedError;
}

function unknownErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" || typeof code === "string" ? code : undefined;
}

function explicitWalletRejection(error: unknown) {
  const code = unknownErrorCode(error);
  return code === 4001 || code === "4001";
}

function unknownErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The wallet could not complete that request.";
}

export function describeWalletError(error: unknown) {
  const code = unknownErrorCode(error);
  if (code === 4001 || code === "4001") return "You rejected the wallet request.";
  if (code === -32002 || code === "-32002") {
    return "A wallet request is already open. Finish it in your wallet and try again.";
  }

  const message = unknownErrorMessage(error);
  if (/insufficient funds/i.test(message)) {
    return "The wallet does not have enough ETH on Robinhood Chain for gas.";
  }
  if (/user rejected|denied transaction|cancelled/i.test(message)) {
    return "You rejected the wallet request.";
  }
  if (/allowance/i.test(message)) {
    return "The PIPEDOG allowance is no longer exact. Refresh it before launching.";
  }
  if (/slippage|minimum.*out/i.test(message)) {
    return "The first-buy quote moved beyond your minimum. Prepare a fresh quote.";
  }
  if (/paused|LaunchPaused/i.test(message)) {
    return "New launches are currently paused by the factory owner.";
  }
  return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

function assertRpcData(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexData(value)) {
    throw new WalletFlowError(`${label} returned malformed RPC data.`);
  }
  return value;
}

function assertRpcQuantity(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexQuantity(value)) {
    throw new WalletFlowError(`${label} returned a malformed RPC quantity.`);
  }
  return value;
}

export function createRobinhoodLaunchConfirmationProvider(
  fetcher: typeof fetch = fetch,
): Eip1193Provider {
  let requestId = 0;
  return {
    async request<T>(args: Eip1193RequestArguments) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
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
            payload.error.message ?? "Independent Robinhood RPC request failed.",
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
        clearTimeout(timeout);
      }
    },
  };
}

async function assertSubmissionContext(
  provider: Eip1193Provider,
  expectedOwner: Address,
  options: {
    quote?: FirstBuyQuote;
    minimumBlockNumber?: bigint;
    now?: () => number;
  } = {},
) {
  const { quote, minimumBlockNumber, now = Date.now } = options;
  const [accounts, chainId, blockNumber] = await Promise.all([
    provider.request<unknown>({ method: "eth_accounts" }),
    provider.request<unknown>({ method: "eth_chainId" }),
    quote || minimumBlockNumber !== undefined
      ? provider.request<unknown>({ method: "eth_blockNumber" })
      : Promise.resolve<unknown>(undefined),
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
    !sameAddress(accounts[0], expectedOwner)
  ) {
    throw new WalletFlowError(
      "The active wallet account changed. Reconnect and try again.",
    );
  }
  if (quote || minimumBlockNumber !== undefined) {
    const latestBlock = BigInt(
      assertRpcQuantity(blockNumber, "Latest submission block"),
    );
    if (
      minimumBlockNumber !== undefined &&
      latestBlock < minimumBlockNumber
    ) {
      throw new WalletFlowError(
        "Wallet RPC regressed behind the final audited launch snapshot.",
      );
    }
    if (quote) assertFirstBuyQuoteTiming(quote, latestBlock, now());
  }
}

function transactionReceipt(value: unknown): RpcTransactionReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WalletFlowError(
      "Independent RPC returned a malformed transaction receipt.",
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
      "Independent RPC returned an incomplete transaction receipt.",
    );
  }
  return receipt as RpcTransactionReceipt;
}

function assertCanonicalTransaction(options: {
  transactionValue: unknown;
  blockValue: unknown;
  receipt: RpcTransactionReceipt;
  hash: Hex;
  owner: Address;
  target: Address;
  calldata: Hex;
}) {
  const { transactionValue, blockValue, receipt, hash, owner, target, calldata } =
    options;
  if (
    !transactionValue ||
    typeof transactionValue !== "object" ||
    Array.isArray(transactionValue)
  ) {
    throw new WalletFlowError("Canonical transaction is malformed.");
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
    !sameAddress(transaction.from, owner) ||
    typeof transaction.to !== "string" ||
    !isAddress(transaction.to) ||
    !sameAddress(transaction.to, target) ||
    typeof transaction.input !== "string" ||
    !isHexData(transaction.input) ||
    transaction.input.toLowerCase() !== calldata.toLowerCase() ||
    typeof transaction.value !== "string" ||
    !isHexQuantity(transaction.value) ||
    BigInt(transaction.value) !== BigInt(0) ||
    typeof transaction.blockHash !== "string" ||
    transaction.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    typeof transaction.blockNumber !== "string" ||
    !isHexQuantity(transaction.blockNumber) ||
    BigInt(transaction.blockNumber) !== BigInt(receipt.blockNumber)
  ) {
    throw new WalletFlowError(
      "Canonical transaction input, value, sender, target, or block did not match the submitted intent.",
    );
  }

  if (!blockValue || typeof blockValue !== "object" || Array.isArray(blockValue)) {
    throw new WalletFlowError("Canonical transaction block is malformed.");
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
      "Receipt block is not the canonical block containing the transaction.",
    );
  }
}

export function getInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  return ethereum?.request ? ethereum : null;
}

export function subscribeToWalletContext(
  provider: Eip1193Provider,
  onContextChanged: () => void,
) {
  if (!provider.on) return () => undefined;
  provider.on("accountsChanged", onContextChanged);
  provider.on("chainChanged", onContextChanged);
  return () => {
    provider.removeListener?.("accountsChanged", onContextChanged);
    provider.removeListener?.("chainChanged", onContextChanged);
  };
}

export async function connectInjectedWallet(provider: Eip1193Provider) {
  try {
    const accounts = await provider.request<unknown>({ method: "eth_requestAccounts" });
    if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
      throw new WalletFlowError("The wallet did not return an account.");
    }
    return assertAddress(accounts[0], "Connected wallet");
  } catch (error) {
    if (error instanceof WalletFlowError) throw error;
    throw new WalletFlowError(
      describeWalletError(error),
      unknownErrorCode(error),
      error,
    );
  }
}

export async function ensureRobinhoodChain(provider: Eip1193Provider) {
  const chainId = await provider.request<unknown>({ method: "eth_chainId" });
  if (
    typeof chainId === "string" &&
    isHexQuantity(chainId) &&
    BigInt(chainId) === BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ROBINHOOD_CHAIN_ID_HEX }],
    });
  } catch (error) {
    const code = unknownErrorCode(error);
    if (code !== 4902 && code !== "4902") {
      throw new WalletFlowError(
        describeWalletError(error),
        code,
        error,
      );
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [robinhoodWalletAddChainParameters(ROBINHOOD_WALLET_CHAIN)],
    });
  }

  const selectedChain = await provider.request<unknown>({ method: "eth_chainId" });
  if (
    typeof selectedChain !== "string" ||
    !isHexQuantity(selectedChain) ||
    BigInt(selectedChain) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    throw new WalletFlowError("Switch your wallet to Robinhood Chain to continue.");
  }
}

export function buildExactApprovalPlan(
  currentAllowance: bigint,
  requiredAllowance: bigint,
): ExactApprovalPlan {
  if (currentAllowance < BigInt(0) || requiredAllowance < BigInt(0)) {
    throw new Error("Allowances cannot be negative.");
  }
  if (currentAllowance === requiredAllowance) {
    return { currentAllowance, requiredAllowance, steps: [] };
  }
  if (currentAllowance === BigInt(0)) {
    return {
      currentAllowance,
      requiredAllowance,
      steps:
        requiredAllowance === BigInt(0)
          ? []
          : [
              {
                kind: "approve-exact",
                amount: requiredAllowance,
                label: "Approve exact PIPEDOG amount",
              },
            ],
    };
  }

  return {
    currentAllowance,
    requiredAllowance,
    steps: [
      { kind: "reset", amount: BigInt(0), label: "Reset stale PIPEDOG allowance" },
      ...(requiredAllowance === BigInt(0)
        ? []
        : [
            {
              kind: "approve-exact" as const,
              amount: requiredAllowance,
              label: "Approve exact PIPEDOG amount",
            },
          ]),
    ],
  };
}

export function approvalCalldata(factory: Address, amount: bigint) {
  return encodeApproveCall(factory, amount);
}

export function launchCalldata(input: LaunchCallInput) {
  return encodeLaunchCall(input);
}

export function assertLaunchPreflight(options: {
  preflight: FactoryPreflight;
  expectedSelfBurn: boolean;
  firstBuyIn: bigint;
  expectedQuoteToken?: Address;
}) {
  const { preflight, expectedSelfBurn, firstBuyIn } = options;
  const expectedQuoteToken = options.expectedQuoteToken ?? PIPEDOG_ADDRESS;
  if (!sameAddress(preflight.quoteToken, expectedQuoteToken)) {
    throw new WalletFlowError(
      "Factory quote token does not match canonical PIPEDOG. Launch blocked.",
    );
  }
  if (!preflight.launchEnabled) {
    throw new WalletFlowError("New launches are currently paused.");
  }
  if (!preflight.launchConfig.enabled) {
    throw new WalletFlowError("This launch mode is currently disabled.");
  }
  if (preflight.launchConfig.selfBurn !== expectedSelfBurn) {
    throw new WalletFlowError("The selected fee mode does not match its on-chain config.");
  }

  if (firstBuyIn < BigInt(0)) {
    throw new WalletFlowError("First-buy input cannot be negative.");
  }
  if (preflight.launchFee > MAX_UINT256 - firstBuyIn) {
    throw new WalletFlowError("Launch fee plus first buy exceeds uint256.");
  }
  const requiredAllowance = preflight.launchFee + firstBuyIn;
  if (preflight.pipedogBalance < requiredAllowance) {
    throw new WalletFlowError(
      "The connected wallet does not have enough PIPEDOG for the launch fee and first buy.",
    );
  }

  return {
    requiredAllowance,
    approvalPlan: buildExactApprovalPlan(preflight.allowance, requiredAllowance),
  };
}

export function assertFirstBuyAmounts(firstBuyIn: bigint, firstBuyMinOut: bigint) {
  if (firstBuyIn < BigInt(0) || firstBuyMinOut < BigInt(0)) {
    throw new WalletFlowError("First-buy amounts cannot be negative.");
  }
  if (firstBuyIn > BigInt(0) && firstBuyMinOut === BigInt(0)) {
    throw new WalletFlowError(
      "A non-zero first buy requires a non-zero minimum token output.",
    );
  }
  if (firstBuyIn === BigInt(0) && firstBuyMinOut !== BigInt(0)) {
    throw new WalletFlowError(
      "Minimum token output must be zero when the first buy is zero.",
    );
  }
}

export function assertFirstBuySlippageBps(slippageBps: number) {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < MIN_FIRST_BUY_SLIPPAGE_BPS ||
    slippageBps > MAX_FIRST_BUY_SLIPPAGE_BPS
  ) {
    throw new WalletFlowError(
      "First-buy slippage must be between 0.5% and 5% in 0.01% increments.",
    );
  }
  return slippageBps;
}

export function applyFirstBuySlippage(output: bigint, slippageBps: number) {
  assertFirstBuySlippageBps(slippageBps);
  if (output <= BigInt(0)) {
    throw new WalletFlowError("The first-buy quote returned no launched tokens.");
  }
  const minimumOutput =
    (output * (BASIS_POINTS - BigInt(slippageBps))) / BASIS_POINTS;
  if (minimumOutput <= BigInt(0)) {
    throw new WalletFlowError(
      "The first buy is too small to protect with this slippage setting.",
    );
  }
  return minimumOutput;
}

function divRoundingUp(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) {
    throw new WalletFlowError("First-buy quote division is undefined.");
  }
  return numerator / denominator +
    (numerator % denominator === BigInt(0) ? BigInt(0) : BigInt(1));
}

function mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint) {
  return divRoundingUp(a * b, denominator);
}

function sqrtPriceAtTick(tick: number) {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) {
    throw new WalletFlowError("Launch start tick is outside the Uniswap range.");
  }
  const absoluteTick = Math.abs(tick);
  let ratio =
    absoluteTick & 1 ? TICK_RATIOS[0] : BigInt(1) << BigInt(128);
  for (let bit = 1; bit < TICK_RATIOS.length; bit += 1) {
    if (absoluteTick & (1 << bit)) {
      ratio = (ratio * TICK_RATIOS[bit]!) >> BigInt(128);
    }
  }
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  const remainderMask = (BigInt(1) << BigInt(32)) - BigInt(1);
  const sqrtPrice =
    (ratio >> BigInt(32)) +
    (ratio & remainderMask ? BigInt(1) : BigInt(0));
  if (sqrtPrice <= BigInt(0) || sqrtPrice > MAX_UINT160) {
    throw new WalletFlowError("Launch start price is outside uint160.");
  }
  return sqrtPrice;
}

function amount0Delta(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
  roundUp: boolean,
) {
  let lower = sqrtPriceA;
  let upper = sqrtPriceB;
  if (lower > upper) [lower, upper] = [upper, lower];
  if (lower <= BigInt(0)) {
    throw new WalletFlowError("Launch curve has an invalid lower price.");
  }
  const numerator1 = liquidity << BigInt(96);
  const numerator2 = upper - lower;
  return roundUp
    ? divRoundingUp(
        mulDivRoundingUp(numerator1, numerator2, upper),
        lower,
      )
    : (numerator1 * numerator2) / upper / lower;
}

function amount1Delta(
  sqrtPriceA: bigint,
  sqrtPriceB: bigint,
  liquidity: bigint,
) {
  const difference =
    sqrtPriceA >= sqrtPriceB
      ? sqrtPriceA - sqrtPriceB
      : sqrtPriceB - sqrtPriceA;
  return (liquidity * difference) / Q96;
}

function nextSqrtFromAmount0Input(
  sqrtPrice: bigint,
  liquidity: bigint,
  amount0: bigint,
) {
  if (amount0 === BigInt(0)) return sqrtPrice;
  const numerator1 = liquidity << BigInt(96);
  const product = amount0 * sqrtPrice;
  if (product <= MAX_UINT256) {
    const denominator = numerator1 + product;
    if (denominator <= MAX_UINT256 && denominator >= numerator1) {
      return mulDivRoundingUp(numerator1, sqrtPrice, denominator);
    }
  }
  return divRoundingUp(numerator1, numerator1 / sqrtPrice + amount0);
}

/**
 * Mirrors the exact integer path used by LaypipeFactory._seedLiquidity,
 * PipedogHook's exempt first-buy fee, and Uniswap v4's one-step exact-input
 * swap. prepareFirstBuyQuote independently proves the result against the full
 * factory call at one pinned block before this value is trusted.
 */
export function quoteInitialFirstBuy(options: {
  config: FactoryLaunchConfig;
  firstBuyIn: bigint;
}) {
  const { config, firstBuyIn } = options;
  if (firstBuyIn <= BigInt(0)) {
    throw new WalletFlowError("A first-buy quote requires a positive PIPEDOG amount.");
  }
  if (firstBuyIn > MAX_INT128) {
    throw new WalletFlowError("First-buy input exceeds the conservative swap limit.");
  }
  if (
    config.supply <= BigInt(0) ||
    !Number.isInteger(config.tickSpacing) ||
    config.tickSpacing <= 0 ||
    !Number.isInteger(config.startTick) ||
    config.startTick % config.tickSpacing !== 0 ||
    !Number.isInteger(config.baseFeeRate) ||
    config.baseFeeRate < 0 ||
    config.baseFeeRate >= Number(FEE_DENOMINATOR)
  ) {
    throw new WalletFlowError("Launch config cannot produce a trusted first-buy quote.");
  }

  const minimumTick = Math.ceil(MIN_TICK / config.tickSpacing) * config.tickSpacing;
  if (config.startTick <= minimumTick || config.startTick > MAX_TICK) {
    throw new WalletFlowError("Launch config has an invalid one-sided tick range.");
  }
  const sqrtLower = sqrtPriceAtTick(minimumTick);
  const sqrtStart = sqrtPriceAtTick(config.startTick);
  const liquidity =
    (config.supply * Q96) / (sqrtStart - sqrtLower);
  if (liquidity <= BigInt(0) || liquidity > MAX_UINT128 || liquidity > MAX_INT128) {
    throw new WalletFlowError("Launch liquidity is outside the factory range.");
  }

  const hookFee =
    (firstBuyIn * BigInt(config.baseFeeRate)) / FEE_DENOMINATOR;
  const poolInput = firstBuyIn - hookFee;
  if (poolInput <= BigInt(0)) {
    throw new WalletFlowError("The first-buy fee leaves no PIPEDOG for the pool.");
  }
  const curveCapacity = amount0Delta(
    sqrtLower,
    sqrtStart,
    liquidity,
    true,
  );
  if (poolInput > curveCapacity) {
    throw new WalletFlowError(
      "The first buy exceeds the launch curve and would be rejected as a partial fill.",
    );
  }
  const sqrtAfter =
    poolInput === curveCapacity
      ? sqrtLower
      : nextSqrtFromAmount0Input(sqrtStart, liquidity, poolInput);
  const expectedOutput = amount1Delta(sqrtAfter, sqrtStart, liquidity);
  if (
    expectedOutput <= BigInt(0) ||
    expectedOutput > config.supply ||
    expectedOutput > MAX_INT128
  ) {
    throw new WalletFlowError("The first-buy curve quote returned an invalid output.");
  }
  return {
    expectedOutput,
    hookFee,
    poolInput,
    liquidity,
    sqrtAfter,
  };
}

function launchInputIdentityCalldata(input: LaunchCallInput) {
  return encodeLaunchCall({ ...input, firstBuyMinOut: BigInt(0) });
}

function containsExactRevertSelector(error: unknown, selector: string) {
  const visited = new Set<unknown>();
  function inspect(value: unknown, depth: number): boolean {
    if (depth > 8 || value === null || value === undefined || visited.has(value)) {
      return false;
    }
    if (typeof value === "string") {
      return value.toLowerCase() === selector.toLowerCase();
    }
    if (typeof value !== "object") return false;
    visited.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      try {
        const candidate = (value as Record<string, unknown>)[key];
        if (inspect(candidate, depth + 1)) return true;
      } catch {
        // Hostile/non-standard provider getters are ignored; missing an exact
        // selector fails the quote proof closed below.
      }
    }
    return false;
  }
  return inspect(error, 0);
}

export function assertFirstBuyQuoteForInput(options: {
  quote: FirstBuyQuote;
  owner: Address;
  predictedToken: Address;
  input: LaunchCallInput;
  config: FactoryLaunchConfig;
  latestBlock: bigint;
  nowMs: number;
}) {
  const { quote, owner, predictedToken, input, config, latestBlock, nowMs } =
    options;
  if (input.firstBuyIn <= BigInt(0)) {
    throw new WalletFlowError("A first-buy quote cannot authorize a zero-value buy.");
  }
  if (!sameAddress(quote.owner, owner)) {
    throw new WalletFlowError("First-buy quote belongs to a different wallet.");
  }
  if (!sameAddress(quote.predictedToken, predictedToken)) {
    throw new WalletFlowError("First-buy quote belongs to a different predicted token.");
  }
  if (
    quote.inputIdentityCalldata.toLowerCase() !==
    launchInputIdentityCalldata(input).toLowerCase()
  ) {
    throw new WalletFlowError("First-buy quote launch identity was modified.");
  }
  const local = quoteInitialFirstBuy({ config, firstBuyIn: input.firstBuyIn });
  if (quote.expectedOutput !== local.expectedOutput) {
    throw new WalletFlowError("First-buy expected output no longer matches the launch config.");
  }
  const minimumOutput = applyFirstBuySlippage(
    quote.expectedOutput,
    quote.slippageBps,
  );
  if (
    quote.minimumOutput !== minimumOutput ||
    input.firstBuyMinOut !== minimumOutput
  ) {
    throw new WalletFlowError("First-buy minimum output was modified.");
  }
  assertFirstBuyQuoteTiming(quote, latestBlock, nowMs);
}

export function assertFirstBuyQuoteTiming(
  quote: FirstBuyQuote,
  latestBlock: bigint,
  nowMs: number,
) {
  if (
    !Number.isSafeInteger(quote.createdAtMs) ||
    !Number.isSafeInteger(quote.expiresAtMs) ||
    quote.expiresAtMs !== quote.createdAtMs + FIRST_BUY_QUOTE_TTL_MS ||
    quote.createdAtMs > nowMs
  ) {
    throw new WalletFlowError("First-buy quote timing fields are invalid.");
  }
  if (nowMs > quote.expiresAtMs) {
    throw new WalletFlowError("The first-buy quote expired. Prepare it again.");
  }
  if (latestBlock < quote.verifiedBlockNumber) {
    throw new WalletFlowError("Wallet RPC returned an older block than the first-buy quote.");
  }
  if (
    quote.maxSubmissionBlock !==
    quote.verifiedBlockNumber + FIRST_BUY_QUOTE_BLOCK_BUDGET
  ) {
    throw new WalletFlowError("First-buy quote block bounds were modified.");
  }
  if (latestBlock > quote.maxSubmissionBlock) {
    throw new WalletFlowError("The first-buy quote exceeded its client block-drift bound.");
  }
}

function indexedAddress(topic: unknown, label: string) {
  if (
    typeof topic !== "string" ||
    !isTransactionHash(topic) ||
    topic.slice(2, 26) !== "0".repeat(24)
  ) {
    throw new WalletFlowError(`${label} contained an invalid indexed address.`);
  }
  return assertAddress(`0x${topic.slice(-40)}`, label);
}

function eventWord(data: Hex, index: number) {
  const start = 2 + index * 64;
  return `0x${data.slice(start, start + 64)}` as Hex;
}

function eventAddress(data: Hex, index: number, label: string) {
  const word = eventWord(data, index);
  if (word.slice(2, 26) !== "0".repeat(24)) {
    throw new WalletFlowError(`${label} contained an invalid address word.`);
  }
  return assertAddress(`0x${word.slice(-40)}`, label);
}

function launchedTokenFromReceipt(
  receipt: RpcTransactionReceipt,
  factoryAddress: Address,
  expected: {
    creator: Address;
    predictedToken: Address;
    input: LaunchCallInput;
  },
  manifest: AuditedDeploymentManifest | null,
) {
  const launchLogs = receipt.logs.filter(
    (log) =>
      log &&
      typeof log === "object" &&
      typeof log.address === "string" &&
      isAddress(log.address) &&
      sameAddress(log.address, factoryAddress) &&
      Array.isArray(log.topics) &&
      typeof log.topics[0] === "string" &&
      log.topics[0].toLowerCase() === TOKEN_LAUNCHED_TOPIC,
  );
  if (launchLogs.length !== 1) {
    throw new WalletFlowError(
      "Launch receipt must contain exactly one TokenLaunched event from the audited factory.",
    );
  }
  const launchLog = launchLogs[0];
  if (
    launchLog.topics.length !== 4 ||
    typeof launchLog.data !== "string" ||
    !isHexData(launchLog.data) ||
    launchLog.data.length !== 2 + 64 * 5
  ) {
    throw new WalletFlowError("TokenLaunched event encoding is malformed.");
  }
  const token = indexedAddress(launchLog.topics[1], "Launched token");
  const creator = indexedAddress(launchLog.topics[2], "Launch creator");
  const poolId = launchLog.topics[3];
  if (!isTransactionHash(poolId) || poolId.toLowerCase() === ZERO_POOL_ID) {
    throw new WalletFlowError("Launch receipt contained an invalid pool ID.");
  }
  if (!sameAddress(token, expected.predictedToken)) {
    throw new WalletFlowError(
      "Launch receipt token does not match the mined prediction.",
    );
  }
  if (!sameAddress(creator, expected.creator)) {
    throw new WalletFlowError(
      "Launch event creator does not match the submitting wallet.",
    );
  }

  const configId = BigInt(eventWord(launchLog.data, 0));
  const firstBuyIn = BigInt(eventWord(launchLog.data, 1));
  const firstBuyOut = BigInt(eventWord(launchLog.data, 2));
  if (
    configId !== expected.input.configId ||
    firstBuyIn !== expected.input.firstBuyIn ||
    firstBuyOut < expected.input.firstBuyMinOut
  ) {
    throw new WalletFlowError(
      "TokenLaunched config or first-buy values do not match the submitted launch.",
    );
  }
  if (firstBuyIn === BigInt(0) && firstBuyOut !== BigInt(0)) {
    throw new WalletFlowError(
      "TokenLaunched reported output for a zero-value first buy.",
    );
  }

  if (manifest) {
    const hook = eventAddress(launchLog.data, 3, "Launch hook");
    const feeRecipient = eventAddress(
      launchLog.data,
      4,
      "Launch fee recipient",
    );
    if (!sameAddress(hook, manifest.contracts.hook.address)) {
      throw new WalletFlowError(
        "TokenLaunched hook does not match the configured release deployment.",
      );
    }
    const config = [manifest.launch.creator, manifest.launch.selfBurn].find(
      (candidate) => candidate.id === expected.input.configId,
    );
    if (!config) {
      throw new WalletFlowError(
        "TokenLaunched config is not present in the configured release deployment.",
      );
    }
    const expectedFeeRecipient = config.config.selfBurn
      ? manifest.contracts.selfBurner.address
      : expected.creator;
    if (!sameAddress(feeRecipient, expectedFeeRecipient)) {
      throw new WalletFlowError(
        "TokenLaunched fee recipient does not match the audited launch mode.",
      );
    }
  }

  return {
    token,
    poolId,
  };
}

export class LaypipeLaunchClient {
  readonly provider: Eip1193Provider;
  readonly factoryAddress: Address;
  readonly quoteTokenAddress: Address;
  readonly auditedManifest: AuditedDeploymentManifest | null;
  private readonly verifyDeployment: DeploymentVerifier;
  private readonly confirmationProvider: Eip1193Provider;
  private readonly now: () => number;

  constructor(
    provider: Eip1193Provider,
    deployment: Address | AuditedDeploymentManifest,
    dependencies: LaunchClientDependencies = {},
  ) {
    this.provider = provider;
    this.verifyDeployment =
      dependencies.verifyDeployment ?? assertAuditedDeployment;
    this.confirmationProvider =
      dependencies.confirmationProvider ??
      createRobinhoodLaunchConfirmationProvider();
    this.now = dependencies.now ?? Date.now;
    if (typeof deployment === "string") {
      this.factoryAddress = assertAddress(deployment, "Factory address");
      this.quoteTokenAddress = PIPEDOG_ADDRESS;
      this.auditedManifest = null;
    } else {
      this.factoryAddress = assertAddress(
        deployment.contracts.factoryProxy.address,
        "Factory address",
      );
      this.quoteTokenAddress = assertAddress(
        deployment.contracts.pipedog.address,
        "Quote token address",
      );
      this.auditedManifest = deployment;
    }
  }

  async verifyAuditedDeployment() {
    if (!this.auditedManifest) {
      throw new DeploymentIntegrityError(
        "The configured release manifest is not loaded. Wallet mutations are blocked.",
      );
    }
    return this.verifyDeployment(this.provider, this.auditedManifest);
  }

  private async call(
    to: Address,
    data: Hex,
    from?: Address,
    blockTag: Hex | "latest" = "latest",
  ) {
    const result = await this.provider.request<unknown>({
      method: "eth_call",
      params: [{ to, data, ...(from ? { from } : {}) }, blockTag],
    });
    return assertRpcData(result, "Contract read");
  }

  async readPreflight(
    owner: Address,
    configId: bigint,
  ): Promise<FactoryPreflight> {
    const deployment = await this.verifyAuditedDeployment();
    const { blockNumber, blockTag } = deployment;
    const [
      launchFeeResult,
      launchEnabledResult,
      quoteTokenResult,
      configResult,
    ] = await Promise.all([
      this.call(this.factoryAddress, encodeLaunchFeeCall(), undefined, blockTag),
      this.call(this.factoryAddress, encodeLaunchEnabledCall(), undefined, blockTag),
      this.call(this.factoryAddress, encodeQuoteTokenCall(), undefined, blockTag),
      this.call(
        this.factoryAddress,
        encodeGetLaunchConfigCall(configId),
        undefined,
        blockTag,
      ),
    ]);
    const quoteToken = decodeAddress(quoteTokenResult);
    const [allowanceResult, balanceResult] = await Promise.all([
      this.call(
        quoteToken,
        encodeAllowanceCall(owner, this.factoryAddress),
        undefined,
        blockTag,
      ),
      this.call(quoteToken, encodeBalanceOfCall(owner), undefined, blockTag),
    ]);

    return {
      blockNumber,
      blockTag,
      launchFee: decodeUint(launchFeeResult),
      launchEnabled: decodeBool(launchEnabledResult),
      quoteToken,
      launchConfig: decodeLaunchConfig(configResult),
      allowance: decodeUint(allowanceResult),
      pipedogBalance: decodeUint(balanceResult),
    };
  }

  async readCanonicalPipedogAllowance(owner: Address) {
    return decodeUint(
      await this.call(
        this.quoteTokenAddress,
        encodeAllowanceCall(owner, this.factoryAddress),
      ),
    );
  }

  async mineVanitySalt(options: {
    params: FactoryTokenParams;
    configId: bigint;
    sender: Address;
    roundsPerCall?: bigint;
    maxCalls?: number;
  }) {
    await this.verifyAuditedDeployment();
    const rounds = options.roundsPerCall ?? BigInt(4096);
    const maxCalls = options.maxCalls ?? 4;
    let start = BigInt(0);
    for (let attempt = 0; attempt < maxCalls; attempt += 1) {
      const result = decodeMineSaltResult(
        await this.call(
          this.factoryAddress,
          encodeMineSaltCall({
            params: options.params,
            configId: options.configId,
            sender: options.sender,
            start,
            rounds,
          }),
          options.sender,
        ),
      );
      if (!sameAddress(result.token, ZERO_ADDRESS)) return result;
      start += rounds;
    }
    throw new WalletFlowError(
      "Could not mine a valid token address in the bounded search. Try preparing again.",
    );
  }

  async prepareFirstBuyQuote(options: {
    owner: Address;
    predictedToken: Address;
    input: LaunchCallInput;
    slippageBps: number;
  }): Promise<FirstBuyQuote> {
    const { owner, predictedToken, input, slippageBps } = options;
    if (input.firstBuyIn <= BigInt(0)) {
      throw new WalletFlowError("A first-buy quote requires a positive PIPEDOG amount.");
    }
    assertFirstBuySlippageBps(slippageBps);
    const preflight = await this.readPreflight(owner, input.configId);
    const safety = assertLaunchPreflight({
      preflight,
      expectedSelfBurn: preflight.launchConfig.selfBurn,
      firstBuyIn: input.firstBuyIn,
    });
    if (
      preflight.allowance !== safety.requiredAllowance ||
      safety.approvalPlan.steps.length !== 0
    ) {
      throw new WalletFlowError(
        "First-buy quote proof requires the exact single-use launch fee plus first-buy allowance.",
      );
    }

    const local = quoteInitialFirstBuy({
      config: preflight.launchConfig,
      firstBuyIn: input.firstBuyIn,
    });
    const minimumOutput = applyFirstBuySlippage(
      local.expectedOutput,
      slippageBps,
    );
    const protectedInput = { ...input, firstBuyMinOut: minimumOutput };
    const exactOutputInput = {
      ...input,
      firstBuyMinOut: local.expectedOutput,
    };
    const exactResult = decodeLaunchResult(
      await this.call(
        this.factoryAddress,
        encodeLaunchCall(exactOutputInput),
        owner,
        preflight.blockTag,
      ),
    );
    if (!sameAddress(exactResult.token, predictedToken)) {
      throw new WalletFlowError(
        "First-buy quote simulation launched a different predicted token.",
      );
    }

    try {
      await this.call(
        this.factoryAddress,
        encodeLaunchCall({
          ...input,
          firstBuyMinOut: local.expectedOutput + BigInt(1),
        }),
        owner,
        preflight.blockTag,
      );
      throw new WalletFlowError(
        "First-buy quote boundary was not rejected by the factory.",
      );
    } catch (error) {
      if (
        error instanceof WalletFlowError &&
        /boundary was not rejected/.test(error.message)
      ) {
        throw error;
      }
      if (!containsExactRevertSelector(error, FIRST_BUY_SLIPPAGE_SELECTOR)) {
        throw new WalletFlowError(
          "Factory did not prove the exact first-buy output boundary.",
          unknownErrorCode(error),
          error,
        );
      }
    }

    const createdAtMs = this.now();
    return {
      owner,
      predictedToken,
      inputIdentityCalldata: launchInputIdentityCalldata(protectedInput),
      expectedOutput: local.expectedOutput,
      minimumOutput,
      slippageBps,
      verifiedBlockNumber: preflight.blockNumber,
      maxSubmissionBlock:
        preflight.blockNumber + FIRST_BUY_QUOTE_BLOCK_BUDGET,
      createdAtMs,
      expiresAtMs: createdAtMs + FIRST_BUY_QUOTE_TTL_MS,
    };
  }

  async estimateApproval(owner: Address, amount: bigint) {
    await this.verifyAuditedDeployment();
    return this.estimate({
      from: owner,
      to: this.quoteTokenAddress,
      data: encodeApproveCall(this.factoryAddress, amount),
    });
  }

  async sendApproval(
    owner: Address,
    amount: bigint,
    callbacks: LaunchSubmissionCallbacks = {},
  ) {
    await this.verifyAuditedDeployment();
    await ensureRobinhoodChain(this.provider);
    const transaction = {
      from: owner,
      to: this.quoteTokenAddress,
      data: encodeApproveCall(this.factoryAddress, amount),
    } as const;
    await this.estimate(transaction);
    await ensureRobinhoodChain(this.provider);
    const finalDeployment = await this.verifyAuditedDeployment();
    await assertSubmissionContext(this.provider, owner, {
      minimumBlockNumber: finalDeployment.blockNumber,
    });
    return this.sendMutation(transaction, "approval", callbacks);
  }

  async estimateLaunch(owner: Address, input: LaunchCallInput) {
    assertFirstBuyAmounts(input.firstBuyIn, input.firstBuyMinOut);
    await this.verifyAuditedDeployment();
    return this.estimate({
      from: owner,
      to: this.factoryAddress,
      data: encodeLaunchCall(input),
    });
  }

  async sendLaunch(
    owner: Address,
    input: LaunchCallInput,
    callbacks: LaunchSubmissionCallbacks = {},
  ) {
    assertFirstBuyAmounts(input.firstBuyIn, input.firstBuyMinOut);
    await ensureRobinhoodChain(this.provider);
    let finalSnapshotBlock: bigint;
    if (input.firstBuyIn > BigInt(0)) {
      if (!callbacks.firstBuyQuote || !callbacks.predictedToken) {
        throw new WalletFlowError(
          "A non-zero first buy requires a fresh factory-proven quote.",
        );
      }
      const preflight = await this.readPreflight(owner, input.configId);
      const safety = assertLaunchPreflight({
        preflight,
        expectedSelfBurn: preflight.launchConfig.selfBurn,
        firstBuyIn: input.firstBuyIn,
      });
      if (safety.approvalPlan.steps.length !== 0) {
        throw new WalletFlowError(
          "The exact single-use PIPEDOG allowance changed before launch.",
        );
      }
      assertFirstBuyQuoteForInput({
        quote: callbacks.firstBuyQuote,
        owner,
        predictedToken: callbacks.predictedToken,
        input,
        config: preflight.launchConfig,
        latestBlock: preflight.blockNumber,
        nowMs: this.now(),
      });
    }
    const transaction = {
      from: owner,
      to: this.factoryAddress,
      data: encodeLaunchCall(input),
    } as const;
    await this.estimate(transaction);
    await ensureRobinhoodChain(this.provider);
    if (input.firstBuyIn > BigInt(0)) {
      const quote = callbacks.firstBuyQuote!;
      const predictedToken = callbacks.predictedToken!;
      // This is deliberately after gas estimation: the final audited snapshot,
      // exact allowance/balance/config reads, and protected full-factory call
      // are all pinned to one block immediately before the wallet context check.
      const finalPreflight = await this.readPreflight(owner, input.configId);
      const finalSafety = assertLaunchPreflight({
        preflight: finalPreflight,
        expectedSelfBurn: finalPreflight.launchConfig.selfBurn,
        firstBuyIn: input.firstBuyIn,
      });
      if (finalSafety.approvalPlan.steps.length !== 0) {
        throw new WalletFlowError(
          "The exact single-use PIPEDOG allowance changed during final simulation.",
        );
      }
      assertFirstBuyQuoteForInput({
        quote,
        owner,
        predictedToken,
        input,
        config: finalPreflight.launchConfig,
        latestBlock: finalPreflight.blockNumber,
        nowMs: this.now(),
      });
      const protectedResult = decodeLaunchResult(
        await this.call(
          this.factoryAddress,
          transaction.data,
          owner,
          finalPreflight.blockTag,
        ),
      );
      if (!sameAddress(protectedResult.token, predictedToken)) {
        throw new WalletFlowError(
          "Final protected launch simulation returned a different token.",
        );
      }
      finalSnapshotBlock = finalPreflight.blockNumber;
    } else {
      finalSnapshotBlock = (await this.verifyAuditedDeployment()).blockNumber;
    }
    await assertSubmissionContext(this.provider, owner, {
      quote: callbacks.firstBuyQuote,
      minimumBlockNumber: finalSnapshotBlock,
      now: this.now,
    });
    return this.sendMutation(transaction, "launch", callbacks);
  }

  private async estimate(transaction: RpcTransactionRequest) {
    try {
      const result = await this.provider.request<unknown>({
        method: "eth_estimateGas",
        params: [transaction],
      });
      return assertRpcQuantity(result, "Gas simulation");
    } catch (error) {
      throw new WalletFlowError(
        `Simulation failed: ${describeWalletError(error)}`,
        unknownErrorCode(error),
        error,
      );
    }
  }

  private async sendMutation(
    transaction: RpcTransactionRequest,
    action: "approval" | "launch",
    callbacks: LaunchSubmissionCallbacks,
  ) {
    await callbacks.onSubmissionInvoked?.();
    try {
      const result = await this.provider.request<unknown>({
        method: "eth_sendTransaction",
        params: [transaction],
      });
      if (typeof result !== "string" || !isTransactionHash(result)) {
        throw new LaunchSubmissionIndeterminateError(
          `The wallet may have broadcast the ${action} but returned an invalid hash. Do not retry until wallet activity is reconciled.`,
        );
      }
      await callbacks.onSubmitted?.(result);
      return result;
    } catch (error) {
      if (explicitWalletRejection(error)) {
        throw new WalletFlowError(
          "You rejected the wallet request.",
          unknownErrorCode(error),
          error,
        );
      }
      if (isLaunchSubmissionIndeterminate(error)) throw error;
      throw new LaunchSubmissionIndeterminateError(
        `The wallet may have broadcast the ${action}. Do not retry until wallet activity is reconciled.`,
        unknownErrorCode(error),
        error,
      );
    }
  }

  async waitForReceipt(
    hash: Hex,
    options: {
      timeoutMs?: number;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      expectedFrom?: Address;
      expectedTo?: Address;
    } = {},
  ) {
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) {
        throw new WalletFlowError("Receipt check cancelled.");
      }

      const result = await this.provider.request<unknown>({
        method: "eth_getTransactionReceipt",
        params: [hash],
      });
      if (result) {
        const receipt = result as RpcTransactionReceipt;
        if (
          !receipt.transactionHash ||
          !isTransactionHash(receipt.transactionHash) ||
          !receipt.status ||
          !isHexQuantity(receipt.status)
        ) {
          throw new WalletFlowError("Wallet returned an incomplete transaction receipt.");
        }
        if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
          throw new WalletFlowError("Wallet returned a receipt for a different transaction.");
        }
        if (
          options.expectedFrom &&
          (!isAddress(receipt.from) ||
            !sameAddress(receipt.from, options.expectedFrom))
        ) {
          throw new WalletFlowError("Launch receipt sender does not match the creator.");
        }
        if (
          options.expectedTo &&
          (!receipt.to ||
            !isAddress(receipt.to) ||
            !sameAddress(receipt.to, options.expectedTo))
        ) {
          throw new WalletFlowError("Launch receipt target does not match the factory.");
        }
        if (BigInt(receipt.status) !== BigInt(1)) {
          throw new WalletFlowError("The transaction reverted on-chain.");
        }
        return receipt;
      }

      await abortableDelay(pollIntervalMs, options.signal);
    }
    throw new WalletFlowError(
      "Transaction is still pending. Check the explorer before trying again.",
    );
  }

  private async confirmCanonicalTransaction(
    hash: Hex,
    expected: {
      owner: Address;
      target: Address;
      calldata: Hex;
    },
    options: LaunchConfirmationOptions = {},
  ) {
    if (!isTransactionHash(hash)) {
      throw new WalletFlowError("Confirmation requires a valid transaction hash.");
    }
    const timeoutMs = options.timeoutMs ?? 180_000;
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const started = Date.now();
    const confirmationChain = assertRpcQuantity(
      await this.confirmationProvider.request<unknown>({ method: "eth_chainId" }),
      "Independent confirmation chain ID",
    );
    if (BigInt(confirmationChain) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)) {
      throw new WalletFlowError(
        "Independent confirmation RPC is not on Robinhood Chain.",
      );
    }

    while (Date.now() - started < timeoutMs) {
      if (options.signal?.aborted) {
        throw new WalletFlowError("Receipt check cancelled.");
      }
      const receipt = transactionReceipt(
        await this.confirmationProvider.request<unknown>({
          method: "eth_getTransactionReceipt",
          params: [hash],
        }),
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
      if (!sameAddress(receipt.from, expected.owner)) {
        throw new WalletFlowError(
          "Transaction receipt sender does not match the submitting wallet.",
        );
      }
      if (!receipt.to || !sameAddress(receipt.to, expected.target)) {
        throw new WalletFlowError(
          "Transaction receipt target does not match the submitted intent.",
        );
      }
      const [transactionValue, blockValue, headValue] = await Promise.all([
        this.confirmationProvider.request<unknown>({
          method: "eth_getTransactionByHash",
          params: [hash],
        }),
        this.confirmationProvider.request<unknown>({
          method: "eth_getBlockByNumber",
          params: [receipt.blockNumber, false],
        }),
        this.confirmationProvider.request<unknown>({ method: "eth_blockNumber" }),
      ]);
      if (!transactionValue || !blockValue) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      assertCanonicalTransaction({
        transactionValue,
        blockValue,
        receipt,
        hash,
        owner: expected.owner,
        target: expected.target,
        calldata: expected.calldata,
      });
      const head = BigInt(
        assertRpcQuantity(headValue, "Independent confirmation head"),
      );
      const receiptBlock = BigInt(receipt.blockNumber);
      if (
        head < receiptBlock ||
        head - receiptBlock + BigInt(1) < LAUNCH_CONFIRMATION_BLOCKS
      ) {
        await abortableDelay(pollIntervalMs, options.signal);
        continue;
      }
      if (BigInt(receipt.status) !== BigInt(1)) {
        throw new CanonicalTransactionRevertedError();
      }
      return receipt;
    }
    throw new WalletFlowError(
      "Transaction is still pending. Check the explorer before trying again.",
    );
  }

  async confirmLaunch(
    hash: Hex,
    expected: {
      creator: Address;
      predictedToken: Address;
      input: LaunchCallInput;
    },
    options: LaunchConfirmationOptions = {},
  ): Promise<ConfirmedLaunch> {
    const receipt = await this.confirmCanonicalTransaction(hash, {
      owner: expected.creator,
      target: this.factoryAddress,
      calldata: encodeLaunchCall(expected.input),
    }, options);
    const launched = launchedTokenFromReceipt(
      receipt,
      this.factoryAddress,
      expected,
      this.auditedManifest,
    );
    const tokenPoolId = assertRpcData(
      await this.confirmationProvider.request<unknown>({
        method: "eth_call",
        params: [
          { to: launched.token, data: TOKEN_POOL_ID_CALL },
          receipt.blockNumber,
        ],
      }),
      "Launched token pool ID read",
    );
    if (
      !isTransactionHash(tokenPoolId) ||
      tokenPoolId.toLowerCase() !== launched.poolId.toLowerCase()
    ) {
      throw new WalletFlowError(
        "Launched token pool ID does not match the factory event.",
      );
    }
    return { receipt, ...launched };
  }

  async confirmApproval(
    hash: Hex,
    owner: Address,
    amount: bigint,
    options: LaunchConfirmationOptions = {},
  ) {
    const receipt = await this.confirmCanonicalTransaction(hash, {
      owner,
      target: this.quoteTokenAddress,
      calldata: encodeApproveCall(this.factoryAddress, amount),
    }, options);
    const allowanceResult = assertRpcData(
      await this.confirmationProvider.request<unknown>({
        method: "eth_call",
        params: [
          {
            to: this.quoteTokenAddress,
            data: encodeAllowanceCall(owner, this.factoryAddress),
          },
          receipt.blockNumber,
        ],
      }),
      "Post-approval allowance read",
    );
    const allowance = decodeUint(allowanceResult);
    if (allowance !== amount) {
      throw new WalletFlowError(
        "Confirmed approval allowance does not match the exact submitted amount.",
      );
    }
    return { receipt, allowance };
  }
}

export function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new WalletFlowError("Receipt check cancelled."));
  }

  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      clearTimeout(timeout);
      cleanup();
      reject(new WalletFlowError("Receipt check cancelled."));
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
