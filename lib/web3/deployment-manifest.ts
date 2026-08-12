import { keccak256 } from "viem";

import {
  decodeAddress,
  decodeBool,
  decodeLaunchConfig,
  decodeUint,
  encodeGetLaunchConfigCall,
  encodeLaunchEnabledCall,
  encodeLaunchFeeCall,
  type FactoryLaunchConfig,
} from "./abi";
import {
  BASE_SEPOLIA_TEST_CHAIN,
  PIPEDOG_ADDRESS,
  PIPEDOG_RUNTIME_CODEHASH,
  ROBINHOOD_POOL_MANAGER_ADDRESS,
  ROBINHOOD_POOL_MANAGER_RUNTIME_CODEHASH,
  ROBINHOOD_WALLET_CHAIN,
  type LaypipeWalletChain,
} from "./chains";
import {
  assertAddress,
  isHexData,
  isHexQuantity,
  sameAddress,
  type Address,
  type Eip1193Provider,
  type Hex,
} from "./types";

export const EIP1967_IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
export const BASE_SEPOLIA_TEST_ACKNOWLEDGEMENT =
  "BASE_SEPOLIA_REHEARSAL_ONLY" as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FIXED_CREATOR_FEE_BPS = 7_000;
const FIXED_TRADING_FEE_RATE = 10_000;

const IDENTITY_SELECTORS = {
  bountyBps: "0x415307cc",
  factory: "0xc45a0155",
  hook: "0x7f5a7c7b",
  maxBurnPerCall: "0x8ace49e4",
  maxSequesterPerCall: "0x9c6ce490",
  maxTreasuryRoutePerCall: "0x260070fc",
  operationsWallet: "0xfd72e22a",
  owner: "0x8da5cb5b",
  paused: "0x5c975abb",
  pendingOwner: "0xe30c3978",
  pipedog: "0xa9ca72e2",
  poolManager: "0xdc4c90d3",
  quoteToken: "0x217a4b70",
  selfBurner: "0xdc605138",
  tokenImplementation: "0x2f3a3d5d",
  treasury: "0x61d027b3",
} as const satisfies Record<string, Hex>;

export interface AuditedContractIdentity {
  address: Address;
  runtimeCodehash: Hex;
}

export interface AuditedLaunchConfig {
  id: bigint;
  config: FactoryLaunchConfig;
}

export interface AuditedDeploymentManifest {
  manifestVersion: 1;
  environment: "robinhood-production" | "base-sepolia-test-only";
  testOnly: boolean;
  chain: LaypipeWalletChain;
  deploymentBlock: bigint;
  release: {
    sourceCommit: string;
    compilerVersion: string;
    abiBundleSha256: Hex;
    artifactBundleSha256: Hex;
  };
  contracts: {
    factoryProxy: AuditedContractIdentity;
    factoryImplementation: AuditedContractIdentity;
    tokenImplementation: AuditedContractIdentity;
    hook: AuditedContractIdentity;
    swapRouter: AuditedContractIdentity;
    selfBurner: AuditedContractIdentity;
    revenueRouter: AuditedContractIdentity;
    poolManager: AuditedContractIdentity;
    pipedog: AuditedContractIdentity;
  };
  governance: {
    finalOwner: Address;
    treasury: Address;
    operations: Address;
  };
  launch: {
    launchEnabled: true;
    launchFee: bigint;
    creator: AuditedLaunchConfig;
    selfBurn: AuditedLaunchConfig;
  };
  routing: {
    selfBurnMaxPerCall: bigint;
    selfBurnBountyBps: number;
    revenueMaxSequesterPerCall: bigint;
    revenueMaxTreasuryRoutePerCall: bigint;
    revenueBountyBps: number;
  };
}

export interface PublicDeploymentEnvironment {
  NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK?: string;
  NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH?: string;
  NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID?: string;
  NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID?: string;
  NEXT_PUBLIC_LAYPIPE_LAUNCH_FEE_WEI?: string;
  NEXT_PUBLIC_LAYPIPE_LAUNCH_SUPPLY_WEI?: string;
  NEXT_PUBLIC_LAYPIPE_TICK_SPACING?: string;
  NEXT_PUBLIC_LAYPIPE_START_TICK?: string;
  NEXT_PUBLIC_LAYPIPE_SELF_BURN_MAX_PER_CALL_WEI?: string;
  NEXT_PUBLIC_LAYPIPE_SELF_BURN_BOUNTY_BPS?: string;
  NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_SEQUESTER_PER_CALL_WEI?: string;
  NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_TREASURY_ROUTE_PER_CALL_WEI?: string;
  NEXT_PUBLIC_LAYPIPE_REVENUE_BOUNTY_BPS?: string;
  NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT?: string;
  NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION?: string;
  NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256?: string;
  NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256?: string;
}

