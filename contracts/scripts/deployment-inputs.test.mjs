import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONTRACTS_ROOT, evaluateCurveReview, MODEL_ID } from "./curve-model.mjs";
import {
  __test,
  canonicalForgeEnvironment,
  draftDeploymentInputs,
  evaluateDeploymentInputs,
  forgeBuildArguments,
  forgeSimulationArguments,
} from "./deployment-inputs-lib.mjs";

function environmentFixture() {
  return {
    DEPLOYER_ADDRESS: "0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7",
    FINAL_OWNER: "0x1111111111111111111111111111111111111111",
    TREASURY_WALLET: "0x2222222222222222222222222222222222222222",
    OPERATIONS_WALLET: "0x3333333333333333333333333333333333333333",
    LAYPIPE_SUPPLY_WEI: "1000000000000000000000000000",
    LAYPIPE_TICK_SPACING: "200",
    LAYPIPE_START_TICK: "69000",
    LAYPIPE_LAUNCH_FEE_PIPEDOG_WEI: "1000000000000000000",
    MAX_SEQUESTER_PER_CALL_PIPEDOG_WEI: "1000000000000000000000",
    MAX_TREASURY_ROUTE_PER_CALL_PIPEDOG_WEI: "1000000000000000000000",
    MAX_SELF_BURN_PER_CALL_PIPEDOG_WEI: "100000000000000000000",
    ROUTER_BOUNTY_BPS: "25",
    SELF_BURN_BOUNTY_BPS: "25",
  };
}

function reviewFixture() {
  return {
    schemaVersion: 1,
    model: MODEL_ID,
    chainId: 4663,
    quoteToken: "0x5Cb6F181081301b44905F3ae15419112ecaBd8A6",
    quoteDecimals: 18,
    tokenDecimals: 18,
    launchConfig: {
      supplyWei: "1000000000000000000000000000",
      tickSpacing: 200,
      startTick: 69000,
      creatorFeeBps: 7000,
      baseFeeRatePips: 10000,
      launchFeeRatePips: 10000,
      launchFeeDecaySeconds: 0,
      launchFeePipedogWei: "1000000000000000000",
      selfBurn: false,
      enabled: true,
    },
    reviewBounds: {
      targetInitialFdvPipedogWei: "1000000000000000000000000",
      maxInitialFdvErrorBps: 100,
      maxLaunchFeeBpsOfTargetFdv: 100,
      minimumNetCurveCapacityPipedogWei: "1000000000000000000000000",
      maxSeedDustTokenWei: "12",
      representativeBuys: [
        {
          label: "small",
          grossPipedogInWei: "10000000000000000000",
          buyFeeRatePips: 10000,
          sellFeeRatePips: 10000,
          minTokensOutWei: "9000000000000000000000",
          maxSpotPriceImpactBps: 1,
          maxAverageGrossPriceImpactBps: 200,
          maxRoundTripLossBps: 199,
        },
        {
          label: "medium",
          grossPipedogInWei: "100000000000000000000",
          buyFeeRatePips: 10000,
          sellFeeRatePips: 10000,
          minTokensOutWei: "90000000000000000000000",
          maxSpotPriceImpactBps: 2,
          maxAverageGrossPriceImpactBps: 200,
          maxRoundTripLossBps: 199,
        },
        {
          label: "large",
          grossPipedogInWei: "1000000000000000000000",
          buyFeeRatePips: 10000,
          sellFeeRatePips: 10000,
          minTokensOutWei: "900000000000000000000000",
          maxSpotPriceImpactBps: 20,
          maxAverageGrossPriceImpactBps: 200,
          maxRoundTripLossBps: 199,
        },
      ],
    },
    approval: {
      status: "draft",
      configHash: "",
      reviewer: "",
      reviewedAt: "",
    },
  };
}

async function approvedReview() {
  const review = reviewFixture();
  const draft = await evaluateCurveReview(review);
  review.approval = {
    status: "approved",
    configHash: draft.gate.computedConfigHash,
    reviewer: "automated-test-fixture-not-production-signoff",
    reviewedAt: "2000-01-01T00:00:00Z",
  };
  assert.equal((await evaluateCurveReview(review)).gate.status, "pass");
  return review;
}

