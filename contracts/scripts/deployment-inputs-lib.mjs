import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  CONTRACTS_ROOT,
  PIPEDOG_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  canonicalJson,
  evaluateCurveReview,
} from "./curve-model.mjs";
import { buildReleaseHashManifest } from "./release-hashes-lib.mjs";

export const DEPLOYMENT_INPUTS_SCHEMA_VERSION = 1;
export const DEPLOYMENT_INPUTS_KIND =
  "laypipe-robinhood-deployment-inputs-v1";

export const ROBINHOOD_POOL_MANAGER =
  "0x8366a39cc670b4001a1121b8f6a443a643e40951";
export const FOUNDRY_CREATE2_DEPLOYER =
  "0x4e59b44847b379578588920ca78fbf26c0b4956c";

const MAX_UINT256 = (1n << 256n) - 1n;
const HASH_0X = /^0x[0-9a-fA-F]{64}$/;
const HASH_SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const DEPLOYMENT_SOURCE_PATHS = Object.freeze([
  "foundry.toml",
  "remappings.txt",
  "scripts/install-deps.ps1",
  "scripts/curve-model.mjs",
  "scripts/release-hashes-lib.mjs",
  "scripts/deployment-inputs-lib.mjs",
  "scripts/deployment-inputs.mjs",
  "scripts/rehearse-deployment.mjs",
  "script/DeployLaypipe.s.sol",
  "script/PreflightRobinhood.s.sol",
  "src/PipedogProtocolConfig.sol",
]);

const RELEASE_RELEVANT_PATHS = Object.freeze([
  "contracts/.env.example",
  "contracts/foundry.toml",
  "contracts/remappings.txt",
  "contracts/src",
  "contracts/script",
  "contracts/scripts",
  "contracts/abi",
  "contracts/AUDIT_HANDOFF.md",
  "contracts/CURVE_REVIEW.md",
  "contracts/README.md",
  "contracts/SECURITY.md",
]);

const FORGE_OVERRIDE_PREFIXES = Object.freeze(["FOUNDRY_", "DAPP_"]);
const DEPLOY_SCRIPT_ARTIFACT =
  "out/DeployLaypipe.s.sol/DeployLaypipe.json";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, path, expectedKeys) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${path} must be an object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert(
    canonicalJson(actual) === canonicalJson(expected),
    `${path} keys must be exactly: ${expected.join(", ")}`,
  );
}

function address(value, path) {
  assert(typeof value === "string" && ADDRESS.test(value), `${path} must be an address`);
  const normalized = value.toLowerCase();
  assert(normalized !== "0x0000000000000000000000000000000000000000", `${path} must be nonzero`);
  return normalized;
}

function uintString(value, path, { allowZero = false } = {}) {
  assert(
    typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value),
    `${path} must be a canonical unsigned decimal string`,
  );
  const parsed = BigInt(value);
  assert(parsed <= MAX_UINT256, `${path} exceeds uint256`);
  assert(allowZero || parsed > 0n, `${path} must be greater than zero`);
  return value;
}

function integer(value, path, minimum, maximum) {
  assert(Number.isSafeInteger(value), `${path} must be a JSON safe integer`);
  assert(value >= minimum && value <= maximum, `${path} is out of range`);
  return value;
}

function hash0x(value, path) {
  assert(
    typeof value === "string" && HASH_0X.test(value),
    `${path} must be a 0x-prefixed bytes32 hash`,
  );
  return value.toLowerCase();
}

function hashSha256(value, path) {
  assert(typeof value === "string" && HASH_SHA256.test(value), `${path} must be a sha256-prefixed hash`);
  return value;
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  assert(typeof value === "string" && value.length > 0, `${name} is required`);
  return value;
}

function environmentUint(environment, name, options) {
  return uintString(requiredEnvironment(environment, name), name, options);
}

