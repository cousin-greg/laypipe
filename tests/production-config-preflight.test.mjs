import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
const preflight = resolve(root, "scripts/verify-production-config.ts");
const hash = (byte) => `0x${byte.repeat(64)}`;
const sourceCommit = "ab".repeat(20);

function manifestEnvironment() {
  return {
    NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS:
      "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK: "100",
    NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS: "0x1000000000000000000000000000000000000001",
    NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH: hash("1"),
    NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS:
      "0x1000000000000000000000000000000000000002",
    NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH: hash("2"),
    NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS:
      "0x1000000000000000000000000000000000000003",
    NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH: hash("3"),
    NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS: "0x1000000000000000000000000000000000000004",
    NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH: hash("4"),
    NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS:
      "0x1000000000000000000000000000000000000005",
    NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH: hash("5"),
    NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS:
      "0x1000000000000000000000000000000000000006",
    NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH: hash("6"),
    NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS:
      "0x1000000000000000000000000000000000000007",
    NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH: hash("7"),
    NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS:
      "0x2000000000000000000000000000000000000001",
    NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS:
      "0x2000000000000000000000000000000000000002",
    NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS:
      "0x2000000000000000000000000000000000000003",
    NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID: "0",
    NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID: "1",
    NEXT_PUBLIC_LAYPIPE_LAUNCH_FEE_WEI: "1000000000000000000",
    NEXT_PUBLIC_LAYPIPE_LAUNCH_SUPPLY_WEI: "1000000000000000000000000000",
    NEXT_PUBLIC_LAYPIPE_TICK_SPACING: "60",
    NEXT_PUBLIC_LAYPIPE_START_TICK: "120",
    NEXT_PUBLIC_LAYPIPE_SELF_BURN_MAX_PER_CALL_WEI: "100000000000000000000",
    NEXT_PUBLIC_LAYPIPE_SELF_BURN_BOUNTY_BPS: "50",
    NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_SEQUESTER_PER_CALL_WEI:
      "200000000000000000000",
    NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_TREASURY_ROUTE_PER_CALL_WEI:
      "300000000000000000000",
    NEXT_PUBLIC_LAYPIPE_REVENUE_BOUNTY_BPS: "25",
    NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT: sourceCommit,
    NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION: "0.8.28+commit.7893614a",
    NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256: hash("8"),
    NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256: hash("9"),
  };
}

function indexerEnvironment(vercelEnvironment = "preview") {
  return {
    ...manifestEnvironment(),
    NODE_ENV: "production",
    VERCEL_ENV: vercelEnvironment,
    NEXT_PUBLIC_SITE_URL: "https://laypipe.fun",
    LAYPIPE_MARKET_MODE: "fixture",
    IPFS_PINNING_ENABLED: "false",
    INDEXER_ENABLED: "true",
    NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED: "false",
    DATABASE_READ_URL:
      "postgresql://laypipe_read:read-password@ep-laypipe-pooler.us-east-2.aws.neon.tech/laypipe?sslmode=require",
    DATABASE_WRITE_URL:
      "postgresql://laypipe_write:write-password@ep-laypipe.us-east-2.aws.neon.tech/laypipe?sslmode=require",
    LAYPIPE_DB_READ_ROLE: "laypipe_runtime_read",
    LAYPIPE_DB_WRITE_ROLE: "laypipe_runtime_write",
    LAYPIPE_DB_SERVICE_ROLE: "laypipe_runtime_service",
    ROBINHOOD_RPC_HTTP_URL: "https://robinhood-mainnet.example-rpc.test/v2/credential",
    INDEXER_FINALITY_BLOCKS: "2",
    INDEXER_BATCH_SIZE: "10",
    INDEXER_MAX_BATCHES_PER_RUN: "25",
    INDEXER_MAX_LOGS: "5000",
    INDEXER_MAX_NEW_LAUNCHES: "25",
    INDEXER_FILTER_CHUNK_SIZE: "100",
    INDEXER_MAX_FILTER_CHUNKS: "25",
    INDEXER_REORG_LOOKBACK: "128",
    INDEXER_RUN_TIMEOUT_MS: "45000",
    CRON_SECRET: "cron-secret-that-is-deliberately-long-and-unique",
    ALCHEMY_WEBHOOK_SIGNING_KEY:
      "webhook-signing-key-that-is-deliberately-long-and-unique",
    UPSTASH_REDIS_REST_KV_REST_API_URL:
      "https://laypipe-preview-12345.upstash.io",
    UPSTASH_REDIS_REST_KV_REST_API_TOKEN:
      "upstash-token-that-is-deliberately-long-and-private",
  };
}

