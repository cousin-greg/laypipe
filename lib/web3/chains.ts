import type { Address, Hex } from "./types";

export interface LaypipeWalletChain {
  chainId: number;
  chainIdHex: Hex;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: readonly string[];
  blockExplorerUrls: readonly string[];
}

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_CHAIN_ID_HEX = "0x1237" as Hex;
export const ROBINHOOD_EXPLORER_URL =
  "https://robinhoodchain.blockscout.com";
export const ROBINHOOD_PUBLIC_RPC_URL =
  "https://rpc.mainnet.chain.robinhood.com";
export const PIPEDOG_ADDRESS =
  "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6" as Address;
export const PIPEDOG_RUNTIME_CODEHASH =
  "0xc0d0d825734a0b6d070991217c8c0fb8530b574e839d2ff7685341fd9d707912" as Hex;
export const ROBINHOOD_POOL_MANAGER_ADDRESS =
  "0x8366a39CC670B4001A1121B8F6A443A643e40951" as Address;
export const ROBINHOOD_POOL_MANAGER_RUNTIME_CODEHASH =
  "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626" as Hex;

export const ROBINHOOD_WALLET_CHAIN: LaypipeWalletChain = {
  chainId: ROBINHOOD_CHAIN_ID,
  chainIdHex: ROBINHOOD_CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [ROBINHOOD_PUBLIC_RPC_URL],
  blockExplorerUrls: [ROBINHOOD_EXPLORER_URL],
};

/**
 * Test-only chain metadata. Production launch configuration never reads this
 * object or a public environment switch that could select it accidentally.
 */
export const BASE_SEPOLIA_TEST_CHAIN: LaypipeWalletChain & {
  testOnly: true;
  poolManager: Address;
  poolManagerRuntimeCodehash: Hex;
} = {
  testOnly: true,
  chainId: 84_532,
  chainIdHex: "0x14a34",
  chainName: "Base Sepolia (LayPipe rehearsal only)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://sepolia.base.org"],
  blockExplorerUrls: ["https://sepolia.basescan.org"],
  poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
  poolManagerRuntimeCodehash:
    "0x03c45db6d09b14da7c1f7239a5a49697f976d395277e6d2acb6fbed3f9e0249f",
};
