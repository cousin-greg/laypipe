import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const CANONICAL_RELEASE_CONTRACTS = Object.freeze([
  Object.freeze({ source: "LaypipeFactory.sol", contract: "LaypipeFactory" }),
  Object.freeze({ source: "LaypipeSelfBurner.sol", contract: "LaypipeSelfBurner" }),
  Object.freeze({ source: "LaypipeSwapRouter.sol", contract: "LaypipeSwapRouter" }),
  Object.freeze({ source: "LaypipeToken.sol", contract: "LaypipeToken" }),
  Object.freeze({ source: "PipedogHook.sol", contract: "PipedogHook" }),
  Object.freeze({ source: "PipedogRevenueRouter.sol", contract: "PipedogRevenueRouter" }),
]);

const EXPECTED_COMPILER = "0.8.28+commit.7893614a";
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const BYTECODE_PATTERN = /^0x(?:[0-9a-fA-F]{2})+$/;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Stable JSON: object keys are sorted recursively; array order remains semantic. */
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Release hash input contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Release hash input contains an unsupported JSON value.");
}

function sha256(value) {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new Error(`${label} is missing. Run forge build and ABI generation first.`);
  }
  try {
    return JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function requireEmptyLinkReferences(value, label) {
  if (!isPlainObject(value) || Object.keys(value).length !== 0) {
    throw new Error(
      `${label} contains external library links; the release-hash projection must be reviewed before use.`,
    );
  }
}

function bytecode(value, label) {
  if (typeof value !== "string" || !BYTECODE_PATTERN.test(value)) {
    throw new Error(`${label} is missing or is not complete hex bytecode.`);
  }
  return value.toLowerCase();
}

function immutableRanges(value, label) {
  if (value === undefined) return [];
  if (!isPlainObject(value)) throw new Error(`${label} immutable references are malformed.`);
  const ranges = [];
  for (const entries of Object.values(value)) {
    if (!Array.isArray(entries)) throw new Error(`${label} immutable references are malformed.`);
    for (const entry of entries) {
      if (
        !isPlainObject(entry) ||
        !Number.isSafeInteger(entry.start) ||
        entry.start < 0 ||
        !Number.isSafeInteger(entry.length) ||
        entry.length < 1
      ) {
        throw new Error(`${label} immutable references are malformed.`);
      }
      ranges.push({ start: entry.start, length: entry.length });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || left.length - right.length);
}

function compiledArtifactProjection(artifact, contract) {
  if (!isPlainObject(artifact)) throw new Error(`${contract} artifact is malformed.`);
  if (!Array.isArray(artifact.abi)) throw new Error(`${contract} artifact ABI is malformed.`);
  if (!isPlainObject(artifact.bytecode) || !isPlainObject(artifact.deployedBytecode)) {
    throw new Error(`${contract} artifact bytecode is malformed.`);
  }
  requireEmptyLinkReferences(artifact.bytecode.linkReferences, `${contract} creation bytecode`);
  requireEmptyLinkReferences(
    artifact.deployedBytecode.linkReferences,
    `${contract} runtime bytecode`,
  );

  const metadata = artifact.metadata;
  const settings = metadata?.settings;
  const optimizerKeys = isPlainObject(settings?.optimizer)
    ? Object.keys(settings.optimizer).sort()
    : [];
  const metadataKeys = isPlainObject(settings?.metadata)
    ? Object.keys(settings.metadata).sort()
    : [];
  if (metadata?.compiler?.version !== EXPECTED_COMPILER) {
    throw new Error(`${contract} was not compiled with ${EXPECTED_COMPILER}.`);
  }
  if (
    settings?.evmVersion !== "cancun" ||
    settings?.optimizer?.enabled !== true ||
    settings?.optimizer?.runs !== 800 ||
    optimizerKeys.join(",") !== "enabled,runs" ||
    settings?.viaIR !== true ||
    settings?.metadata?.bytecodeHash !== "none" ||
    (settings.metadata.appendCBOR !== undefined && settings.metadata.appendCBOR !== true) ||
    metadataKeys.some((key) => key !== "appendCBOR" && key !== "bytecodeHash")
  ) {
    throw new Error(`${contract} compiler settings do not match foundry.toml release settings.`);
  }

  return {
    schema: "laypipe-compiled-artifact-v1",
    contract,
    compiler: EXPECTED_COMPILER,
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 800 },
      viaIR: true,
      metadataBytecodeHash: "none",
      metadataAppendCbor: true,
    },
    creationBytecode: bytecode(artifact.bytecode.object, `${contract} creation bytecode`),
    runtimeBytecode: bytecode(
      artifact.deployedBytecode.object,
      `${contract} runtime bytecode`,
    ),
    immutableRanges: immutableRanges(
      artifact.deployedBytecode.immutableReferences,
      contract,
    ),
  };
}