function profileEnvironment(profile) {
  const production = profile.startsWith("production-");
  const environment = indexerEnvironment(production ? "production" : "preview");
  if (profile.endsWith("-readonly") || profile.endsWith("-mutations")) {
    Object.assign(environment, {
      LAYPIPE_MARKET_MODE: "live",
      MARKET_CURSOR_SECRET: "market-cursor-that-is-deliberately-long-and-unique",
      IPFS_GATEWAY_BASE_URL: production
        ? "https://laypipe-production.mypinata.cloud"
        : "https://laypipe-preview.mypinata.cloud",
    });
  }
  if (profile.endsWith("-mutations")) {
    Object.assign(environment, {
      IPFS_PINNING_ENABLED: "true",
      NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED: "true",
      WALLET_CHALLENGE_SECRET:
        "wallet-challenge-that-is-deliberately-long-and-unique",
      PINATA_JWT: "pinata.jwt.value-that-is-deliberately-long-and-private",
    });
  }
  return environment;
}

function run(profile, env, { deployment = false, omitProfile = false } = {}) {
  const args = [tsxCli, preflight];
  if (deployment) args.push("--deployment");
  if (!omitProfile) args.push("--profile", profile);
  return spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

test("deployment prebuild defaults absent switches and profile to safe fixture", () => {
  const result = run("safe-fixture", {
    PRIVATE_KEY: "ambient-operator-key-must-not-break-a-safe-local-build",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_NAME: "cousin-greg",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_AUTHOR_LOGIN: "cousin-greg",
  }, { deployment: true, omitProfile: true });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /safe-fixture; safe build gate/);

  const unsafe = run("safe-fixture", {
    PRIVATE_KEY: "ambient-operator-key-must-not-break-a-safe-local-build",
    INDEXER_ENABLED: "true",
  }, { deployment: true, omitProfile: true });
  assert.equal(unsafe.status, 1);
  assert.match(output(unsafe), /INDEXER_ENABLED must be exactly false/);
});