export interface BaseSepoliaTestManifestInput {
  acknowledgement: typeof BASE_SEPOLIA_TEST_ACKNOWLEDGEMENT;
  deploymentBlock: bigint;
  release: AuditedDeploymentManifest["release"];
  contracts: Omit<
    AuditedDeploymentManifest["contracts"],
    "poolManager"
  >;
  governance: AuditedDeploymentManifest["governance"];
  launch: AuditedDeploymentManifest["launch"];
  routing: AuditedDeploymentManifest["routing"];
}

export class DeploymentIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentIntegrityError";
  }
}

function requireValue(value: string | undefined, label: string) {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${label} is not configured.`);
  }
  return value.trim();
}

function parseUnsigned(value: string | undefined, label: string) {
  const parsed = requireValue(value, label);
  if (!/^\d+$/.test(parsed)) throw new Error(`${label} must be an integer.`);
  return BigInt(parsed);
}

function parseSignedNumber(value: string | undefined, label: string) {
  const parsed = requireValue(value, label);
  if (!/^-?\d+$/.test(parsed)) throw new Error(`${label} must be an integer.`);
  const number = Number(parsed);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${label} is outside the safe integer range.`);
  }
  return number;
}

function parseBps(value: string | undefined, label: string) {
  const parsed = parseSignedNumber(value, label);
  if (parsed < 0 || parsed > 1_000) {
    throw new Error(`${label} must be between 0 and 1000.`);
  }
  return parsed;
}

function parseCodehash(value: string | undefined, label: string) {
  const parsed = requireValue(value, label);
  if (!/^0x[0-9a-fA-F]{64}$/.test(parsed)) {
    throw new Error(`${label} must be a 32-byte hex value.`);
  }
  return parsed.toLowerCase() as Hex;
}

function parseSourceCommit(value: string | undefined) {
  const parsed = requireValue(value, "Audited source commit");
  if (!/^[0-9a-fA-F]{40}$/.test(parsed)) {
    throw new Error("Audited source commit must be a full 40-character Git SHA.");
  }
  return parsed.toLowerCase();
}

function identity(
  address: string | undefined,
  runtimeCodehash: string | undefined,
  label: string,
): AuditedContractIdentity {
  const parsedAddress = assertAddress(
    requireValue(address, `${label} address`),
    `${label} address`,
  );
  if (sameAddress(parsedAddress, ZERO_ADDRESS)) {
    throw new Error(`${label} address must be non-zero.`);
  }
  return {
    address: parsedAddress,
    runtimeCodehash: parseCodehash(runtimeCodehash, `${label} runtime codehash`),
  };
}

function nonzeroAddress(value: string | undefined, label: string) {
  const parsed = assertAddress(requireValue(value, label), label);
  if (sameAddress(parsed, ZERO_ADDRESS)) {
    throw new Error(`${label} must be non-zero.`);
  }
  return parsed;
}

function standardConfig(options: {
  id: bigint;
  supply: bigint;
  tickSpacing: number;
  startTick: number;
  selfBurn: boolean;
  enabled: boolean;
}): AuditedLaunchConfig {
  return {
    id: options.id,
    config: {
      supply: options.supply,
      tickSpacing: options.tickSpacing,
      startTick: options.startTick,
      creatorFeeBps: FIXED_CREATOR_FEE_BPS,
      baseFeeRate: FIXED_TRADING_FEE_RATE,
      launchFeeRate: FIXED_TRADING_FEE_RATE,
      launchFeeDecay: 0,
      enabled: options.enabled,
      selfBurn: options.selfBurn,
    },
  };
}

function assertDistinctAddresses(
  entries: ReadonlyArray<readonly [string, Address]>,
) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (sameAddress(entries[left]![1], entries[right]![1])) {
        throw new Error(
          `${entries[left]![0]} and ${entries[right]![0]} must use distinct addresses.`,
        );
      }
    }
  }
}

