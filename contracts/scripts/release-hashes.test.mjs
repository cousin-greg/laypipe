import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertExpectedReleaseHashes,
  buildReleaseHashManifest,
} from "./release-hashes-lib.mjs";

const CONTRACTS = [{ source: "Example.sol", contract: "Example" }];
const CLI = fileURLToPath(new URL("./release-hashes.mjs", import.meta.url));
const ABI = [
  {
    type: "function",
    name: "value",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
    stateMutability: "view",
  },
];

function artifact(overrides = {}) {
  return {
    abi: ABI,
    bytecode: { object: overrides.creation ?? "0x6001600055", linkReferences: {} },
    deployedBytecode: {
      object: overrides.runtime ?? "0x60005460005260206000f3",
      linkReferences: {},
      immutableReferences: { "999": [{ start: 3, length: 32 }] },
    },
    metadata: {
      compiler: { version: "0.8.28+commit.7893614a" },
      settings: {
        evmVersion: "cancun",
        optimizer: {
          enabled: true,
          runs: 800,
          ...(overrides.optimizerDetails ? { details: overrides.optimizerDetails } : {}),
        },
        viaIR: true,
        metadata: {
          bytecodeHash: "ipfs",
          ...(overrides.appendCbor === undefined
            ? {}
            : { appendCBOR: overrides.appendCbor }),
        },
        compilationTarget: { [overrides.path ?? "src/Example.sol"]: "Example" },
      },
    },
    id: overrides.id ?? 1,
    rawMetadata: overrides.rawMetadata ?? "machine-specific evidence excluded from projection",
  };
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "laypipe-release-hash-"));
  await mkdir(join(root, "abi"));
  await mkdir(join(root, "out", "Example.sol"), { recursive: true });
  await writeFile(
    join(root, "abi", "Example.json"),
    options.prettyAbi ? `${JSON.stringify(options.abi ?? ABI, null, 2)}\n` : JSON.stringify(options.abi ?? ABI),
  );
  await writeFile(
    join(root, "out", "Example.sol", "Example.json"),
    JSON.stringify(options.artifact ?? artifact()),
  );
  return root;
}

test("release hashes ignore formatting, artifact ids, and non-projected paths", async () => {
  const first = await fixture({ prettyAbi: true, artifact: artifact({ id: 1, path: "src/Example.sol" }) });
  const second = await fixture({ artifact: artifact({ id: 987, path: "C:/different/Example.sol" }) });
  try {
    const left = await buildReleaseHashManifest({ root: first, contracts: CONTRACTS });
    const right = await buildReleaseHashManifest({ root: second, contracts: CONTRACTS });
    assert.deepEqual(left, right);
    assert.match(left.abiBundleSha256, /^0x[0-9a-f]{64}$/);
    assert.match(left.artifactBundleSha256, /^0x[0-9a-f]{64}$/);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

test("compiled bytecode changes the artifact bundle but not the ABI bundle", async () => {
  const first = await fixture();
  const second = await fixture({ artifact: artifact({ runtime: "0x60015460005260206000f3" }) });
  try {
    const left = await buildReleaseHashManifest({ root: first, contracts: CONTRACTS });
    const right = await buildReleaseHashManifest({ root: second, contracts: CONTRACTS });
    assert.equal(left.abiBundleSha256, right.abiBundleSha256);
    assert.notEqual(left.artifactBundleSha256, right.artifactBundleSha256);
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

test("stale ABIs and incorrect expected bundle pins fail closed", async () => {
  const root = await fixture({ abi: [] });
  try {
    await assert.rejects(
      buildReleaseHashManifest({ root, contracts: CONTRACTS }),
      /ABI is stale/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const valid = await fixture();
  try {
    const manifest = await buildReleaseHashManifest({ root: valid, contracts: CONTRACTS });
    assert.doesNotThrow(() =>
      assertExpectedReleaseHashes(manifest, {
        abiBundleSha256: manifest.abiBundleSha256,
        artifactBundleSha256: manifest.artifactBundleSha256,
      }),
    );
    assert.throws(
      () =>
        assertExpectedReleaseHashes(manifest, {
          abiBundleSha256: `0x${"00".repeat(32)}`,
          artifactBundleSha256: manifest.artifactBundleSha256,
        }),
      /ABI bundle SHA-256 mismatch/,
    );
  } finally {
    await rm(valid, { recursive: true, force: true });
  }
});

test("unreviewed compiler-detail changes and partial CLI pins fail closed", async () => {
  const noCbor = await fixture({ artifact: artifact({ appendCbor: false }) });
  const optimizerOverride = await fixture({
    artifact: artifact({ optimizerDetails: { yul: false } }),
  });
  try {
    await assert.rejects(
      buildReleaseHashManifest({ root: noCbor, contracts: CONTRACTS }),
      /compiler settings/,
    );
    await assert.rejects(
      buildReleaseHashManifest({ root: optimizerOverride, contracts: CONTRACTS }),
      /compiler settings/,
    );
  } finally {
    await Promise.all([
      rm(noCbor, { recursive: true, force: true }),
      rm(optimizerOverride, { recursive: true, force: true }),
    ]);
  }

  const result = spawnSync(
    process.execPath,
    [CLI, "--check", "--abi-bundle-sha256", `0x${"00".repeat(32)}`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Supply both explicit bundle hashes together/);
});
