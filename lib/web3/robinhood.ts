import { assertAddress, type Address, type Hex } from "./types";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_ID_HEX = "0x1237" as Hex;
export const ROBINHOOD_EXPLORER_URL = "https://robinhoodchain.blockscout.com";
export const ROBINHOOD_PUBLIC_RPC_URL =
  "https://rpc.mainnet.chain.robinhood.com";
export const PIPEDOG_ADDRESS =
  "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6" as Address;

export const ROBINHOOD_WALLET_CHAIN = {
  chainId: ROBINHOOD_CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [ROBINHOOD_PUBLIC_RPC_URL],
  blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
} as const;

export interface PublicLaunchDeployment {
  factoryAddress: Address;
  creatorConfigId: bigint;
  selfBurnConfigId: bigint;
}

export type PublicLaunchDeploymentResult =
  | { configured: true; deployment: PublicLaunchDeployment }
  | { configured: false; reason: string };

function parseConfigId(value: string | undefined, label: string) {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${label} is not configured.`);
  }
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  return BigInt(value);
}

export function readPublicLaunchDeployment(env: {
  NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS?: string;
  NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID?: string;
  NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID?: string;
}): PublicLaunchDeploymentResult {
  try {
    if (!env.NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS) {
      throw new Error("The audited factory address is not configured yet.");
    }
    return {
      configured: true,
      deployment: {
        factoryAddress: assertAddress(
          env.NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS,
          "Factory address",
        ),
        creatorConfigId: parseConfigId(
          env.NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID,
          "Creator config ID",
        ),
        selfBurnConfigId: parseConfigId(
          env.NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID,
          "Self-burn config ID",
        ),
      },
    };
  } catch (error) {
    return {
      configured: false,
      reason: error instanceof Error ? error.message : "Deployment is incomplete.",
    };
  }
}

export function explorerTransactionUrl(hash: Hex) {
  return `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`;
}

export function explorerTokenUrl(address: Address) {
  return `${ROBINHOOD_EXPLORER_URL}/token/${address}`;
}