export function parseRobinhoodProductionManifest(
  env: PublicDeploymentEnvironment,
): AuditedDeploymentManifest {
  const configuredPoolManager = assertAddress(
    requireValue(
      env.NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS,
      "PoolManager address",
    ),
    "PoolManager address",
  );
  if (!sameAddress(configuredPoolManager, ROBINHOOD_POOL_MANAGER_ADDRESS)) {
    throw new Error("PoolManager does not match the Robinhood production pin.");
  }

  const contracts = {
    factoryProxy: identity(
      env.NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH,
      "Factory proxy",
    ),
    factoryImplementation: identity(
      env.NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH,
      "Factory implementation",
    ),
    tokenImplementation: identity(
      env.NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH,
      "Token implementation",
    ),
    hook: identity(
      env.NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH,
      "Hook",
    ),
    swapRouter: identity(
      env.NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH,
      "Swap router",
    ),
    selfBurner: identity(
      env.NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH,
      "Self-burner",
    ),
    revenueRouter: identity(
      env.NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS,
      env.NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH,
      "Revenue router",
    ),
    poolManager: {
      address: ROBINHOOD_POOL_MANAGER_ADDRESS,
      runtimeCodehash: ROBINHOOD_POOL_MANAGER_RUNTIME_CODEHASH,
    },
    pipedog: {
      address: PIPEDOG_ADDRESS,
      runtimeCodehash: PIPEDOG_RUNTIME_CODEHASH,
    },
  } satisfies AuditedDeploymentManifest["contracts"];

  assertDistinctAddresses(
    Object.entries(contracts).map(([label, contract]) => [label, contract.address]),
  );

  const governance = {
    finalOwner: nonzeroAddress(
      env.NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS,
      "Final owner",
    ),
    treasury: nonzeroAddress(
      env.NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS,
      "Treasury",
    ),
    operations: nonzeroAddress(
      env.NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS,
      "Operations wallet",
    ),
  };
  assertDistinctAddresses([
    ["Final owner", governance.finalOwner],
    ["Treasury", governance.treasury],
    ["Operations wallet", governance.operations],
  ]);

  const creatorConfigId = parseUnsigned(
    env.NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID,
    "Creator config ID",
  );
  const selfBurnConfigId = parseUnsigned(
    env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID,
    "Self-burn config ID",
  );
  if (creatorConfigId === selfBurnConfigId) {
    throw new Error("Creator and self-burn config IDs must be distinct.");
  }
  const supply = parseUnsigned(
    env.NEXT_PUBLIC_LAYPIPE_LAUNCH_SUPPLY_WEI,
    "Launch supply",
  );
  if (supply === BigInt(0)) throw new Error("Launch supply must be non-zero.");
  const tickSpacing = parseSignedNumber(
    env.NEXT_PUBLIC_LAYPIPE_TICK_SPACING,
    "Tick spacing",
  );
  const startTick = parseSignedNumber(
    env.NEXT_PUBLIC_LAYPIPE_START_TICK,
    "Start tick",
  );
  const launchFee = parseUnsigned(
    env.NEXT_PUBLIC_LAYPIPE_LAUNCH_FEE_WEI,
    "Launch fee",
  );
  if (launchFee === BigInt(0)) {
    throw new Error("The audited production launch fee must be non-zero.");
  }

  const deploymentBlock = parseUnsigned(
    env.NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK,
    "Deployment block",
  );
  if (deploymentBlock === BigInt(0)) {
    throw new Error("Deployment block must be non-zero.");
  }

  return {
    manifestVersion: 1,
    environment: "robinhood-production",
    testOnly: false,
    chain: ROBINHOOD_WALLET_CHAIN,
    deploymentBlock,
    release: {
      sourceCommit: parseSourceCommit(env.NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT),
      compilerVersion: requireValue(
        env.NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION,
        "Audited compiler version",
      ),
      abiBundleSha256: parseCodehash(
        env.NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256,
        "ABI bundle SHA-256",
      ),
      artifactBundleSha256: parseCodehash(
        env.NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256,
        "Artifact bundle SHA-256",
      ),
    },
    contracts,
    governance,
    launch: {
      launchEnabled: true,
      launchFee,
      creator: standardConfig({
        id: creatorConfigId,
        supply,
        tickSpacing,
        startTick,
        selfBurn: false,
        enabled: true,
      }),
      selfBurn: standardConfig({
        id: selfBurnConfigId,
        supply,
        tickSpacing,
        startTick,
        selfBurn: true,
        enabled: false,
      }),
    },
    routing: {
      selfBurnMaxPerCall: parseUnsigned(
        env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_MAX_PER_CALL_WEI,
        "Self-burn per-call cap",
      ),
      selfBurnBountyBps: parseBps(
        env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_BOUNTY_BPS,
        "Self-burn bounty BPS",
      ),
      revenueMaxSequesterPerCall: parseUnsigned(
        env.NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_SEQUESTER_PER_CALL_WEI,
        "Revenue sequester per-call cap",
      ),
      revenueMaxTreasuryRoutePerCall: parseUnsigned(
        env.NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_TREASURY_ROUTE_PER_CALL_WEI,
        "Revenue treasury-route per-call cap",
      ),
      revenueBountyBps: parseBps(
        env.NEXT_PUBLIC_LAYPIPE_REVENUE_BOUNTY_BPS,
        "Revenue bounty BPS",
      ),
    },
  };
}

