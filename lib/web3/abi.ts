import { assertAddress, isHexData, type Address, type Hex } from "./types";

export interface FactorySocials {
  telegram: string;
  twitter: string;
  discord: string;
  website: string;
  extra: string;
}

export interface FactoryTokenParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  metadataURI: string;
  socials: FactorySocials;
  creator: Address;
}

export interface FactoryLaunchConfig {
  supply: bigint;
  tickSpacing: number;
  startTick: number;
  creatorFeeBps: number;
  baseFeeRate: number;
  launchFeeRate: number;
  launchFeeDecay: number;
  enabled: boolean;
  selfBurn: boolean;
}

interface EncodedValue {
  dynamic: boolean;
  data: string;
}

export const LAYPIPE_CALL_SELECTORS = {
  allowance: "dd62ed3e",
  approve: "095ea7b3",
  balanceOf: "70a08231",
  getLaunchConfig: "1cad862d",
  launch: "75154d70",
  launchConfigCount: "ae72d871",
  launchEnabled: "236a4afb",
  launchFee: "cf3cf573",
  mineSalt: "c5ce3f21",
  quoteToken: "217a4b70",
} as const;

function stripHexPrefix(value: string) {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function assertWordHex(value: string, label: string) {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label} must encode to one ABI word.`);
  }
  return value.toLowerCase();
}

function uintWord(value: bigint) {
  if (value < BigInt(0) || value >= BigInt(1) << BigInt(256)) {
    throw new Error("Integer is outside uint256 range.");
  }
  return value.toString(16).padStart(64, "0");
}

function uintValue(value: bigint): EncodedValue {
  return { dynamic: false, data: uintWord(value) };
}

function addressValue(value: Address): EncodedValue {
  const address = stripHexPrefix(assertAddress(value));
  return { dynamic: false, data: address.toLowerCase().padStart(64, "0") };
}

function bytes32Value(value: Hex): EncodedValue {
  const bytes = stripHexPrefix(value);
  return { dynamic: false, data: assertWordHex(bytes, "bytes32") };
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stringValue(value: string): EncodedValue {
  const encoded = bytesToHex(new TextEncoder().encode(value));
  const paddedLength = Math.ceil(encoded.length / 64) * 64;
  return {
    dynamic: true,
    data: uintWord(BigInt(encoded.length / 2)) + encoded.padEnd(paddedLength, "0"),
  };
}

function tupleValue(values: EncodedValue[]): EncodedValue {
  return { dynamic: values.some((value) => value.dynamic), data: encodeTuple(values) };
}

function encodeTuple(values: EncodedValue[]) {
  let tailOffset = values.length * 32;
  const heads: string[] = [];
  const tails: string[] = [];

  for (const value of values) {
    if (!value.dynamic) {
      heads.push(assertWordHex(value.data, "Static value"));
      continue;
    }

    heads.push(uintWord(BigInt(tailOffset)));
    tails.push(value.data);
    tailOffset += value.data.length / 2;
  }

  return heads.join("") + tails.join("");
}

function functionData(selector: string, values: EncodedValue[] = []) {
  return `0x${selector}${encodeTuple(values)}` as Hex;
}

function tokenParamsValue(params: FactoryTokenParams) {
  const socials = tupleValue([
    stringValue(params.socials.telegram),
    stringValue(params.socials.twitter),
    stringValue(params.socials.discord),
    stringValue(params.socials.website),
    stringValue(params.socials.extra),
  ]);

  return tupleValue([
    stringValue(params.name),
    stringValue(params.symbol),
    stringValue(params.logo),
    stringValue(params.description),
    stringValue(params.metadataURI),
    socials,
    addressValue(params.creator),
  ]);
}

export function encodeAllowanceCall(owner: Address, spender: Address) {
  return functionData(LAYPIPE_CALL_SELECTORS.allowance, [
    addressValue(owner),
    addressValue(spender),
  ]);
}

export function encodeBalanceOfCall(owner: Address) {
  return functionData(LAYPIPE_CALL_SELECTORS.balanceOf, [addressValue(owner)]);
}

export function encodeApproveCall(spender: Address, amount: bigint) {
  return functionData(LAYPIPE_CALL_SELECTORS.approve, [
    addressValue(spender),
    uintValue(amount),
  ]);
}

export function encodeLaunchFeeCall() {
  return functionData(LAYPIPE_CALL_SELECTORS.launchFee);
}

export function encodeLaunchEnabledCall() {
  return functionData(LAYPIPE_CALL_SELECTORS.launchEnabled);
}

export function encodeLaunchConfigCountCall() {
  return functionData(LAYPIPE_CALL_SELECTORS.launchConfigCount);
}

export function encodeQuoteTokenCall() {
  return functionData(LAYPIPE_CALL_SELECTORS.quoteToken);
}

export function encodeGetLaunchConfigCall(configId: bigint) {
  return functionData(LAYPIPE_CALL_SELECTORS.getLaunchConfig, [
    uintValue(configId),
  ]);
}

export function encodeMineSaltCall(options: {
  params: FactoryTokenParams;
  configId: bigint;
  sender: Address;
  start: bigint;
  rounds: bigint;
}) {
  return functionData(LAYPIPE_CALL_SELECTORS.mineSalt, [
    tokenParamsValue(options.params),
    uintValue(options.configId),
    addressValue(options.sender),
    uintValue(options.start),
    uintValue(options.rounds),
  ]);
}

export function encodeLaunchCall(options: {
  params: FactoryTokenParams;
  configId: bigint;
  firstBuyIn: bigint;
  firstBuyMinOut: bigint;
  salt: Hex;
}) {
  return functionData(LAYPIPE_CALL_SELECTORS.launch, [
    tokenParamsValue(options.params),
    uintValue(options.configId),
    uintValue(options.firstBuyIn),
    uintValue(options.firstBuyMinOut),
    bytes32Value(options.salt),
  ]);
}

function splitWords(data: Hex) {
  if (!isHexData(data)) throw new Error("Contract returned malformed hex data.");
  const bytes = stripHexPrefix(data);
  if (bytes.length % 64 !== 0) {
    throw new Error("Contract returned malformed ABI data.");
  }
  return bytes.match(/.{64}/g) ?? [];
}

function wordToBigint(word: string) {
  return BigInt(`0x${word}`);
}

function wordToAddress(word: string) {
  return assertAddress(`0x${word.slice(24)}`);
}

function wordToSignedNumber(word: string, bits: number) {
  const modulus = BigInt(1) << BigInt(bits);
  const mask = modulus - BigInt(1);
  const signBit = BigInt(1) << BigInt(bits - 1);
  const raw = wordToBigint(word) & mask;
  const signed = raw & signBit ? raw - modulus : raw;
  const number = Number(signed);
  if (!Number.isSafeInteger(number)) throw new Error("Signed value is too large.");
  return number;
}

function wordToBool(word: string) {
  const value = wordToBigint(word);
  if (value !== BigInt(0) && value !== BigInt(1)) {
    throw new Error("Contract returned an invalid bool word.");
  }
  return value === BigInt(1);
}

export function decodeUint(data: Hex) {
  const [word] = splitWords(data);
  if (!word) throw new Error("Contract returned no uint256 value.");
  return wordToBigint(word);
}

export function decodeBool(data: Hex) {
  const value = decodeUint(data);
  if (value !== BigInt(0) && value !== BigInt(1)) {
    throw new Error("Contract returned an invalid bool.");
  }
  return value === BigInt(1);
}

export function decodeAddress(data: Hex) {
  const [word] = splitWords(data);
  if (!word) throw new Error("Contract returned no address.");
  return wordToAddress(word);
}

export function decodeMineSaltResult(data: Hex) {
  const words = splitWords(data);
  if (words.length < 2) throw new Error("Factory returned an invalid salt result.");
  return {
    salt: `0x${words[0]}` as Hex,
    token: wordToAddress(words[1]!),
  };
}

export function decodeLaunchResult(data: Hex) {
  const words = splitWords(data);
  if (words.length < 2) throw new Error("Factory returned an invalid launch result.");
  return {
    token: wordToAddress(words[0]!),
    poolId: `0x${words[1]}` as Hex,
  };
}

export function decodeLaunchConfig(data: Hex): FactoryLaunchConfig {
  const words = splitWords(data);
  if (words.length < 9) throw new Error("Factory returned an invalid launch config.");
  return {
    supply: wordToBigint(words[0]!),
    tickSpacing: wordToSignedNumber(words[1]!, 24),
    startTick: wordToSignedNumber(words[2]!, 24),
    creatorFeeBps: Number(wordToBigint(words[3]!)),
    baseFeeRate: Number(wordToBigint(words[4]!)),
    launchFeeRate: Number(wordToBigint(words[5]!)),
    launchFeeDecay: Number(wordToBigint(words[6]!)),
    enabled: wordToBool(words[7]!),
    selfBurn: wordToBool(words[8]!),
  };
}
