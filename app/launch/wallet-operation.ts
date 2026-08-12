import { ROBINHOOD_CHAIN_ID_HEX } from "../../lib/web3/chains";
import {
  isAddress,
  isHexQuantity,
  sameAddress,
  type Address,
  type Eip1193Provider,
} from "../../lib/web3/types";

export interface LaunchWalletSnapshot {
  provider: Eip1193Provider | null;
  account: Address | null;
  revision: number;
}

export interface LaunchPrepareOperation {
  readonly id: number;
  readonly provider: Eip1193Provider;
  readonly account: Address;
  readonly walletRevision: number;
  readonly signal: AbortSignal;
}

export class StaleLaunchWalletOperationError extends Error {
  constructor(message = "The wallet account or network changed. Prepare the launch again.") {
    super(message);
    this.name = "StaleLaunchWalletOperationError";
  }
}

export function isStaleLaunchWalletOperation(error: unknown) {
  return error instanceof StaleLaunchWalletOperationError;
}

export class LaunchPrepareOperationGuard {
  private nextId = 0;
  private active:
    | { operation: LaunchPrepareOperation; controller: AbortController }
    | null = null;

  begin(options: {
    provider: Eip1193Provider;
    account: Address;
    walletRevision: number;
  }): LaunchPrepareOperation {
    this.invalidate();
    const controller = new AbortController();
    const operation: LaunchPrepareOperation = {
      id: ++this.nextId,
      provider: options.provider,
      account: options.account,
      walletRevision: options.walletRevision,
      signal: controller.signal,
    };
    this.active = { operation, controller };
    return operation;
  }

  invalidate() {
    this.active?.controller.abort();
    this.active = null;
  }

  isCurrent(
    operation: LaunchPrepareOperation,
    snapshot: LaunchWalletSnapshot,
  ) {
    return Boolean(
      this.active?.operation.id === operation.id &&
        !operation.signal.aborted &&
        snapshot.provider === operation.provider &&
        snapshot.revision === operation.walletRevision &&
        snapshot.account !== null &&
        sameAddress(snapshot.account, operation.account),
    );
  }

  assertCurrent(
    operation: LaunchPrepareOperation,
    snapshot: LaunchWalletSnapshot,
  ) {
    if (!this.isCurrent(operation, snapshot)) {
      throw new StaleLaunchWalletOperationError();
    }
  }

  finish(operation: LaunchPrepareOperation) {
    if (this.active?.operation.id === operation.id) this.active = null;
  }
}

async function selectedWalletSnapshot(provider: Eip1193Provider) {
  const [chainId, accounts] = await Promise.all([
    provider.request<unknown>({ method: "eth_chainId" }),
    provider.request<unknown>({ method: "eth_accounts" }),
  ]);
  return { chainId, accounts };
}

function assertSelectedWalletSnapshot(
  snapshot: Awaited<ReturnType<typeof selectedWalletSnapshot>>,
  expectedAccount: Address,
) {
  if (
    typeof snapshot.chainId !== "string" ||
    !isHexQuantity(snapshot.chainId) ||
    BigInt(snapshot.chainId) !== BigInt(ROBINHOOD_CHAIN_ID_HEX)
  ) {
    throw new StaleLaunchWalletOperationError(
      "The active wallet network changed. Switch back to Robinhood Chain and prepare again.",
    );
  }
  if (
    !Array.isArray(snapshot.accounts) ||
    typeof snapshot.accounts[0] !== "string" ||
    !isAddress(snapshot.accounts[0]) ||
    !sameAddress(snapshot.accounts[0], expectedAccount)
  ) {
    throw new StaleLaunchWalletOperationError(
      "The active wallet account changed. Reconnect and prepare the launch again.",
    );
  }
}

export async function assertExactLaunchWalletContext(
  provider: Eip1193Provider,
  expectedAccount: Address,
) {
  // Read twice so an account or chain transition between the two RPC responses
  // cannot authorize a commit from a mixed wallet snapshot.
  assertSelectedWalletSnapshot(
    await selectedWalletSnapshot(provider),
    expectedAccount,
  );
  assertSelectedWalletSnapshot(
    await selectedWalletSnapshot(provider),
    expectedAccount,
  );
}

export function assertPreparedLaunchCreator(
  preparedCreator: Address,
  currentAccount: Address,
) {
  if (!sameAddress(preparedCreator, currentAccount)) {
    throw new StaleLaunchWalletOperationError(
      "This launch was prepared by a different wallet. Prepare it again before approving or launching.",
    );
  }
}
