export type Hex = `0x${string}`;
export type Address = `0x${string}`;

export interface Eip1193RequestArguments {
  method: string;
  params?: readonly unknown[] | Record<string, unknown>;
}

export interface Eip1193Provider {
  request<T = unknown>(args: Eip1193RequestArguments): Promise<T>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface RpcTransactionRequest {
  from?: Address;
  to: Address;
  data: Hex;
  value?: Hex;
}

export interface RpcLog {
  address: Address;
  data: Hex;
  topics: Hex[];
}

export interface RpcTransactionReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  status: Hex;
  to: Address | null;
  from: Address;
  logs: RpcLog[];
}

export function isAddress(value: string): value is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function assertAddress(value: string, label = "Address"): Address {
  if (!isAddress(value)) throw new Error(`${label} is not a valid EVM address.`);
  return value;
}

export function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

export function isHexData(value: string): value is Hex {
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

export function isHexQuantity(value: string): value is Hex {
  return /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
}

export function isTransactionHash(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}