async function approvedManifest(review, environment) {
  const manifest = await draftDeploymentInputs({ review, environment, requireClean: false });
  const draft = await evaluateDeploymentInputs({ manifest, review, environment, requireClean: false });
  assert.equal(draft.gate.status, "fail");
  assert.match(draft.gate.computedDeploymentInputsHash, /^sha256:[0-9a-f]{64}$/);
  manifest.approval = {
    status: "approved",
    deploymentInputsHash: draft.gate.computedDeploymentInputsHash,
    approver: "automated-test-fixture-not-production-signoff",
    approvedAt: "2000-01-01T00:00:00Z",
  };
  return manifest;
}

test("exact approved deployment inputs bind review, candidate, and Forge environment", async () => {
  const environment = environmentFixture();
  const review = await approvedReview();
  const manifest = await approvedManifest(review, environment);
  // The unit fixture runs from the deliberately edited candidate under test.
  const report = await evaluateDeploymentInputs({ manifest, review, environment, requireClean: false });
  assert.equal(report.gate.status, "pass");
  assert.deepEqual(report.gate.issues, []);
});

test("every DeployLaypipe address and economic environment input fails closed on mutation", async () => {
  const environment = environmentFixture();
  const review = await approvedReview();
  const manifest = await approvedManifest(review, environment);
  const mutations = {
    DEPLOYER_ADDRESS: "0x4444444444444444444444444444444444444444",
    FINAL_OWNER: "0x5555555555555555555555555555555555555555",
    TREASURY_WALLET: "0x6666666666666666666666666666666666666666",
    OPERATIONS_WALLET: "0x7777777777777777777777777777777777777777",
    LAYPIPE_SUPPLY_WEI: "1000000000000000000000000001",
    LAYPIPE_TICK_SPACING: "201",
    LAYPIPE_START_TICK: "69200",
    LAYPIPE_LAUNCH_FEE_PIPEDOG_WEI: "1000000000000000001",
    MAX_SEQUESTER_PER_CALL_PIPEDOG_WEI: "1000000000000000000001",
    MAX_TREASURY_ROUTE_PER_CALL_PIPEDOG_WEI: "1000000000000000000001",
    MAX_SELF_BURN_PER_CALL_PIPEDOG_WEI: "100000000000000000001",
    ROUTER_BOUNTY_BPS: "26",
    SELF_BURN_BOUNTY_BPS: "26",
  };
  for (const [name, value] of Object.entries(mutations)) {
    const report = await evaluateDeploymentInputs({
      manifest,
      review,
      environment: { ...environment, [name]: value },
      requireClean: false,
    });
    assert.equal(report.gate.status, "fail", name);
    assert.ok(
      report.gate.issues.some((issue) => issue.code === "ENVIRONMENT_MISMATCH"),
      name,
    );
  }
});

test("manifest or approval hash mutation cannot reuse a deployment approval", async () => {
  const environment = environmentFixture();
  const review = await approvedReview();
  const manifest = await approvedManifest(review, environment);

  const changedManifest = structuredClone(manifest);
  changedManifest.economics.maxSequesterPerCallPipedogWei =
    "1000000000000000000001";
  const changed = await evaluateDeploymentInputs({
    manifest: changedManifest,
    review,
    environment,
    requireClean: false,
  });
  assert.equal(changed.gate.status, "fail");
  assert.ok(
    changed.gate.issues.some(
      (issue) => issue.code === "DEPLOYMENT_INPUTS_HASH_MISMATCH",
    ),
  );

  const coordinatedManifest = structuredClone(manifest);
  coordinatedManifest.economics.routerBountyBps = 26;
  const coordinated = await evaluateDeploymentInputs({
    manifest: coordinatedManifest,
    review,
    environment: { ...environment, ROUTER_BOUNTY_BPS: "26" },
    requireClean: false,
  });
  assert.equal(coordinated.gate.status, "fail");
  assert.ok(
    coordinated.gate.issues.some(
      (issue) => issue.code === "DEPLOYMENT_INPUTS_HASH_MISMATCH",
    ),
  );

  const badHash = structuredClone(manifest);
  badHash.approval.deploymentInputsHash = `sha256:${"00".repeat(32)}`;
  const hashReport = await evaluateDeploymentInputs({
    manifest: badHash,
    review,
    environment,
    requireClean: false,
  });
  assert.equal(hashReport.gate.status, "fail");
  assert.ok(
    hashReport.gate.issues.some(
      (issue) => issue.code === "DEPLOYMENT_INPUTS_HASH_MISMATCH",
    ),
  );

  const wrongRuntime = structuredClone(manifest);
  wrongRuntime.candidate.deployScriptRuntimeCodehash = `0x${"11".repeat(32)}`;
  const runtimeReport = await evaluateDeploymentInputs({
    manifest: wrongRuntime,
    review,
    environment,
    requireClean: false,
  });
  assert.equal(runtimeReport.gate.status, "fail");
  assert.ok(
    runtimeReport.gate.issues.some(
      (issue) =>
        issue.code === "CANDIDATE_MISMATCH" &&
        issue.path === "candidate.deployScriptRuntimeCodehash",
    ),
  );
  assert.ok(
    runtimeReport.gate.issues.some(
      (issue) => issue.code === "DEPLOYMENT_INPUTS_HASH_MISMATCH",
    ),
  );
});