/**
 * Constructs a rehearsal manifest only from explicit test code. The production
 * environment parser above cannot select Base Sepolia or a mock quote token.
 */
export function createBaseSepoliaTestManifest(
  input: BaseSepoliaTestManifestInput,
): AuditedDeploymentManifest {
  if (input.acknowledgement !== BASE_SEPOLIA_TEST_ACKNOWLEDGEMENT) {
    throw new Error("Base Sepolia manifests require the test-only acknowledgement.");
  }
  return {
    manifestVersion: 1,
    environment: "base-sepolia-test-only",
    testOnly: true,
    chain: BASE_SEPOLIA_TEST_CHAIN,
    deploymentBlock: input.deploymentBlock,
    release: input.release,
    contracts: {
      ...input.contracts,
      poolManager: {
        address: BASE_SEPOLIA_TEST_CHAIN.poolManager,
        runtimeCodehash: BASE_SEPOLIA_TEST_CHAIN.poolManagerRuntimeCodehash,
      },
    },
    governance: input.governance,
    launch: input.launch,
    routing: input.routing,
  };
}

function integrityFailure(message: string): never {
  throw new DeploymentIntegrityError(`${message} Wallet mutations are blocked.`);
}

function assertRpcData(value: unknown, label: string): Hex {
  if (typeof value !== "string" || !isHexData(value)) {
    integrityFailure(`${label} returned malformed RPC data.`);
  }
  return value;
}

async function rpcCall(
  provider: Eip1193Provider,
  to: Address,
  data: Hex,
  blockTag: Hex,
) {
  return assertRpcData(
    await provider.request<unknown>({
      method: "eth_call",
      params: [{ to, data }, blockTag],
    }),
    `Read from ${to}`,
  );
}

async function readAddress(
  provider: Eip1193Provider,
  to: Address,
  selector: Hex,
  blockTag: Hex,
) {
  try {
    return decodeAddress(await rpcCall(provider, to, selector, blockTag));
  } catch (error) {
    if (error instanceof DeploymentIntegrityError) throw error;
    integrityFailure(
      `Address binding ${selector} on ${to} could not be decoded: ${
        error instanceof Error ? error.message : "unknown response"
      }.` ,
    );
  }
}

async function readUint(
  provider: Eip1193Provider,
  to: Address,
  selector: Hex,
  blockTag: Hex,
) {
  try {
    return decodeUint(await rpcCall(provider, to, selector, blockTag));
  } catch (error) {
    if (error instanceof DeploymentIntegrityError) throw error;
    integrityFailure(
      `Integer binding ${selector} on ${to} could not be decoded: ${
        error instanceof Error ? error.message : "unknown response"
      }.` ,
    );
  }
}

async function readBool(
  provider: Eip1193Provider,
  to: Address,
  selector: Hex,
  blockTag: Hex,
) {
  try {
    return decodeBool(await rpcCall(provider, to, selector, blockTag));
  } catch (error) {
    if (error instanceof DeploymentIntegrityError) throw error;
    integrityFailure(
      `Boolean binding ${selector} on ${to} could not be decoded: ${
        error instanceof Error ? error.message : "unknown response"
      }.` ,
    );
  }
}

function assertAddressMatch(actual: Address, expected: Address, label: string) {
  if (!sameAddress(actual, expected)) {
    integrityFailure(`${label} does not match the audited manifest.`);
  }
}