test("deployment prebuild loads the same production env files as Next", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "laypipe-prebuild-env-"));
  try {
    await writeFile(
      join(cwd, ".env.production.local"),
      "INDEXER_ENABLED=true\n",
    );
    const result = spawnSync(
      process.execPath,
      [tsxCli, preflight, "--deployment"],
      { cwd, env: {}, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(result.status, 1);
    assert.match(output(result), /INDEXER_ENABLED must be exactly false/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Vercel safe fixture rejects deployer credentials even with mutations off", () => {
  const result = run("safe-fixture", {
    VERCEL: "1",
    DEPLOYER_PRIVATE_KEY_BACKUP: "never-runtime-key",
  }, { deployment: true, omitProfile: true });
  assert.equal(result.status, 1);
  assert.match(output(result), /DEPLOYER_PRIVATE_KEY_BACKUP must be absent/);
  assert.doesNotMatch(output(result), /never-runtime-key/);
});

test("Vercel safe fixture permits the platform OIDC token", () => {
  const result = run("safe-fixture", {
    VERCEL: "1",
    VERCEL_OIDC_TOKEN: "platform-managed-token-is-not-an-application-deployer-key",
  }, { deployment: true, omitProfile: true });
  assert.equal(result.status, 0, output(result));
  assert.doesNotMatch(output(result), /VERCEL_OIDC_TOKEN/);
});

test("explicit local safe fixture requires every kill switch off", () => {
  const result = run("safe-fixture", {
    NEXT_PUBLIC_SITE_URL: "https://laypipe.fun",
    LAYPIPE_MARKET_MODE: "fixture",
    IPFS_PINNING_ENABLED: "false",
    INDEXER_ENABLED: "false",
    NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED: "false",
  });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /safe-fixture; local precheck/);

  const unsafe = run("safe-fixture", {
    NEXT_PUBLIC_SITE_URL: "https://laypipe.fun",
    LAYPIPE_MARKET_MODE: "live",
    IPFS_PINNING_ENABLED: "true",
    INDEXER_ENABLED: "true",
    NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED: "true",
  });
  assert.equal(unsafe.status, 1);
  assert.match(output(unsafe), /LAYPIPE_MARKET_MODE must be exactly fixture/);
  assert.match(output(unsafe), /IPFS_PINNING_ENABLED must be exactly false/);
  assert.match(output(unsafe), /INDEXER_ENABLED must be exactly false/);
  assert.match(output(unsafe), /WALLET_MUTATIONS_ENABLED must be exactly false/);
});

test("every staged profile accepts only its intended kill-switch state", () => {
  for (const profile of [
    "preview-indexer",
    "production-indexer",
    "preview-readonly",
    "production-readonly",
    "preview-mutations",
    "production-mutations",
  ]) {
    const valid = run(profile, profileEnvironment(profile));
    assert.equal(valid.status, 0, `${profile}: ${output(valid)}`);

    const wrongWallet = run(profile, {
      ...profileEnvironment(profile),
      NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED:
        profile.endsWith("-mutations") ? "false" : "true",
    });
    assert.equal(wrongWallet.status, 1, profile);
    assert.match(output(wrongWallet), /WALLET_MUTATIONS_ENABLED must be exactly/);
  }
});

test("readonly needs cursor and gateway but not Pinata or wallet challenge credentials", () => {
  const readonly = profileEnvironment("preview-readonly");
  delete readonly.PINATA_JWT;
  delete readonly.WALLET_CHALLENGE_SECRET;
  assert.equal(run("preview-readonly", readonly).status, 0);

  delete readonly.MARKET_CURSOR_SECRET;
  delete readonly.IPFS_GATEWAY_BASE_URL;
  const missing = run("preview-readonly", readonly);
  assert.equal(missing.status, 1);
  assert.match(output(missing), /MARKET_CURSOR_SECRET is required/);
  assert.match(output(missing), /IPFS_GATEWAY_BASE_URL is required/);
});

test("indexer profile does not require Pinata, gateway, or cursor credentials", () => {
  const indexer = profileEnvironment("preview-indexer");
  for (const key of [
    "PINATA_JWT",
    "WALLET_CHALLENGE_SECRET",
    "MARKET_CURSOR_SECRET",
    "IPFS_GATEWAY_BASE_URL",
  ]) delete indexer[key];
  assert.equal(run("preview-indexer", indexer).status, 0);
});

test("staged profiles reject cross-environment execution", () => {
  const previewAgainstProduction = run(
    "preview-readonly",
    { ...profileEnvironment("preview-readonly"), VERCEL_ENV: "production" },
  );
  assert.equal(previewAgainstProduction.status, 1);
  assert.match(output(previewAgainstProduction), /VERCEL_ENV must be exactly preview/);

  const productionAgainstPreview = run(
    "production-readonly",
    { ...profileEnvironment("production-readonly"), VERCEL_ENV: "preview" },
  );
  assert.equal(productionAgainstPreview.status, 1);
  assert.match(output(productionAgainstPreview), /VERCEL_ENV must be exactly production/);
});

test("authoritative staged profile requires Vercel system identity and exact source commit", () => {
  const noSystemIdentity = run(
    "preview-readonly",
    profileEnvironment("preview-readonly"),
    { deployment: true },
  );
  assert.equal(noSystemIdentity.status, 1);
  assert.match(output(noSystemIdentity), /VERCEL must be exactly 1/);
  assert.match(output(noSystemIdentity), /VERCEL_GIT_COMMIT_SHA is required/);

  const mismatch = run("preview-readonly", {
    ...profileEnvironment("preview-readonly"),
    VERCEL: "1",
    VERCEL_GIT_COMMIT_SHA: "cd".repeat(20),
    LAYPIPE_APP_SOURCE_COMMIT: sourceCommit,
  }, { deployment: true });
  assert.equal(mismatch.status, 1);
  assert.match(output(mismatch), /LAYPIPE_APP_SOURCE_COMMIT must match VERCEL_GIT_COMMIT_SHA/);

  const exact = run("preview-readonly", {
    ...profileEnvironment("preview-readonly"),
    VERCEL: "1",
    VERCEL_GIT_COMMIT_SHA: sourceCommit,
    LAYPIPE_APP_SOURCE_COMMIT: sourceCommit,
  }, { deployment: true });
  assert.equal(exact.status, 0, output(exact));
});

test("credential-name and database-owner hardening fails without printing values", () => {
  const sentinel = "never-print-this-sensitive-value";
  const result = run("preview-readonly", {
    ...profileEnvironment("preview-readonly"),
    NEXT_PUBLIC_API_KEY: sentinel,
    DEPLOYER_MNEMONIC_BACKUP: sentinel,
    DATABASE_READ_URL:
      `postgresql://neondb%5Fowner:${sentinel}@ep-laypipe-pooler.us-east-2.aws.neon.tech/laypipe?sslmode=require`,
    DATABASE_MIGRATION_URL:
      `postgresql://owner:${sentinel}@ep-laypipe.us-east-2.aws.neon.tech/laypipe`,
    UPSTASH_REDIS_REST_URL: "https://wrong-resource.upstash.io",
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /NEXT_PUBLIC_API_KEY looks secret-bearing/);
  assert.match(output(result), /DEPLOYER_MNEMONIC_BACKUP must be absent/);
  assert.match(output(result), /DATABASE_MIGRATION_URL must be absent/);
  assert.match(output(result), /known owner or privileged PostgreSQL LOGIN/);
  assert.match(output(result), /UPSTASH_REDIS_REST_URL is a local\/operator alias/);
  assert.doesNotMatch(output(result), new RegExp(sentinel));
  assert.match(output(result), /no credential values were printed/i);
});

test("missing infrastructure and partial configured manifest fail closed", () => {
  const sentinel = "do-not-print-this-credential";
  const result = run("preview-indexer", {
    NEXT_PUBLIC_SITE_URL: "https://laypipe.fun",
    VERCEL_ENV: "preview",
    LAYPIPE_MARKET_MODE: "fixture",
    IPFS_PINNING_ENABLED: "false",
    INDEXER_ENABLED: "true",
    NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED: "false",
    CRON_SECRET: sentinel,
    NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS:
      "0x1000000000000000000000000000000000000001",
  });
  assert.equal(result.status, 1);
  assert.match(output(result), /DATABASE_READ_URL is required/);
  assert.match(output(result), /configured release manifest is partial/);
  assert.doesNotMatch(output(result), new RegExp(sentinel));
});