test("the rehearsal command is structurally no-broadcast and rejects broadcast flags", () => {
  assert.deepEqual(forgeBuildArguments(), ["build", "--root", "."]);
  const args = forgeSimulationArguments("robinhood");
  assert.deepEqual(args, [
    "script",
    "script/DeployLaypipe.s.sol:DeployLaypipe",
    "--root",
    ".",
    "--rpc-url",
    "robinhood",
    "-vvv",
  ]);
  assert.equal(args.includes("--broadcast"), false);
  assert.equal(args.includes("--resume"), false);

  const source = readFileSync(
    new URL("./rehearse-deployment.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /fileURLToPath\(new URL\("\.\.\/", import\.meta\.url\)\)/);
  assert.doesNotMatch(source, /import\.meta\.url\)\.pathname/);

  const attempt = spawnSync(
    process.execPath,
    ["scripts/rehearse-deployment.mjs", "--broadcast"],
    { cwd: new URL("../", import.meta.url), encoding: "utf8" },
  );
  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /Unknown argument: --broadcast/);
});

test("Foundry and Dapp overrides cannot redirect the hashed build or rehearsal", () => {
  for (const name of [
    "FOUNDRY_OUT",
    "FOUNDRY_SRC",
    "FOUNDRY_LIBS",
    "FOUNDRY_PROFILE",
    "DAPP_OUT",
  ]) {
    assert.throws(
      () => canonicalForgeEnvironment({ PATH: process.env.PATH, [name]: "alternate" }),
      new RegExp(name),
    );
  }

  const attempt = spawnSync(
    process.execPath,
    [
      "scripts/rehearse-deployment.mjs",
      "--review",
      "not-read.json",
      "--manifest",
      "not-read.json",
      "--rpc-alias",
      "robinhood",
    ],
    {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, FOUNDRY_OUT: "alternate-out" },
    },
  );
  assert.equal(attempt.status, 1);
  assert.match(attempt.stderr, /Foundry\/Dapp configuration overrides are forbidden: FOUNDRY_OUT/);
  assert.doesNotMatch(attempt.stderr, /Cannot read curve review/);
});

