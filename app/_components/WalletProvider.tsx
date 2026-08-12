"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  connectInjectedWallet,
  describeWalletError,
  ensureRobinhoodChain,
  getInjectedProvider,
  subscribeToWalletContext,
} from "@/lib/web3/launch-client";
import { ROBINHOOD_CHAIN_ID_HEX } from "@/lib/web3/robinhood";
import type { Address, Eip1193Provider } from "@/lib/web3/types";
import { isAddress, isHexQuantity } from "@/lib/web3/types";

export type WalletStatus =
  | "checking"
  | "missing"
  | "disconnected"
  | "connecting"
  | "wrong-chain"
  | "connected"
  | "error";

interface WalletContextValue {
  provider: Eip1193Provider | null;
  account: Address | null;
  status: WalletStatus;
  error: string | null;
  revision: number;
  connect: () => Promise<Address | null>;
  refresh: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function sameAccount(left: Address | null, right: Address | null) {
  return left?.toLowerCase() === right?.toLowerCase();
}

async function walletSnapshot(provider: Eip1193Provider) {
  const [accounts, chainId] = await Promise.all([
    provider.request<unknown>({ method: "eth_accounts" }),
    provider.request<unknown>({ method: "eth_chainId" }),
  ]);
  const account =
    Array.isArray(accounts) && typeof accounts[0] === "string" && isAddress(accounts[0])
      ? accounts[0]
      : null;
  const correctChain =
    typeof chainId === "string" &&
    isHexQuantity(chainId) &&
    BigInt(chainId) === BigInt(ROBINHOOD_CHAIN_ID_HEX);
  return { account, correctChain };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [account, setAccount] = useState<Address | null>(null);
  const [status, setStatus] = useState<WalletStatus>("checking");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refreshOperationRef = useRef(0);
  const connectOperationRef = useRef(0);
  const snapshotRef = useRef<{
    provider: Eip1193Provider | null;
    account: Address | null;
    status: WalletStatus;
  }>({ provider: null, account: null, status: "checking" });

  const refresh = useCallback(async () => {
    const operation = ++refreshOperationRef.current;
    const injected = getInjectedProvider();
    if (operation !== refreshOperationRef.current) return;
    setProvider(injected);
    if (!injected) {
      const changed =
        snapshotRef.current.provider !== null ||
        snapshotRef.current.account !== null ||
        snapshotRef.current.status !== "missing";
      snapshotRef.current = { provider: null, account: null, status: "missing" };
      setAccount(null);
      setStatus("missing");
      setError(null);
      if (changed) setRevision((value) => value + 1);
      return;
    }
    try {
      const snapshot = await walletSnapshot(injected);
      if (operation !== refreshOperationRef.current) return;
      const nextStatus: WalletStatus = !snapshot.account
        ? "disconnected"
        : snapshot.correctChain
          ? "connected"
          : "wrong-chain";
      const changed =
        snapshotRef.current.provider !== injected ||
        !sameAccount(snapshotRef.current.account, snapshot.account) ||
        snapshotRef.current.status !== nextStatus;
      snapshotRef.current = {
        provider: injected,
        account: snapshot.account,
        status: nextStatus,
      };
      setAccount(snapshot.account);
      setStatus(nextStatus);
      setError(null);
      if (changed) setRevision((value) => value + 1);
    } catch (cause) {
      if (operation !== refreshOperationRef.current) return;
      const changed =
        snapshotRef.current.provider !== injected ||
        snapshotRef.current.account !== null ||
        snapshotRef.current.status !== "error";
      snapshotRef.current = { provider: injected, account: null, status: "error" };
      setAccount(null);
      setStatus("error");
      setError(describeWalletError(cause));
      if (changed) setRevision((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void refresh());
    const detectLateProvider = () => void refresh();
    window.addEventListener("ethereum#initialized", detectLateProvider);
    const timer = window.setTimeout(detectLateProvider, 1_000);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("ethereum#initialized", detectLateProvider);
    };
  }, [refresh]);

  useEffect(() => {
    if (!provider) return;
    return subscribeToWalletContext(provider, () => void refresh());
  }, [provider, refresh]);

  const connect = useCallback(async () => {
    const operation = ++connectOperationRef.current;
    refreshOperationRef.current += 1;
    const injected = getInjectedProvider();
    if (operation !== connectOperationRef.current) return null;
    setProvider(injected);
    if (!injected) {
      snapshotRef.current = { provider: null, account: null, status: "missing" };
      setStatus("missing");
      setError("Install or open an injected wallet to connect.");
      return null;
    }
    setStatus("connecting");
    setError(null);
    try {
      const connected = await connectInjectedWallet(injected);
      await ensureRobinhoodChain(injected);
      const snapshot = await walletSnapshot(injected);
      if (operation !== connectOperationRef.current) return null;
      if (!snapshot.account || snapshot.account.toLowerCase() !== connected.toLowerCase()) {
        throw new Error("The active wallet account changed during connection.");
      }
      if (!snapshot.correctChain) throw new Error("Switch to Robinhood Chain to continue.");
      snapshotRef.current = {
        provider: injected,
        account: snapshot.account,
        status: "connected",
      };
      setAccount(snapshot.account);
      setStatus("connected");
      setRevision((value) => value + 1);
      return snapshot.account;
    } catch (cause) {
      if (operation !== connectOperationRef.current) return null;
      snapshotRef.current = { provider: injected, account: null, status: "error" };
      setAccount(null);
      setStatus("error");
      setError(describeWalletError(cause));
      setRevision((value) => value + 1);
      return null;
    }
  }, []);

  const value = useMemo(
    () => ({ provider, account, status, error, revision, connect, refresh }),
    [provider, account, status, error, revision, connect, refresh],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const value = useContext(WalletContext);
  if (!value) throw new Error("useWallet must be used inside WalletProvider.");
  return value;
}
