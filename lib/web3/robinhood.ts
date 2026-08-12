import {
  parseRobinhoodProductionManifest,
  type AuditedDeploymentManifest,
  type PublicDeploymentEnvironment,
} from "./deployment-manifest";
import {
  ROBINHOOD_EXPLORER_URL,
  type ROBINHOOD_WALLET_CHAIN,
} from "./chains";
import type { Address, Hex } from "./types";

export {
  BASE_SEPOLIA_TEST_CHAIN,
  PIPEDOG_ADDRESS,
  PIPEDOG_RUNTIME_CODEHASH,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_CHAIN_ID_HEX,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_POOL_MANAGER_ADDRESS,
  ROBINHOOD_POOL_MANAGER_RUNTIME_CODEHASH,
  ROBINHOOD_PUBLIC_RPC_URL,
  ROBINHOOD_WALLET_CHAIN,
} from "./chains";

export interface PublicLaunchDeployment extends AuditedDeploymentManifest {
  factoryAddress: Address;
  creatorConfigId: bigint;
  selfBurnConfigId: bigint;
}

export type PublicLaunchDeploymentResult =
  | { configured: true; deployment: PublicLaunchDeployment }
  | { configured: false; reason: string };

/**
 * Production is deliberately unconfigured until every audited identity and
 * economic value is present. A factory address by itself is never sufficient
 * to enable wallet mutations.
 */
export function readPublicLaunchDeployment(
  env: PublicDeploymentEnvironment,
): PublicLaunchDeploymentResult {
  try {
    const manifest = parseRobinhoodProductionManifest(env);
    return {
      configured: true,
      deployment: {
        ...manifest,
        factoryAddress: manifest.contracts.factoryProxy.address,
        creatorConfigId: manifest.launch.creator.id,
        selfBurnConfigId: manifest.launch.selfBurn.id,
      },
    };
  } catch (error) {
    return {
      configured: false,
      reason:
        error instanceof Error
          ? error.message
          : "The configured release manifest is incomplete.",
    };
  }
}

export function robinhoodWalletAddChainParameters(
  chain: typeof ROBINHOOD_WALLET_CHAIN,
) {
  return {
    chainId: chain.chainIdHex,
    chainName: chain.chainName,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: chain.rpcUrls,
    blockExplorerUrls: chain.blockExplorerUrls,
  };
}

export function explorerTransactionUrl(hash: Hex) {
  return `${ROBINHOOD_EXPLORER_URL}/tx/${hash}`;
}

export function explorerTokenUrl(address: Address) {
  return `${ROBINHOOD_EXPLORER_URL}/token/${address}`;
}