test("the clean-candidate gate rejects dirty tests, provenance, and keeper policy", () => {
  assert.ok(__test.RELEASE_RELEVANT_PATHS.includes("contracts/test"));
  assert.ok(__test.RELEASE_RELEVANT_PATHS.includes("contracts/reference"));
  assert.ok(__test.RELEASE_RELEVANT_PATHS.includes("contracts/KEEPERS.md"));

  const repositoryRoot = mkdtempSync(join(tmpdir(), "laypipe-release-gate-"));
  const testPath = join(repositoryRoot, "contracts", "test", "Candidate.t.sol");
  const referencePath = join(
    repositoryRoot,
    "contracts",
    "reference",
    "adaptation-deltas.json",
  );
  const keepersPath = join(repositoryRoot, "contracts", "KEEPERS.md");
  const runGit = (args) => {
    const result = spawnSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(
      result.status,
      0,
      `git ${args.join(" ")} failed: ${result.stderr || result.error?.message}`,
    );
  };

  try {
    mkdirSync(join(repositoryRoot, "contracts", "test"), { recursive: true });
    mkdirSync(join(repositoryRoot, "contracts", "reference"), { recursive: true });
    writeFileSync(testPath, "contract CandidateTest {}\n", "utf8");
    writeFileSync(referencePath, "{\"status\":\"reviewed\"}\n", "utf8");
    writeFileSync(keepersPath, "# Keeper policy\n", "utf8");
    runGit(["init", "--quiet"]);
    runGit(["config", "user.email", "release-gate@example.invalid"]);
    runGit(["config", "user.name", "Release Gate"]);
    runGit([
      "add",
      "contracts/test/Candidate.t.sol",
      "contracts/reference/adaptation-deltas.json",
      "contracts/KEEPERS.md",
    ]);
    runGit(["commit", "--quiet", "-m", "fixture"]);

    writeFileSync(testPath, "contract WeakenedCandidateTest {}\n", "utf8");
    assert.deepEqual(__test.releaseWorktreeChanges(repositoryRoot), [
      "contracts/test/Candidate.t.sol",
    ]);

    writeFileSync(testPath, "contract CandidateTest {}\n", "utf8");
    writeFileSync(referencePath, "{\"status\":\"unreviewed\"}\n", "utf8");
    assert.deepEqual(__test.releaseWorktreeChanges(repositoryRoot), [
      "contracts/reference/adaptation-deltas.json",
    ]);

    writeFileSync(referencePath, "{\"status\":\"reviewed\"}\n", "utf8");
    writeFileSync(keepersPath, "# Altered keeper policy\n", "utf8");
    assert.deepEqual(__test.releaseWorktreeChanges(repositoryRoot), [
      "contracts/KEEPERS.md",
    ]);
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("deployment evidence binds its verifier and the raw Forge path has an in-script gate", () => {
  for (const path of [
    "scripts/curve-model.mjs",
    "scripts/release-hashes-lib.mjs",
    "scripts/deployment-inputs-lib.mjs",
    "scripts/deployment-inputs.mjs",
    "scripts/rehearse-deployment.mjs",
    "script/DeployLaypipe.s.sol",
  ]) {
    assert.ok(__test.DEPLOYMENT_SOURCE_PATHS.includes(path), path);
  }
  const deploymentSource = readFileSync(
    new URL("../script/DeployLaypipe.s.sol", import.meta.url),
    "utf8",
  );
  assert.match(deploymentSource, /_requireApprovedDeploymentInputs\([\s\S]*?\);[\s\S]*?vm\.startBroadcast/);
  assert.match(deploymentSource, /LAYPIPE_DEPLOYMENT_INPUTS_PATH/);
  assert.match(deploymentSource, /LAYPIPE_APPROVED_DEPLOYMENT_INPUTS_HASH/);
  assert.match(deploymentSource, /address\(this\)\.codehash/);
  assert.match(deploymentSource, /\.candidate\.deployScriptRuntimeCodehash/);
  assert.match(deploymentSource, /\.economics\.maxSelfBurnPerCallPipedogWei/);
  assert.match(deploymentSource, /\.stagedSafety\.selfBurnConfigEnabled/);
});

test("deployment scripts bind the revenue router to an already deployed paused factory", () => {
  for (const relativePath of [
    "../script/DeployLaypipe.s.sol",
    "../script/DeployLaypipeBaseSepolia.s.sol",
  ]) {
    const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
    const proxy = source.indexOf("ERC1967Proxy proxy =");
    const router = source.indexOf("new PipedogRevenueRouter(");
    const binding = source.indexOf("factory.setTreasury(address(revenueRouter));");
    const hook = source.indexOf("PipedogHook hook =");

    assert.ok(proxy >= 0, `${relativePath}: factory proxy deployment missing`);
    assert.ok(router > proxy, `${relativePath}: revenue router must follow the factory proxy`);
    assert.ok(binding > router, `${relativePath}: factory must bind the revenue router`);
    assert.ok(hook > binding, `${relativePath}: hook must follow the final treasury binding`);
    assert.match(
      source.slice(router, binding),
      /new PipedogRevenueRouter\([\s\S]*?address\(factory\)/,
      `${relativePath}: revenue router constructor must pin the factory`,
    );
  }
});

test("committed ABI-SHA256 parity vector and runtime codehash match fresh artifacts", async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../test/fixtures/deployment-inputs-approved.json", import.meta.url),
      "utf8",
    ),
  );
  const { test: vector, ...manifest } = fixture;
  const parsed = __test.parseManifest(manifest);
  const digest = __test.deploymentInputsHash(parsed);
  assert.equal(digest, manifest.approval.deploymentInputsHash);
  assert.equal(`0x${digest.slice("sha256:".length)}`, vector.expectedDeploymentInputsHash);
  assert.equal(
    manifest.candidate.deployScriptRuntimeCodehash,
    await __test.deployScriptRuntimeCodehash(CONTRACTS_ROOT),
  );
});
