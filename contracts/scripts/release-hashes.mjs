import { fileURLToPath } from "node:url";

import {
  assertExpectedReleaseHashes,
  buildReleaseHashManifest,
  canonicalJson,
} from "./release-hashes-lib.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return [
    "Usage:",
    "  node scripts/release-hashes.mjs",
    "  node scripts/release-hashes.mjs --check --abi-bundle-sha256 <0x...> --artifact-bundle-sha256 <0x...>",
    "",
    "In --check mode, omitted expected values fall back to the matching",
    "NEXT_PUBLIC_LAYPIPE_*_BUNDLE_SHA256 environment variables.",
  ].join("\n");
}

function argumentsOf(argv) {
  const parsed = { check: false, help: false, abi: undefined, artifacts: undefined };
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") parsed.check = true;
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--abi-bundle-sha256") {
      parsed.abi = valueAfter(index, argument);
      index += 1;
    } else if (argument === "--artifact-bundle-sha256") {
      parsed.artifacts = valueAfter(index, argument);
      index += 1;
    } else throw new Error(`Unknown release-hash argument: ${argument ?? "missing value"}`);
  }
  if ((parsed.abi || parsed.artifacts) && !parsed.check) {
    throw new Error("Expected bundle hashes may be supplied only with --check.");
  }
  if (Boolean(parsed.abi) !== Boolean(parsed.artifacts)) {
    throw new Error("Supply both explicit bundle hashes together, or neither.");
  }
  return parsed;
}

async function main() {
  const args = argumentsOf(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const manifest = await buildReleaseHashManifest({ root: ROOT });
  if (args.check) {
    assertExpectedReleaseHashes(manifest, {
      abiBundleSha256:
        args.abi ?? process.env.NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256,
      artifactBundleSha256:
        args.artifacts ?? process.env.NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256,
    });
  }
  process.stdout.write(`${JSON.stringify(JSON.parse(canonicalJson(manifest)), null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `Release hash gate failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
}