function bundleHash(schema, entries, field) {
  return sha256(
    canonicalJson({
      schema,
      contracts: entries.map((entry) => ({
        contract: entry.contract,
        sha256: entry[field],
      })),
    }),
  );
}

/**
 * Builds release identity without writing anything. Absolute paths, mtimes,
 * Foundry artifact ids/source maps, and JSON formatting are deliberately not
 * part of either bundle hash.
 */
export async function buildReleaseHashManifest(options) {
  const root = options?.root;
  if (typeof root !== "string" || root.length === 0) {
    throw new Error("A contracts root is required.");
  }
  const contracts = [...(options?.contracts ?? CANONICAL_RELEASE_CONTRACTS)].sort((left, right) =>
    left.contract === right.contract ? 0 : left.contract < right.contract ? -1 : 1,
  );
  const names = new Set();
  const entries = [];

  for (const item of contracts) {
    if (
      !item ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item.contract) ||
      !/^[A-Za-z0-9_$.-]+\.sol$/.test(item.source) ||
      names.has(item.contract)
    ) {
      throw new Error("Canonical release contract configuration is invalid.");
    }
    names.add(item.contract);
    const abi = await readJson(join(root, "abi", `${item.contract}.json`), `${item.contract} ABI`);
    const artifact = await readJson(
      join(root, "out", item.source, `${item.contract}.json`),
      `${item.contract} compiled artifact`,
    );
    if (!Array.isArray(abi)) throw new Error(`${item.contract} ABI is not an array.`);
    if (canonicalJson(abi) !== canonicalJson(artifact.abi)) {
      throw new Error(`${item.contract} ABI is stale. Run node scripts/generate-abis.mjs.`);
    }
    const projection = compiledArtifactProjection(artifact, item.contract);
    entries.push({
      contract: item.contract,
      abiFile: `abi/${item.contract}.json`,
      abiSha256: sha256(canonicalJson(abi)),
      artifactFile: `out/${item.source}/${item.contract}.json`,
      artifactSha256: sha256(canonicalJson(projection)),
    });
  }

  return {
    schemaVersion: 1,
    algorithm: "sha256",
    abiBundleSha256: bundleHash("laypipe-abi-bundle-v1", entries, "abiSha256"),
    artifactBundleSha256: bundleHash(
      "laypipe-compiled-artifact-bundle-v1",
      entries,
      "artifactSha256",
    ),
    contracts: entries,
  };
}

function expectedHash(value, label) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a 0x-prefixed 32-byte SHA-256 value.`);
  }
  return value.toLowerCase();
}

export function assertExpectedReleaseHashes(manifest, expected) {
  const abi = expectedHash(expected?.abiBundleSha256, "Expected ABI bundle hash");
  const artifacts = expectedHash(
    expected?.artifactBundleSha256,
    "Expected artifact bundle hash",
  );
  if (manifest.abiBundleSha256 !== abi) {
    throw new Error(
      `ABI bundle SHA-256 mismatch: expected ${abi}, received ${manifest.abiBundleSha256}.`,
    );
  }
  if (manifest.artifactBundleSha256 !== artifacts) {
    throw new Error(
      `Artifact bundle SHA-256 mismatch: expected ${artifacts}, received ${manifest.artifactBundleSha256}.`,
    );
  }
}
