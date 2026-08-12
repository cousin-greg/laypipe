import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  calibrateAlignedTick,
  evaluateCurveReview,
  getSqrtPriceAtTick,
  MODEL_ID,
  Q192,
  WAD,
} from "../contracts/scripts/curve-model.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "..");

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
      launchFeePipedogWei: "0",
      selfBurn: false,
      enabled: true,
    },
    reviewBounds: {
      targetInitialFdvPipedogWei: "1000000000000000000000000",
      maxInitialFdvErrorBps: 100,
      maxLaunchFeeBpsOfTargetFdv: 100,
      minimumNetCurveCapacityPipedogWei:
        "1000000000000000000000000",
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

async function approve(review) {
  const draft = await evaluateCurveReview(review);
  assert.equal(draft.gate.status, "fail");
  assert.match(draft.gate.computedConfigHash, /^sha256:[0-9a-f]{64}$/);
  review.approval = {
    status: "approved",
    configHash: draft.gate.computedConfigHash,
    reviewer: "automated-test-fixture-not-production-signoff",
    reviewedAt: "2000-01-01T00:00:00Z",
  };
  return review;
}

test("integer TickMath port matches Uniswap boundary anchors", () => {
  assert.equal(getSqrtPriceAtTick(-887272), 4295128739n);
  assert.equal(getSqrtPriceAtTick(0), 79228162514264337593543950336n);
  assert.equal(
    getSqrtPriceAtTick(887272),
    1461446703485210103287273052203988822378723970342n,
  );

  const legacySqrt = getSqrtPriceAtTick(204200);
  const legacyFdv =
    (1_000_000_000n * WAD * Q192) / (legacySqrt * legacySqrt);
  assert.equal(legacyFdv, 1355657760817103798n);
});

test("calibration chooses the closest aligned tick without floating math", () => {
  const calibration = calibrateAlignedTick({
    supplyWei: 1_000_000_000n * WAD,
    targetFdvPipedogWei: 1_000_000n * WAD,
    tickSpacing: 200,
  });
  assert.equal(calibration.selected.tick, 69000);
  assert.equal(calibration.alternatives[0].tick, 69200);
  assert.equal(
    calibration.selected.impliedFdv,
    1008133151818936791455198n,
  );
});

test("draft review fails closed and prints the hash that needs signoff", async () => {
  const report = await evaluateCurveReview(reviewFixture());
  assert.equal(report.gate.status, "fail");
  assert.deepEqual(
    report.gate.issues.map((entry) => entry.code),
    ["APPROVAL_REQUIRED", "CONFIG_HASH_MISMATCH"],
  );
  assert.match(report.gate.computedConfigHash, /^sha256:[0-9a-f]{64}$/);
});

test("exact approved fixture reports depth, fee effects, impact, and reversal", async () => {
  const review = await approve(reviewFixture());
  const report = await evaluateCurveReview(review);
  assert.equal(report.gate.status, "pass");
  assert.deepEqual(report.gate.issues, []);
  assert.equal(report.launchBoundary.burnedSeedDust.baseUnits, "12");
  assert.equal(report.launchBoundary.initialFdvErrorBpsCeiling, "82");
  assert.equal(
    report.launchBoundary.initialPipedogPerTokenWad,
    "1008133151818936",
  );
  assert.equal(
    report.launchBoundary.curveEconomicsHelperImpliedInitialFdv.baseUnits,
    "1008133151818936791455476",
  );
  assert.equal(
    report.exhaustionBoundary.netPoolPipedogCapacity.baseUnits,
    "583578071468383031898559486237983839937876484",
  );
  assert.equal(
    report.exhaustionBoundary
      .theoreticalOneBaseUnitAboveBoundaryNetInput.baseUnits,
    (
      BigInt(
        report.exhaustionBoundary.netPoolPipedogCapacity.baseUnits,
      ) + 1n
    ).toString(),
  );
  assert.equal(
    report.exhaustionBoundary.grossBoundaryFitsConservativeSingleSwapInt128,
    false,
  );
  assert.equal(
    report.exhaustionBoundary.oneBaseUnitAboveWouldBeExecutablePartialFill,
    false,
  );
  assert.deepEqual(
    report.representativeBuys.map((entry) => ({
      label: entry.label,
      impact: entry.buy.endingSpotPriceImpactBpsCeiling,
      loss: entry.sellSideReversal.roundTripLossBpsCeiling,
    })),
    [
      { label: "small", impact: "1", loss: "199" },
      { label: "medium", impact: "2", loss: "199" },
      { label: "large", impact: "20", loss: "199" },
    ],
  );
});

test("any post-approval input mutation invalidates the approval hash", async () => {
  const review = await approve(reviewFixture());
  review.reviewBounds.representativeBuys[0].maxSpotPriceImpactBps = 2;
  const report = await evaluateCurveReview(review);
  assert.equal(report.gate.status, "fail");
  assert.ok(
    report.gate.issues.some(
      (entry) => entry.code === "CONFIG_HASH_MISMATCH",
    ),
  );
});

test("an enabled self-burn config cannot receive a passing curve approval", async () => {
  const review = reviewFixture();
  review.launchConfig.selfBurn = true;
  const approved = await approve(review);
  const report = await evaluateCurveReview(approved);
  assert.equal(report.gate.status, "fail");
  assert.ok(
    report.gate.issues.some(
      (entry) => entry.code === "SELF_BURN_PRICE_GUARD_MISSING",
    ),
  );
});

test("launch fee is checked against the reviewer-selected FDV bound", async () => {
  const review = reviewFixture();
  review.launchConfig.launchFeePipedogWei =
    "20000000000000000000000";
  const approved = await approve(review);
  const report = await evaluateCurveReview(approved);
  assert.equal(report.gate.status, "fail");
  assert.ok(
    report.gate.issues.some(
      (entry) => entry.code === "LAUNCH_FEE_LIMIT_EXCEEDED",
    ),
  );
});

test("fee-inclusive execution impact has its own approved ceiling", async () => {
  const review = reviewFixture();
  review.reviewBounds.representativeBuys[0]
    .maxAverageGrossPriceImpactBps = 100;
  const approved = await approve(review);
  const report = await evaluateCurveReview(approved);
  assert.equal(report.gate.status, "fail");
  assert.ok(
    report.gate.issues.some(
      (entry) =>
        entry.code ===
        "SCENARIO_AVERAGE_GROSS_PRICE_IMPACT_LIMIT_EXCEEDED",
    ),
  );
});

test("unsafe bounds and boundary-crossing scenarios cannot pass", async () => {
  const review = reviewFixture();
  review.reviewBounds.maxInitialFdvErrorBps = 1;
  review.reviewBounds.representativeBuys[2].grossPipedogInWei =
    "600000000000000000000000000000000000000000000";
  const approved = await approve(review);
  const report = await evaluateCurveReview(approved);
  const codes = new Set(report.gate.issues.map((entry) => entry.code));
  assert.equal(report.gate.status, "fail");
  assert.ok(codes.has("INITIAL_FDV_ERROR_LIMIT_EXCEEDED"));
  assert.ok(codes.has("SCENARIO_GROSS_INPUT_EXCEEDS_INT128"));
  assert.ok(codes.has("SCENARIO_PARTIAL_FILL"));
});

test("unseedable liquidity fails as a report instead of crashing", async () => {
  const review = reviewFixture();
  review.launchConfig.supplyWei = "1";
  review.launchConfig.startTick = 887200;
  review.reviewBounds.targetInitialFdvPipedogWei = "1";
  review.reviewBounds.minimumNetCurveCapacityPipedogWei = "1";
  review.reviewBounds.maxSeedDustTokenWei = "1";
  review.reviewBounds.representativeBuys =
    review.reviewBounds.representativeBuys.map((scenario, index) => ({
      ...scenario,
      grossPipedogInWei: String(index + 1),
      minTokensOutWei: "1",
      maxSpotPriceImpactBps: 1_000_000,
      maxAverageGrossPriceImpactBps: 1_000_000,
      maxRoundTripLossBps: 10_000,
    }));
  const approved = await approve(review);
  const report = await evaluateCurveReview(approved);
  assert.equal(report.gate.status, "fail");
  assert.ok(
    report.gate.issues.some(
      (entry) => entry.code === "LIQUIDITY_OUT_OF_FACTORY_RANGE",
    ),
  );
  assert.equal(report.launchBoundary.liquidity, "0");
});

test("calibration CLI is deterministic and simulation help documents approval", () => {
  const calibration = spawnSync(
    process.execPath,
    [
      "contracts/scripts/calibrate-curve.mjs",
      "--supply",
      "1000000000",
      "--fdv",
      "1000000",
      "--tick-spacing",
      "200",
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(calibration.status, 0, calibration.stderr);
  assert.equal(JSON.parse(calibration.stdout).selected.startTick, 69000);

  const help = spawnSync(
    process.execPath,
    ["contracts/scripts/simulate-curve.mjs", "--help"],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /computedConfigHash/);
  assert.match(help.stdout, /never signs, deploys, broadcasts, or calls an RPC/);
});

test("simulation CLI exits non-zero for draft and zero for exact approval", async () => {
  const temporaryDirectory = await mkdtemp(
    resolve(tmpdir(), "laypipe-curve-review-"),
  );
  const reviewPath = resolve(temporaryDirectory, "review.json");
  try {
    const review = reviewFixture();
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    const draft = spawnSync(
      process.execPath,
      ["contracts/scripts/simulate-curve.mjs", "--review", reviewPath],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(draft.status, 1, draft.stderr);
    const draftReport = JSON.parse(draft.stdout);
    assert.equal(draftReport.gate.status, "fail");

    review.approval = {
      status: "approved",
      configHash: draftReport.gate.computedConfigHash,
      reviewer: "automated-test-fixture-not-production-signoff",
      reviewedAt: "2000-01-01T00:00:00Z",
    };
    await writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    const approved = spawnSync(
      process.execPath,
      ["contracts/scripts/simulate-curve.mjs", "--review", reviewPath],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.equal(approved.status, 0, approved.stderr);
    assert.equal(JSON.parse(approved.stdout).gate.status, "pass");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