function assertUintMatch(actual: bigint, expected: bigint, label: string) {
  if (actual !== expected) {
    integrityFailure(`${label} does not match the audited manifest.`);
  }
}

function assertConfigMatch(
  actual: FactoryLaunchConfig,
  expected: FactoryLaunchConfig,
  label: string,
) {
  const keys: Array<keyof FactoryLaunchConfig> = [
    "supply",
    "tickSpacing",
    "startTick",
    "creatorFeeBps",
    "baseFeeRate",
    "launchFeeRate",
    "launchFeeDecay",
    "enabled",
    "selfBurn",
  ];
  for (const key of keys) {
    if (actual[key] !== expected[key]) {
      integrityFailure(`${label} field ${key} does not match the audited manifest.`);
    }
  }
}

function storageWordToAddress(value: Hex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    integrityFailure("EIP-1967 implementation storage returned a malformed word.");
  }
  const word = value.slice(2);
  if (!/^0{24}$/i.test(word.slice(0, 24))) {
    integrityFailure("EIP-1967 implementation storage is not a canonical address word.");
  }
  return assertAddress(`0x${word.slice(24)}`, "EIP-1967 implementation");
}

async function assertRuntimeIdentity(
  provider: Eip1193Provider,
  identity: AuditedContractIdentity,
  label: string,
  blockTag: Hex,
) {
  const code = assertRpcData(
    await provider.request<unknown>({
      method: "eth_getCode",
      params: [identity.address, blockTag],
    }),
    `${label} bytecode`,
  );
  if (code === "0x") integrityFailure(`${label} has no deployed bytecode.`);
  if (keccak256(code).toLowerCase() !== identity.runtimeCodehash.toLowerCase()) {
    integrityFailure(`${label} runtime codehash does not match the audited manifest.`);
  }
}

