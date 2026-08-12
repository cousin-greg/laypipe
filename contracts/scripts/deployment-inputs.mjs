#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CONTRACTS_ROOT } from "./curve-model.mjs";
import {
  canonicalForgeEnvironment,
  draftDeploymentInputs,
  evaluateDeploymentInputs,
  forgeBuildArguments,
  spawnFoundrySync,
} from "./deployment-inputs-lib.mjs";

function usage() {
  return `Usage:
  node --env-file=.env scripts/deployment-inputs.mjs --review <approved-review.json> --draft <manifest.json>
  node --env-file=.env scripts/deployment-inputs.mjs --review <approved-review.json> --check <manifest.json>

--draft writes an exact draft from the current candidate and the same environment
variables DeployLaypipe consumes. Review it, copy gate.computedDeploymentInputsHash
from a --check run into approval.deploymentInputsHash, and record approver/approvedAt.
--check exits zero only when review, manifest, current source/artifacts, and every
deployment address/economic environment input match. It never calls an RPC,
signs, deploys, broadcasts, reads, or prints DEPLOYER_PRIVATE_KEY. Set the
matching public DEPLOYER_ADDRESS separately.`;
}

function parseArgs(argv) {
  const result = { help: false, review: undefined, mode: undefined, manifest: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    if (!["--review", "--draft", "--check"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path`);
    if (argument === "--review") result.review = value;
    else {
      if (result.mode) throw new Error("Choose exactly one of --draft or --check");
      result.mode = argument.slice(2);
      result.manifest = value;
    }
    index += 1;
  }
  if (result.help) return result;
  if (!result.review || !result.mode || !result.manifest) {
    throw new Error("--review and exactly one of --draft or --check are required");
  }
  return result;
}

async function json(path, label) {
  try {
    return JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`);
  }
}

function buildCanonicalCandidate() {
  const result = spawnFoundrySync("forge", forgeBuildArguments(), {
    cwd: CONTRACTS_ROOT,
    env: canonicalForgeEnvironment(process.env),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`canonical forge build failed with exit code ${result.status}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  buildCanonicalCandidate();
  const review = await json(args.review, "curve review");
  if (args.mode === "draft") {
    const manifest = await draftDeploymentInputs({ review, environment: process.env });
    await writeFile(resolve(args.manifest), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    console.log(`Wrote draft deployment inputs to ${resolve(args.manifest)}`);
    return;
  }
  const manifest = await json(args.manifest, "deployment inputs");
  const report = await evaluateDeploymentInputs({
    manifest,
    review,
    environment: process.env,
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.gate.status !== "pass") process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(`Deployment input gate failed: ${error.message}`);
  console.error(usage());
  process.exitCode = 1;
}
