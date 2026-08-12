#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalForgeEnvironment,
  evaluateDeploymentInputs,
  forgeBuildArguments,
  forgeSimulationArguments,
  spawnFoundrySync,
} from "./deployment-inputs-lib.mjs";

const CONTRACTS_ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return `Usage:
  node --env-file=.env scripts/rehearse-deployment.mjs --review <approved-review.json> --manifest <approved-deployment-inputs.json> --rpc-alias robinhood

This wrapper builds first, verifies the immutable candidate plus every deployment
input, then runs Forge simulation without --broadcast. Unknown flags fail closed;
there is deliberately no broadcast or private-key command-line option.`;
}

function parseArgs(argv) {
  const result = { help: false, review: undefined, manifest: undefined, rpcAlias: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      result.help = true;
      continue;
    }
    const field = {
      "--review": "review",
      "--manifest": "manifest",
      "--rpc-alias": "rpcAlias",
    }[argument];
    if (!field) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    if (result[field] !== undefined) throw new Error(`${argument} may be supplied only once`);
    result[field] = value;
    index += 1;
  }
  if (result.help) return result;
  if (!result.review || !result.manifest || !result.rpcAlias) {
    throw new Error("--review, --manifest, and --rpc-alias are required");
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

function forge(args, extraEnvironment = {}) {
  const environment = canonicalForgeEnvironment(process.env);
  const result = spawnFoundrySync("forge", args, {
    cwd: CONTRACTS_ROOT,
    env: { ...environment, ...extraEnvironment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`forge ${args[0]} failed with exit code ${result.status}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  canonicalForgeEnvironment(process.env);
  // The candidate hash must be calculated from a fresh build, never stale out/.
  forge(forgeBuildArguments());
  const [review, manifest] = await Promise.all([
    json(args.review, "curve review"),
    json(args.manifest, "deployment inputs"),
  ]);
  const report = await evaluateDeploymentInputs({
    manifest,
    review,
    environment: process.env,
  });
  if (report.gate.status !== "pass") {
    console.error(JSON.stringify(report, null, 2));
    throw new Error("deployment inputs are not approved for this exact candidate and environment");
  }
  console.log(JSON.stringify(report, null, 2));
  forge(forgeSimulationArguments(args.rpcAlias), {
    LAYPIPE_DEPLOYMENT_INPUTS_PATH: resolve(args.manifest),
    LAYPIPE_APPROVED_DEPLOYMENT_INPUTS_HASH:
      `0x${report.gate.computedDeploymentInputsHash.slice("sha256:".length)}`,
  });
}

try {
  await main();
} catch (error) {
  console.error(`No-broadcast rehearsal failed: ${error.message}`);
  console.error(usage());
  process.exitCode = 1;
}