async function assertAuditedDeploymentSnapshot(
  provider: Eip1193Provider,
  manifest: AuditedDeploymentManifest,
  allowLaunchPausedForReadOnly: boolean,
) {
  const chainId = await provider.request<unknown>({ method: "eth_chainId" });
  if (
    typeof chainId !== "string" ||
    !isHexQuantity(chainId) ||
    BigInt(chainId) !== BigInt(manifest.chain.chainId)
  ) {
    integrityFailure(`Wallet chain does not match ${manifest.chain.chainName}.`);
  }
  const blockTagResult = await provider.request<unknown>({ method: "eth_blockNumber" });
  if (typeof blockTagResult !== "string" || !isHexQuantity(blockTagResult)) {
    integrityFailure("Wallet RPC returned a malformed block number.");
  }
  const blockTag = blockTagResult as Hex;

  await Promise.all(
    Object.entries(manifest.contracts).map(([label, contract]) =>
      assertRuntimeIdentity(provider, contract, label, blockTag),
    ),
  );

  const implementationWord = assertRpcData(
    await provider.request<unknown>({
      method: "eth_getStorageAt",
      params: [
        manifest.contracts.factoryProxy.address,
        EIP1967_IMPLEMENTATION_SLOT,
        blockTag,
      ],
    }),
    "EIP-1967 implementation storage",
  );
  assertAddressMatch(
    storageWordToAddress(implementationWord),
    manifest.contracts.factoryImplementation.address,
    "Factory implementation address",
  );

  const factory = manifest.contracts.factoryProxy.address;
  const hook = manifest.contracts.hook.address;
  const burner = manifest.contracts.selfBurner.address;
  const swapRouter = manifest.contracts.swapRouter.address;
  const revenueRouter = manifest.contracts.revenueRouter.address;
  const [
    factoryPoolManager,
    factoryQuoteToken,
    factoryHook,
    factoryTokenImplementation,
    factorySelfBurner,
    factoryTreasury,
    factoryOwner,
    factoryPendingOwner,
    hookFactory,
    hookPoolManager,
    hookQuoteToken,
    hookTreasury,
    hookOwner,
    hookPendingOwner,
    burnerFactory,
    burnerPoolManager,
    burnerHook,
    burnerQuoteToken,
    burnerCap,
    burnerBounty,
    swapPoolManager,
    swapPipedog,
    swapHook,
    revenuePipedog,
    revenueTreasury,
    revenueOperations,
    revenueOwner,
    revenuePendingOwner,
    revenuePaused,
    revenueSequesterCap,
    revenueTreasuryCap,
    revenueBounty,
    launchFee,
    launchEnabled,
    creatorConfigData,
    selfBurnConfigData,
  ] = await Promise.all([
    readAddress(provider, factory, IDENTITY_SELECTORS.poolManager, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.quoteToken, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.hook, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.tokenImplementation, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.selfBurner, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.treasury, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.owner, blockTag),
    readAddress(provider, factory, IDENTITY_SELECTORS.pendingOwner, blockTag),
    readAddress(provider, hook, IDENTITY_SELECTORS.factory, blockTag),
    readAddress(provider, hook, IDENTITY_SELECTORS.poolManager, blockTag),
    readAddress(provider, hook, IDENTITY_SELECTORS.quoteToken, blockTag),
    readAddress(provider, hook, IDENTITY_SELECTORS.treasury, blockTag),
    readAddress(provider, hook, IDENTITY_SELECTORS.owner, blockTag),
    readAddress(provider, hook, IDENTITY_SELECTORS.pendingOwner, blockTag),
    readAddress(provider, burner, IDENTITY_SELECTORS.factory, blockTag),
    readAddress(provider, burner, IDENTITY_SELECTORS.poolManager, blockTag),
    readAddress(provider, burner, IDENTITY_SELECTORS.hook, blockTag),
    readAddress(provider, burner, IDENTITY_SELECTORS.quoteToken, blockTag),
    readUint(provider, burner, IDENTITY_SELECTORS.maxBurnPerCall, blockTag),
    readUint(provider, burner, IDENTITY_SELECTORS.bountyBps, blockTag),
    readAddress(provider, swapRouter, IDENTITY_SELECTORS.poolManager, blockTag),
    readAddress(provider, swapRouter, IDENTITY_SELECTORS.pipedog, blockTag),
    readAddress(provider, swapRouter, IDENTITY_SELECTORS.hook, blockTag),
    readAddress(provider, revenueRouter, IDENTITY_SELECTORS.pipedog, blockTag),
    readAddress(provider, revenueRouter, IDENTITY_SELECTORS.treasury, blockTag),
    readAddress(provider, revenueRouter, IDENTITY_SELECTORS.operationsWallet, blockTag),
    readAddress(provider, revenueRouter, IDENTITY_SELECTORS.owner, blockTag),
    readAddress(provider, revenueRouter, IDENTITY_SELECTORS.pendingOwner, blockTag),
    readBool(provider, revenueRouter, IDENTITY_SELECTORS.paused, blockTag),
    readUint(provider, revenueRouter, IDENTITY_SELECTORS.maxSequesterPerCall, blockTag),
    readUint(provider, revenueRouter, IDENTITY_SELECTORS.maxTreasuryRoutePerCall, blockTag),
    readUint(provider, revenueRouter, IDENTITY_SELECTORS.bountyBps, blockTag),
    rpcCall(provider, factory, encodeLaunchFeeCall(), blockTag).then(decodeUint),
    rpcCall(provider, factory, encodeLaunchEnabledCall(), blockTag).then(decodeBool),
    rpcCall(
      provider,
      factory,
      encodeGetLaunchConfigCall(manifest.launch.creator.id),
      blockTag,
    ),
    rpcCall(
      provider,
      factory,
      encodeGetLaunchConfigCall(manifest.launch.selfBurn.id),
      blockTag,
    ),
  ]);

  assertAddressMatch(factoryPoolManager, manifest.contracts.poolManager.address, "Factory PoolManager");
  assertAddressMatch(factoryQuoteToken, manifest.contracts.pipedog.address, "Factory quote token");
  assertAddressMatch(factoryHook, hook, "Factory hook");
  assertAddressMatch(
    factoryTokenImplementation,
    manifest.contracts.tokenImplementation.address,
    "Factory token implementation",
  );
  assertAddressMatch(factorySelfBurner, burner, "Factory self-burner");
  assertAddressMatch(factoryTreasury, revenueRouter, "Factory revenue router");
  assertAddressMatch(factoryOwner, manifest.governance.finalOwner, "Factory owner");
  assertAddressMatch(factoryPendingOwner, ZERO_ADDRESS, "Factory pending owner");

  assertAddressMatch(hookFactory, factory, "Hook factory");
  assertAddressMatch(hookPoolManager, manifest.contracts.poolManager.address, "Hook PoolManager");
  assertAddressMatch(hookQuoteToken, manifest.contracts.pipedog.address, "Hook quote token");
  assertAddressMatch(hookTreasury, revenueRouter, "Hook revenue router");
  assertAddressMatch(hookOwner, manifest.governance.finalOwner, "Hook owner");
  assertAddressMatch(hookPendingOwner, ZERO_ADDRESS, "Hook pending owner");

  assertAddressMatch(burnerFactory, factory, "Self-burner factory");
  assertAddressMatch(burnerPoolManager, manifest.contracts.poolManager.address, "Self-burner PoolManager");
  assertAddressMatch(burnerHook, hook, "Self-burner hook");
  assertAddressMatch(burnerQuoteToken, manifest.contracts.pipedog.address, "Self-burner quote token");
  assertUintMatch(burnerCap, manifest.routing.selfBurnMaxPerCall, "Self-burner cap");
  assertUintMatch(burnerBounty, BigInt(manifest.routing.selfBurnBountyBps), "Self-burner bounty");

  assertAddressMatch(swapPoolManager, manifest.contracts.poolManager.address, "Swap router PoolManager");
  assertAddressMatch(swapPipedog, manifest.contracts.pipedog.address, "Swap router PIPEDOG");
  assertAddressMatch(swapHook, hook, "Swap router hook");

  assertAddressMatch(revenuePipedog, manifest.contracts.pipedog.address, "Revenue router PIPEDOG");
  assertAddressMatch(revenueTreasury, manifest.governance.treasury, "Revenue treasury");
  assertAddressMatch(revenueOperations, manifest.governance.operations, "Revenue operations wallet");
  assertAddressMatch(revenueOwner, manifest.governance.finalOwner, "Revenue router owner");
  assertAddressMatch(revenuePendingOwner, ZERO_ADDRESS, "Revenue router pending owner");
  if (revenuePaused) integrityFailure("Revenue router is paused");
  assertUintMatch(
    revenueSequesterCap,
    manifest.routing.revenueMaxSequesterPerCall,
    "Revenue sequester cap",
  );
  assertUintMatch(
    revenueTreasuryCap,
    manifest.routing.revenueMaxTreasuryRoutePerCall,
    "Revenue treasury-route cap",
  );
  assertUintMatch(
    revenueBounty,
    BigInt(manifest.routing.revenueBountyBps),
    "Revenue bounty",
  );

  assertUintMatch(launchFee, manifest.launch.launchFee, "Factory launch fee");
  const acceptedReadOnlyPause =
    allowLaunchPausedForReadOnly &&
    manifest.launch.launchEnabled &&
    !launchEnabled;
  if (launchEnabled !== manifest.launch.launchEnabled && !acceptedReadOnlyPause) {
    integrityFailure("Factory launch-enabled state does not match the audited manifest.");
  }
  try {
    assertConfigMatch(
      decodeLaunchConfig(creatorConfigData),
      manifest.launch.creator.config,
      "Creator launch config",
    );
    assertConfigMatch(
      decodeLaunchConfig(selfBurnConfigData),
      manifest.launch.selfBurn.config,
      "Self-burn launch config",
    );
  } catch (error) {
    if (error instanceof DeploymentIntegrityError) throw error;
    integrityFailure(
      `Launch config could not be decoded: ${
        error instanceof Error ? error.message : "unknown response"
      }.`,
    );
  }

  return { blockNumber: BigInt(blockTag), blockTag };
}

/**
 * Verifies one consistent active deployment snapshot. Call this again
 * immediately before every wallet mutation; callers must not cache a
 * successful result.
 */
export function assertAuditedDeployment(
  provider: Eip1193Provider,
  manifest: AuditedDeploymentManifest,
) {
  return assertAuditedDeploymentSnapshot(provider, manifest, false);
}

/**
 * Read-only indexer preflight. It accepts the audited production deployment
 * while its global launch switch is deliberately paused so indexing and
 * reconciliation can start before the Safe enables public launches. Every
 * other manifest, code, binding, governance, routing, and config check stays
 * identical to the wallet preflight.
 */
export function assertAuditedIndexerDeployment(
  provider: Eip1193Provider,
  manifest: AuditedDeploymentManifest,
) {
  return assertAuditedDeploymentSnapshot(provider, manifest, true);
}