function environmentInteger(environment, name, minimum, maximum) {
  const raw = requiredEnvironment(environment, name);
  assert(/^-?(?:0|[1-9]\d*)$/.test(raw), `${name} must be a canonical integer`);
  return integer(Number(raw), name, minimum, maximum);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function deploymentSourceEvidence(contractsRoot) {
  const files = [];
  for (const path of DEPLOYMENT_SOURCE_PATHS) {
    const contents = (await readFile(join(contractsRoot, ...path.split("/")), "utf8"))
      .replace(/\r\n?/g, "\n");
    files.push({ path, sha256: sha256(contents) });
  }
  return {
    sha256: sha256(
      canonicalJson({
        schema: "laypipe-deployment-source-bundle-v1",
        files,
      }),
    ),
    files,
  };
}

function foundryOverrideNames(environment) {
  return Object.keys(environment)
    .filter((name) =>
      FORGE_OVERRIDE_PREFIXES.some((prefix) =>
        name.toUpperCase().startsWith(prefix),
      ),
    )
    .sort();
}

export function canonicalForgeEnvironment(environment = process.env) {
  const overrides = foundryOverrideNames(environment);
  assert(
    overrides.length === 0,
    `Foundry/Dapp configuration overrides are forbidden: ${overrides.join(", ")}`,
  );
  return { ...environment };
}

export function spawnFoundrySync(tool, args, options = {}) {
  assert(tool === "forge" || tool === "cast", "unsupported Foundry executable");
  const localName = process.platform === "win32" ? `${tool}.exe` : tool;
  const candidates = [
    tool,
    join(homedir(), ".foundry", "bin", localName),
  ];
  let result;
  for (const executable of candidates) {
    result = spawnSync(executable, args, {
      ...options,
      shell: false,
      windowsHide: true,
    });
    if (!result.error || result.error.code !== "ENOENT") return result;
  }
  return result;
}

async function deployScriptRuntimeCodehash(contractsRoot) {
  const path = join(
    contractsRoot,
    ...DEPLOY_SCRIPT_ARTIFACT.split("/"),
  );
  let artifact;
  try {
    artifact = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read fresh canonical DeployLaypipe artifact at ${DEPLOY_SCRIPT_ARTIFACT}: ${error.message}`,
    );
  }
  const deployed = artifact?.deployedBytecode;
  assert(
    deployed && typeof deployed === "object",
    "DeployLaypipe artifact deployedBytecode is malformed",
  );
  assert(
    typeof deployed.object === "string" &&
      /^0x(?:[0-9a-fA-F]{2})+$/.test(deployed.object),
    "DeployLaypipe artifact runtime bytecode is malformed or empty",
  );
  assert(
    deployed.linkReferences &&
      Object.keys(deployed.linkReferences).length === 0,
    "DeployLaypipe runtime must not contain unresolved library links",
  );
  const result = spawnFoundrySync("cast", ["keccak"], {
    cwd: contractsRoot,
    encoding: "utf8",
    input: deployed.object,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `cast keccak failed with exit code ${result.status}: ${result.stderr}`,
    );
  }
  const codehash = result.stdout.trim().toLowerCase();
  return hash0x(codehash, "DeployLaypipe runtime codehash");
}

function currentCommit(repositoryRoot) {
  const result = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim().toLowerCase();
  assert(COMMIT.test(result), "git HEAD is not a full commit hash");
  return result;
}

function releaseWorktreeChanges(repositoryRoot) {
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...RELEASE_RELEVANT_PATHS],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();
  if (output.length === 0) return [];
  return output.split(/\r?\n/).map((line) => line.slice(3));
}

function parseManifest(manifest) {
  exactKeys(manifest, "manifest", [
    "addresses",
    "approval",
    "candidate",
    "chain",
    "curveReview",
    "economics",
    "kind",
    "schemaVersion",
    "stagedSafety",
  ]);
  assert(
    manifest.schemaVersion === DEPLOYMENT_INPUTS_SCHEMA_VERSION,
    `schemaVersion must be ${DEPLOYMENT_INPUTS_SCHEMA_VERSION}`,
  );
  assert(manifest.kind === DEPLOYMENT_INPUTS_KIND, `kind must be ${DEPLOYMENT_INPUTS_KIND}`);

  exactKeys(manifest.candidate, "candidate", [
    "abiBundleSha256",
    "artifactBundleSha256",
    "deployScriptRuntimeCodehash",
    "deploymentSourceBundleSha256",
    "sourceCommit",
  ]);
  assert(
    typeof manifest.candidate.sourceCommit === "string" &&
      COMMIT.test(manifest.candidate.sourceCommit),
    "candidate.sourceCommit must be a lowercase full git commit",
  );

  exactKeys(manifest.curveReview, "curveReview", ["configHash"]);
  exactKeys(manifest.chain, "chain", [
    "chainId",
    "create2Deployer",
    "pipedog",
    "poolManager",
  ]);
  exactKeys(manifest.addresses, "addresses", [
    "deployer",
    "finalOwner",
    "operationsWallet",
    "treasuryWallet",
  ]);
  exactKeys(manifest.economics, "economics", [
    "launchFeePipedogWei",
    "maxSelfBurnPerCallPipedogWei",
    "maxSequesterPerCallPipedogWei",
    "maxTreasuryRoutePerCallPipedogWei",
    "routerBountyBps",
    "selfBurnBountyBps",
    "startTick",
    "supplyWei",
    "tickSpacing",
  ]);
  exactKeys(manifest.stagedSafety, "stagedSafety", [
    "creatorConfigEnabled",
    "globalLaunchEnabled",
    "selfBurnConfigEnabled",
  ]);
  exactKeys(manifest.approval, "approval", [
    "approvedAt",
    "approver",
    "deploymentInputsHash",
    "status",
  ]);

  const parsed = {
    schemaVersion: manifest.schemaVersion,
    kind: manifest.kind,
    candidate: {
      sourceCommit: manifest.candidate.sourceCommit,
      abiBundleSha256: hash0x(manifest.candidate.abiBundleSha256, "candidate.abiBundleSha256"),
      artifactBundleSha256: hash0x(
        manifest.candidate.artifactBundleSha256,
        "candidate.artifactBundleSha256",
      ),
      deployScriptRuntimeCodehash: hash0x(
        manifest.candidate.deployScriptRuntimeCodehash,
        "candidate.deployScriptRuntimeCodehash",
      ),
      deploymentSourceBundleSha256: hashSha256(
        manifest.candidate.deploymentSourceBundleSha256,
        "candidate.deploymentSourceBundleSha256",
      ),
    },
    curveReview: {
      configHash: hashSha256(manifest.curveReview.configHash, "curveReview.configHash"),
    },
    chain: {
      chainId: integer(manifest.chain.chainId, "chain.chainId", 1, Number.MAX_SAFE_INTEGER),
      pipedog: address(manifest.chain.pipedog, "chain.pipedog"),
      poolManager: address(manifest.chain.poolManager, "chain.poolManager"),
      create2Deployer: address(manifest.chain.create2Deployer, "chain.create2Deployer"),
    },
    addresses: {
      deployer: address(manifest.addresses.deployer, "addresses.deployer"),
      finalOwner: address(manifest.addresses.finalOwner, "addresses.finalOwner"),
      treasuryWallet: address(manifest.addresses.treasuryWallet, "addresses.treasuryWallet"),
      operationsWallet: address(manifest.addresses.operationsWallet, "addresses.operationsWallet"),
    },
    economics: {
      supplyWei: uintString(manifest.economics.supplyWei, "economics.supplyWei"),
      tickSpacing: integer(manifest.economics.tickSpacing, "economics.tickSpacing", 1, 32_767),
      startTick: integer(manifest.economics.startTick, "economics.startTick", -887_272, 887_272),
      launchFeePipedogWei: uintString(
        manifest.economics.launchFeePipedogWei,
        "economics.launchFeePipedogWei",
      ),
      maxSequesterPerCallPipedogWei: uintString(
        manifest.economics.maxSequesterPerCallPipedogWei,
        "economics.maxSequesterPerCallPipedogWei",
      ),
      maxTreasuryRoutePerCallPipedogWei: uintString(
        manifest.economics.maxTreasuryRoutePerCallPipedogWei,
        "economics.maxTreasuryRoutePerCallPipedogWei",
      ),
      maxSelfBurnPerCallPipedogWei: uintString(
        manifest.economics.maxSelfBurnPerCallPipedogWei,
        "economics.maxSelfBurnPerCallPipedogWei",
      ),
      routerBountyBps: integer(manifest.economics.routerBountyBps, "economics.routerBountyBps", 0, 1_000),
      selfBurnBountyBps: integer(
        manifest.economics.selfBurnBountyBps,
        "economics.selfBurnBountyBps",
        0,
        1_000,
      ),
    },
    stagedSafety: {
      globalLaunchEnabled: manifest.stagedSafety.globalLaunchEnabled,
      creatorConfigEnabled: manifest.stagedSafety.creatorConfigEnabled,
      selfBurnConfigEnabled: manifest.stagedSafety.selfBurnConfigEnabled,
    },
    approval: {
      status: manifest.approval.status,
      deploymentInputsHash: manifest.approval.deploymentInputsHash,
      approver: manifest.approval.approver,
      approvedAt: manifest.approval.approvedAt,
    },
  };

  for (const [key, value] of Object.entries(parsed.stagedSafety)) {
    assert(typeof value === "boolean", `stagedSafety.${key} must be boolean`);
  }
  assert(
    parsed.stagedSafety.globalLaunchEnabled === false &&
      parsed.stagedSafety.creatorConfigEnabled === true &&
      parsed.stagedSafety.selfBurnConfigEnabled === false,
    "stagedSafety must leave global launches and self-burn disabled with only creator config staged",
  );
  assert(
    parsed.approval.status === "draft" || parsed.approval.status === "approved",
    "approval.status must be draft or approved",
  );
  assert(typeof parsed.approval.deploymentInputsHash === "string", "approval.deploymentInputsHash must be a string");
  assert(typeof parsed.approval.approver === "string", "approval.approver must be a string");
  assert(typeof parsed.approval.approvedAt === "string", "approval.approvedAt must be a string");

  const policyAddresses = [
    parsed.addresses.finalOwner,
    parsed.addresses.treasuryWallet,
    parsed.addresses.operationsWallet,
  ];
  assert(new Set(policyAddresses).size === policyAddresses.length, "final owner, treasury, and operations must be separate addresses");
  assert(!policyAddresses.includes(parsed.addresses.deployer), "deployer must not be a final owner or revenue destination");
  return parsed;
}

function inputPayload(parsed) {
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key !== "approval"),
  );
}

function bytes32Hex(value, path) {
  assert(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), `${path} must be bytes32`);
  return value.slice(2).toLowerCase();
}

function uint256Word(value, path) {
  const parsed = BigInt(value);
  assert(parsed >= 0n && parsed <= MAX_UINT256, `${path} is outside uint256`);
  return parsed.toString(16).padStart(64, "0");
}

function int256Word(value, path) {
  const parsed = BigInt(value);
  const minimum = -(1n << 255n);
  const maximum = (1n << 255n) - 1n;
  assert(parsed >= minimum && parsed <= maximum, `${path} is outside int256`);
  return (parsed < 0n ? (1n << 256n) + parsed : parsed)
    .toString(16)
    .padStart(64, "0");
}

function addressWord(value, path) {
  return address(value, path).slice(2).padStart(64, "0");
}

function booleanWord(value, path) {
  assert(typeof value === "boolean", `${path} must be boolean`);
  return (value ? "1" : "0").padStart(64, "0");
}

function rawSha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashStringWord(value) {
  return rawSha256Hex(Buffer.from(value, "utf8"));
}

function abiSha256(words) {
  return `0x${rawSha256Hex(Buffer.from(words.join(""), "hex"))}`;
}

function deploymentInputsHash(parsed) {
  const candidateDigest = abiSha256([
    hashStringWord(parsed.candidate.sourceCommit),
    bytes32Hex(parsed.candidate.abiBundleSha256, "candidate.abiBundleSha256"),
    bytes32Hex(parsed.candidate.artifactBundleSha256, "candidate.artifactBundleSha256"),
    bytes32Hex(
      parsed.candidate.deployScriptRuntimeCodehash,
      "candidate.deployScriptRuntimeCodehash",
    ),
    hashStringWord(parsed.candidate.deploymentSourceBundleSha256),
    hashStringWord(parsed.curveReview.configHash),
  ]);
  const chainDigest = abiSha256([
    uint256Word(parsed.chain.chainId, "chain.chainId"),
    addressWord(parsed.chain.pipedog, "chain.pipedog"),
    addressWord(parsed.chain.poolManager, "chain.poolManager"),
    addressWord(parsed.chain.create2Deployer, "chain.create2Deployer"),
  ]);
  const addressesDigest = abiSha256([
    addressWord(parsed.addresses.deployer, "addresses.deployer"),
    addressWord(parsed.addresses.finalOwner, "addresses.finalOwner"),
    addressWord(parsed.addresses.treasuryWallet, "addresses.treasuryWallet"),
    addressWord(parsed.addresses.operationsWallet, "addresses.operationsWallet"),
  ]);
  const economicsDigest = abiSha256([
    uint256Word(parsed.economics.supplyWei, "economics.supplyWei"),
    int256Word(parsed.economics.tickSpacing, "economics.tickSpacing"),
    int256Word(parsed.economics.startTick, "economics.startTick"),
    uint256Word(parsed.economics.launchFeePipedogWei, "economics.launchFeePipedogWei"),
    uint256Word(parsed.economics.maxSequesterPerCallPipedogWei, "economics.maxSequesterPerCallPipedogWei"),
    uint256Word(parsed.economics.maxTreasuryRoutePerCallPipedogWei, "economics.maxTreasuryRoutePerCallPipedogWei"),
    uint256Word(parsed.economics.maxSelfBurnPerCallPipedogWei, "economics.maxSelfBurnPerCallPipedogWei"),
    uint256Word(parsed.economics.routerBountyBps, "economics.routerBountyBps"),
    uint256Word(parsed.economics.selfBurnBountyBps, "economics.selfBurnBountyBps"),
  ]);
  const safetyDigest = abiSha256([
    booleanWord(parsed.stagedSafety.globalLaunchEnabled, "stagedSafety.globalLaunchEnabled"),
    booleanWord(parsed.stagedSafety.creatorConfigEnabled, "stagedSafety.creatorConfigEnabled"),
    booleanWord(parsed.stagedSafety.selfBurnConfigEnabled, "stagedSafety.selfBurnConfigEnabled"),
  ]);
  const digest = abiSha256([
    uint256Word(parsed.schemaVersion, "schemaVersion"),
    hashStringWord(parsed.kind),
    bytes32Hex(candidateDigest, "candidateDigest"),
    bytes32Hex(chainDigest, "chainDigest"),
    bytes32Hex(addressesDigest, "addressesDigest"),
    bytes32Hex(economicsDigest, "economicsDigest"),
    bytes32Hex(safetyDigest, "safetyDigest"),
  ]);
  return `sha256:${digest.slice(2)}`;
}

function addMismatch(issues, code, path, expected, actual) {
  if (expected !== actual) issues.push({ code, path, expected, actual });
}

function environmentInputs(environment) {
  return {
    addresses: {
      deployer: address(requiredEnvironment(environment, "DEPLOYER_ADDRESS"), "DEPLOYER_ADDRESS"),
      finalOwner: address(requiredEnvironment(environment, "FINAL_OWNER"), "FINAL_OWNER"),
      treasuryWallet: address(requiredEnvironment(environment, "TREASURY_WALLET"), "TREASURY_WALLET"),
      operationsWallet: address(requiredEnvironment(environment, "OPERATIONS_WALLET"), "OPERATIONS_WALLET"),
    },
    economics: {
      supplyWei: environmentUint(environment, "LAYPIPE_SUPPLY_WEI"),
      tickSpacing: environmentInteger(environment, "LAYPIPE_TICK_SPACING", 1, 32_767),
      startTick: environmentInteger(environment, "LAYPIPE_START_TICK", -887_272, 887_272),
      launchFeePipedogWei: environmentUint(environment, "LAYPIPE_LAUNCH_FEE_PIPEDOG_WEI"),
      maxSequesterPerCallPipedogWei: environmentUint(
        environment,
        "MAX_SEQUESTER_PER_CALL_PIPEDOG_WEI",
      ),
      maxTreasuryRoutePerCallPipedogWei: environmentUint(
        environment,
        "MAX_TREASURY_ROUTE_PER_CALL_PIPEDOG_WEI",
      ),
      maxSelfBurnPerCallPipedogWei: environmentUint(
        environment,
        "MAX_SELF_BURN_PER_CALL_PIPEDOG_WEI",
      ),
      routerBountyBps: environmentInteger(environment, "ROUTER_BOUNTY_BPS", 0, 1_000),
      selfBurnBountyBps: environmentInteger(environment, "SELF_BURN_BOUNTY_BPS", 0, 1_000),
    },
  };
}

export async function currentDeploymentEvidence({
  contractsRoot = CONTRACTS_ROOT,
  repositoryRoot = resolve(contractsRoot, ".."),
  requireClean = true,
  environment = process.env,
} = {}) {
  canonicalForgeEnvironment(environment);
  const changes = releaseWorktreeChanges(repositoryRoot);
  if (requireClean && changes.length > 0) {
    throw new Error(
      `release-relevant worktree is not clean: ${changes.slice(0, 8).join(", ")}`,
    );
  }
  const [release, sources, runtimeCodehash] = await Promise.all([
    buildReleaseHashManifest({ root: contractsRoot }),
    deploymentSourceEvidence(contractsRoot),
    deployScriptRuntimeCodehash(contractsRoot),
  ]);
  return {
    sourceCommit: currentCommit(repositoryRoot),
    abiBundleSha256: release.abiBundleSha256,
    artifactBundleSha256: release.artifactBundleSha256,
    deployScriptRuntimeCodehash: runtimeCodehash,
    deploymentSourceBundleSha256: sources.sha256,
    deploymentSourceFiles: sources.files,
    releaseWorktreeChanges: changes,
  };
}

export async function draftDeploymentInputs({
  review,
  environment,
  contractsRoot = CONTRACTS_ROOT,
  repositoryRoot = resolve(contractsRoot, ".."),
  requireClean = true,
}) {
  const curve = await evaluateCurveReview(review, { contractsRoot });
  if (curve.gate.status !== "pass") {
    throw new Error("the curve review must pass before deployment inputs can be drafted");
  }
  const [candidate, inputs] = await Promise.all([
    currentDeploymentEvidence({
      contractsRoot,
      repositoryRoot,
      requireClean,
      environment,
    }),
    Promise.resolve(environmentInputs(environment)),
  ]);
  return {
    schemaVersion: DEPLOYMENT_INPUTS_SCHEMA_VERSION,
    kind: DEPLOYMENT_INPUTS_KIND,
    candidate: {
      sourceCommit: candidate.sourceCommit,
      abiBundleSha256: candidate.abiBundleSha256,
      artifactBundleSha256: candidate.artifactBundleSha256,
      deployScriptRuntimeCodehash:
        candidate.deployScriptRuntimeCodehash,
      deploymentSourceBundleSha256: candidate.deploymentSourceBundleSha256,
    },
    curveReview: { configHash: curve.gate.computedConfigHash },
    chain: {
      chainId: ROBINHOOD_CHAIN_ID,
      pipedog: PIPEDOG_ADDRESS,
      poolManager: ROBINHOOD_POOL_MANAGER,
      create2Deployer: FOUNDRY_CREATE2_DEPLOYER,
    },
    addresses: inputs.addresses,
    economics: inputs.economics,
    stagedSafety: {
      globalLaunchEnabled: false,
      creatorConfigEnabled: true,
      selfBurnConfigEnabled: false,
    },
    approval: {
      status: "draft",
      deploymentInputsHash: "",
      approver: "",
      approvedAt: "",
    },
  };
}

export async function evaluateDeploymentInputs({
  manifest,
  review,
  environment,
  contractsRoot = CONTRACTS_ROOT,
  repositoryRoot = resolve(contractsRoot, ".."),
  requireClean = true,
}) {
  const parsed = parseManifest(manifest);
  const [curve, candidate] = await Promise.all([
    evaluateCurveReview(review, { contractsRoot }),
    currentDeploymentEvidence({
      contractsRoot,
      repositoryRoot,
      requireClean,
      environment,
    }),
  ]);
  const inputs = environmentInputs(environment);
  const computedDeploymentInputsHash = deploymentInputsHash(parsed);
  const issues = [];

  if (curve.gate.status !== "pass") {
    issues.push({ code: "CURVE_REVIEW_NOT_APPROVED", curveIssues: curve.gate.issues });
  }
  addMismatch(
    issues,
    "CURVE_CONFIG_HASH_MISMATCH",
    "curveReview.configHash",
    curve.gate.computedConfigHash,
    parsed.curveReview.configHash,
  );
  for (const key of [
    "sourceCommit",
    "abiBundleSha256",
    "artifactBundleSha256",
    "deployScriptRuntimeCodehash",
    "deploymentSourceBundleSha256",
  ]) {
    addMismatch(issues, "CANDIDATE_MISMATCH", `candidate.${key}`, candidate[key], parsed.candidate[key]);
  }
  addMismatch(issues, "CHAIN_MISMATCH", "chain.chainId", ROBINHOOD_CHAIN_ID, parsed.chain.chainId);
  addMismatch(issues, "CHAIN_MISMATCH", "chain.pipedog", PIPEDOG_ADDRESS, parsed.chain.pipedog);
  addMismatch(issues, "CHAIN_MISMATCH", "chain.poolManager", ROBINHOOD_POOL_MANAGER, parsed.chain.poolManager);
  addMismatch(
    issues,
    "CHAIN_MISMATCH",
    "chain.create2Deployer",
    FOUNDRY_CREATE2_DEPLOYER,
    parsed.chain.create2Deployer,
  );

  for (const key of Object.keys(inputs.addresses)) {
    addMismatch(issues, "ENVIRONMENT_MISMATCH", `addresses.${key}`, parsed.addresses[key], inputs.addresses[key]);
  }
  for (const key of Object.keys(inputs.economics)) {
    addMismatch(issues, "ENVIRONMENT_MISMATCH", `economics.${key}`, parsed.economics[key], inputs.economics[key]);
  }

  const reviewed = review.launchConfig;
  addMismatch(issues, "CURVE_INPUT_MISMATCH", "economics.supplyWei", reviewed.supplyWei, parsed.economics.supplyWei);
  addMismatch(issues, "CURVE_INPUT_MISMATCH", "economics.tickSpacing", reviewed.tickSpacing, parsed.economics.tickSpacing);
  addMismatch(issues, "CURVE_INPUT_MISMATCH", "economics.startTick", reviewed.startTick, parsed.economics.startTick);
  addMismatch(
    issues,
    "CURVE_INPUT_MISMATCH",
    "economics.launchFeePipedogWei",
    reviewed.launchFeePipedogWei,
    parsed.economics.launchFeePipedogWei,
  );

  if (parsed.approval.status !== "approved") {
    issues.push({ code: "DEPLOYMENT_APPROVAL_REQUIRED" });
  }
  if (parsed.approval.deploymentInputsHash !== computedDeploymentInputsHash) {
    issues.push({
      code: "DEPLOYMENT_INPUTS_HASH_MISMATCH",
      expected: computedDeploymentInputsHash,
      actual: parsed.approval.deploymentInputsHash,
    });
  }
  if (
    parsed.approval.status === "approved" &&
    (parsed.approval.approver.trim().length === 0 ||
      parsed.approval.approver.length > 256 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(parsed.approval.approvedAt) ||
      !Number.isFinite(Date.parse(parsed.approval.approvedAt)))
  ) {
    issues.push({ code: "DEPLOYMENT_APPROVAL_METADATA_REQUIRED" });
  }

  return {
    schemaVersion: DEPLOYMENT_INPUTS_SCHEMA_VERSION,
    kind: DEPLOYMENT_INPUTS_KIND,
    gate: {
      status: issues.length === 0 ? "pass" : "fail",
      computedDeploymentInputsHash,
      approvedDeploymentInputsHash: parsed.approval.deploymentInputsHash,
      issues,
    },
    candidate,
    exactInputs: inputPayload(parsed),
  };
}

export function forgeBuildArguments() {
  return ["build", "--root", "."];
}

export function forgeSimulationArguments(rpcAlias) {
  assert(typeof rpcAlias === "string" && /^[A-Za-z0-9_-]+$/.test(rpcAlias), "RPC alias must be a foundry.toml endpoint name");
  return [
    "script",
    "script/DeployLaypipe.s.sol:DeployLaypipe",
    "--root",
    ".",
    "--rpc-url",
    rpcAlias,
    "-vvv",
  ];
}

export const __test = Object.freeze({
  DEPLOYMENT_SOURCE_PATHS,
  DEPLOY_SCRIPT_ARTIFACT,
  FORGE_OVERRIDE_PREFIXES,
  RELEASE_RELEVANT_PATHS,
  deploymentInputsHash,
  deployScriptRuntimeCodehash,
  foundryOverrideNames,
  parseManifest,
  releaseWorktreeChanges,
});
