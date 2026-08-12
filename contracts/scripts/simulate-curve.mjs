#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateCurveReview, MODEL_ID } from "./curve-model.mjs";

function usage() {
  return `Usage:
  node scripts/simulate-curve.mjs --review <curve-review.json>

The review file must contain the exact PIPEDOG launch config, at least three
strictly increasing buy scenarios, explicit FDV/depth/dust/output/impact/loss
bounds, and an approval object. The first draft run intentionally exits 1 and
prints gate.computedConfigHash. After economic review, set status to approved,
copy that exact hash into approval.configHash, add reviewer/reviewedAt, and run
again. Any config or model-source change invalidates the hash.

This command never signs, deploys, broadcasts, or calls an RPC. Model:
${MODEL_ID}`;
}

function parseArgs(argv) {
  let reviewPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      return { help: true };
    }
    if (argument !== "--review") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (reviewPath !== undefined) {
      throw new Error("--review may only be specified once");
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--review requires a path");
    }
    reviewPath = value;
    index += 1;
  }
  if (reviewPath === undefined) throw new Error("Missing --review path");
  return { reviewPath };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const absolutePath = resolve(process.cwd(), args.reviewPath);
  let review;
  try {
    review = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read review JSON at ${absolutePath}: ${error.message}`);
  }
  const report = await evaluateCurveReview(review);
  console.log(JSON.stringify(report, null, 2));
  if (report.gate.status !== "pass") process.exitCode = 1;
} catch (error) {
  console.error(`Curve simulation failed: ${error.message}`);
  console.error("");
  console.error(usage());
  process.exitCode = 1;
}
