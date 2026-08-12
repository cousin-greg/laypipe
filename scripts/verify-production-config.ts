import {
  parseRobinhoodProductionManifest,
  type PublicDeploymentEnvironment,
} from "../lib/web3/deployment-manifest";
import nextEnv from "@next/env";

export const CONFIG_PROFILES = [
  "safe-fixture",
  "preview-indexer",
  "production-indexer",
  "preview-readonly",
  "production-readonly",
  "preview-mutations",
  "production-mutations",
] as const;
export type ConfigProfile = (typeof CONFIG_PROFILES)[number];

export interface ConfigPreflightOptions {
  deployment?: boolean;
}

export interface ConfigPreflightResult {
  profile: ConfigProfile;
  deployment: boolean;
  ok: boolean;
  checks: number;
  issues: string[];
}

const PUBLIC_MANIFEST_VARIABLES = [
  "NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK",
  "NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH",
  "NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS",
  "NEXT_PUBLIC_LAYPIPE_CREATOR_CONFIG_ID",
  "NEXT_PUBLIC_LAYPIPE_SELF_BURN_CONFIG_ID",
  "NEXT_PUBLIC_LAYPIPE_LAUNCH_FEE_WEI",
  "NEXT_PUBLIC_LAYPIPE_LAUNCH_SUPPLY_WEI",
  "NEXT_PUBLIC_LAYPIPE_TICK_SPACING",
  "NEXT_PUBLIC_LAYPIPE_START_TICK",
  "NEXT_PUBLIC_LAYPIPE_SELF_BURN_MAX_PER_CALL_WEI",
  "NEXT_PUBLIC_LAYPIPE_SELF_BURN_BOUNTY_BPS",
  "NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_SEQUESTER_PER_CALL_WEI",
  "NEXT_PUBLIC_LAYPIPE_REVENUE_MAX_TREASURY_ROUTE_PER_CALL_WEI",
  "NEXT_PUBLIC_LAYPIPE_REVENUE_BOUNTY_BPS",
  "NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT",
  "NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION",
  "NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256",
  "NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256",
] as const;

const INDEXER_REQUIRED_VARIABLES = [
  "DATABASE_READ_URL",
  "DATABASE_WRITE_URL",
  "LAYPIPE_DB_READ_ROLE",
  "LAYPIPE_DB_WRITE_ROLE",
  "LAYPIPE_DB_SERVICE_ROLE",
  "ROBINHOOD_RPC_HTTP_URL",
  "INDEXER_FINALITY_BLOCKS",
  "INDEXER_BATCH_SIZE",
  "INDEXER_MAX_BATCHES_PER_RUN",
  "INDEXER_MAX_LOGS",
  "INDEXER_MAX_NEW_LAUNCHES",
  "INDEXER_FILTER_CHUNK_SIZE",
  "INDEXER_MAX_FILTER_CHUNKS",
  "INDEXER_REORG_LOOKBACK",
  "INDEXER_RUN_TIMEOUT_MS",
  "CRON_SECRET",
  "ALCHEMY_WEBHOOK_SIGNING_KEY",
  "UPSTASH_REDIS_REST_KV_REST_API_URL",
  "UPSTASH_REDIS_REST_KV_REST_API_TOKEN",
] as const;
const FORBIDDEN_LIVE_ALIASES = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "ROBINHOOD_RPC_URL",
] as const;
const FORBIDDEN_LIVE_DATABASE_ALIASES = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_NON_POOLING",
  "NEON_DATABASE_URL",
] as const;
const ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const SECRET_PUBLIC_NAME_PATTERN =
  /(?:SECRET|PRIVATE|PASSWORD|PASSWD|MNEMONIC|DATABASE|REDIS|JWT|RPC|WEBHOOK|SIGNING|PINATA|API[_-]?KEY|ACCESS[_-]?KEY|AUTH|CREDENTIAL|TOKEN)/i;
const RUNTIME_CREDENTIAL_NAME_PATTERN =
  /(?:^|_)(?:PRIVATE_KEY|MNEMONIC|SEED_PHRASE)(?:_|$)/i;
const PRIVILEGED_DATABASE_USER_PATTERN =
  /^(?:postgres|neondb_owner|neon_superuser|cloud_admin)$/i;

function configured(env: NodeJS.ProcessEnv, name: string) {
  return typeof env[name] === "string" && env[name]!.trim() !== "";
}

function parseArguments(argv: string[]) {
  let profile: ConfigProfile | undefined;
  let deployment = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--deployment") {
      deployment = true;
      continue;
    }
    if (argument === "--profile") {
      const value = argv[index + 1];
      if (!value) throw new Error("--profile requires a value.");
      profile = value as ConfigProfile;
      index += 1;
      continue;
    }
    if (!argument?.startsWith("--") && profile === undefined) {
      profile = argument as ConfigProfile;
      continue;
    }
    throw new Error(`Unknown configuration-preflight argument: ${argument ?? "missing value"}.`);
  }
  profile ??= "safe-fixture";
  if (!(CONFIG_PROFILES as readonly string[]).includes(profile)) {
    throw new Error(`Profile must be one of: ${CONFIG_PROFILES.join(", ")}.`);
  }
  return { profile, deployment };
}

function normalizeDatabaseEndpoint(url: URL) {
  let hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".neon.tech")) {
    const labels = hostname.split(".");
    labels[0] = labels[0]!.replace(/-pooler$/, "");
    hostname = labels.join(".");
  }
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new Error("Database name encoding is invalid.");
  }
  return `${hostname}:${url.port || "5432"}/${database}`;
}

function profileTier(profile: ConfigProfile) {
  if (profile === "safe-fixture") return "fixture" as const;
  if (profile.endsWith("-indexer")) return "indexer" as const;
  if (profile.endsWith("-readonly")) return "readonly" as const;
  return "mutations" as const;
}

function profileEnvironment(profile: Exclude<ConfigProfile, "safe-fixture">) {
  return profile.startsWith("preview-") ? "preview" as const : "production" as const;
}

function effectiveSafeValue(
  env: NodeJS.ProcessEnv,
  name: string,
  safeDefault: string,
  allowSafeDefault: boolean,
) {
  return configured(env, name) ? env[name] : allowSafeDefault ? safeDefault : env[name];
}

export function verifyProductionConfig(
  env: NodeJS.ProcessEnv,
  profile: ConfigProfile,
  options: ConfigPreflightOptions = {},
): ConfigPreflightResult {
  const issues: string[] = [];
  let checks = 0;
  const deployment = options.deployment === true;
  const tier = profileTier(profile);
  const safeDefaults = deployment && tier === "fixture";
  const issue = (message: string) => {
    if (!issues.includes(message)) issues.push(message);
  };
  const check = (condition: boolean, message: string) => {
    checks += 1;
    if (!condition) issue(message);
  };
  const requireConfigured = (name: string) => {
    check(configured(env, name), `${name} is required.`);
    return env[name];
  };
  const requireExact = (name: string, expected: string, safeDefault?: string) => {
    const actual = effectiveSafeValue(env, name, safeDefault ?? "", safeDefaults && safeDefault !== undefined);
    check(actual === expected, `${name} must be exactly ${expected}.`);
  };
  const requireSecret = (name: string, minimumLength = 32) => {
    const value = requireConfigured(name);
    if (value === undefined) return;
    check(
      value.length >= minimumLength && value.length <= 8_192 && !/\s/.test(value),
      `${name} must be a bounded secret of at least ${minimumLength} non-whitespace characters.`,
    );
  };
  const parseUrl = (name: string, protocols: readonly string[]): URL | null => {
    const value = requireConfigured(name);
    if (value === undefined) return null;
    checks += 1;
    try {
      const parsed = new URL(value);
      if (!protocols.includes(parsed.protocol)) {
        issue(`${name} must use ${protocols.join(" or ")}.`);
        return null;
      }
      return parsed;
    } catch {
      issue(`${name} is not a valid URL.`);
      return null;
    }
  };
  const integer = (name: string, minimum: number, maximum: number) => {
    const value = requireConfigured(name);
    if (value === undefined) return null;
    const parsed = Number(value);
    check(
      /^\d+$/.test(value) && Number.isSafeInteger(parsed) &&
        parsed >= minimum && parsed <= maximum,
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
    return parsed;
  };

  const siteUrl = safeDefaults && !configured(env, "NEXT_PUBLIC_SITE_URL")
    ? new URL("https://laypipe.fun")
    : parseUrl("NEXT_PUBLIC_SITE_URL", ["https:"]);
  if (siteUrl) {
    check(
      !siteUrl.username && !siteUrl.password && !siteUrl.port &&
        !siteUrl.search && !siteUrl.hash &&
        (siteUrl.pathname === "" || siteUrl.pathname === "/"),
      "NEXT_PUBLIC_SITE_URL must be a clean HTTPS origin.",
    );
  }

  const enforceRuntimeCredentialAbsence = tier !== "fixture" || env.VERCEL === "1";
  for (const name of Object.keys(env)) {
    if (!configured(env, name)) continue;
    if (name.startsWith("NEXT_PUBLIC_") &&
      name !== "NEXT_PUBLIC_SITE_URL" &&
      name !== "NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED" &&
      !(PUBLIC_MANIFEST_VARIABLES as readonly string[]).includes(name) &&
      SECRET_PUBLIC_NAME_PATTERN.test(name)) {
      issue(`${name} looks secret-bearing and must not be public.`);
    }
    if (enforceRuntimeCredentialAbsence && RUNTIME_CREDENTIAL_NAME_PATTERN.test(name)) {
      issue(`${name} must be absent from the application runtime.`);
    }
  }
  if (enforceRuntimeCredentialAbsence) {
    check(!configured(env, "DATABASE_MIGRATION_URL"),
      "DATABASE_MIGRATION_URL must be absent from the application runtime.");
  }

  const configuredManifestVariables = PUBLIC_MANIFEST_VARIABLES.filter((name) =>
    configured(env, name));
  checks += PUBLIC_MANIFEST_VARIABLES.length;
  if (configuredManifestVariables.length > 0 &&
    configuredManifestVariables.length < PUBLIC_MANIFEST_VARIABLES.length) {
    const missing = PUBLIC_MANIFEST_VARIABLES.filter((name) => !configured(env, name));
    issue(`The public configured release manifest is partial; missing: ${missing.join(", ")}.`);
  }

  const expectedMarketMode = tier === "indexer" || tier === "fixture" ? "fixture" : "live";
  requireExact("LAYPIPE_MARKET_MODE", expectedMarketMode,
    tier === "fixture" ? "fixture" : undefined);
  requireExact("INDEXER_ENABLED", tier === "fixture" ? "false" : "true",
    tier === "fixture" ? "false" : undefined);
  requireExact("IPFS_PINNING_ENABLED", tier === "mutations" ? "true" : "false",
    tier === "fixture" ? "false" : undefined);
  requireExact(
    "NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED",
    tier === "mutations" ? "true" : "false",
    tier === "fixture" ? "false" : undefined,
  );

  if (tier === "fixture") {
    if (configuredManifestVariables.length === PUBLIC_MANIFEST_VARIABLES.length) {
      checks += 1;
      try {
        parseRobinhoodProductionManifest(env as PublicDeploymentEnvironment);
      } catch (error) {
        issue(`The complete configured release manifest is invalid: ${
          error instanceof Error ? error.message : "validation failed"}`);
      }
    }
    return { profile, deployment, ok: issues.length === 0, checks, issues };
  }

  const stagedProfile = profile as Exclude<ConfigProfile, "safe-fixture">;
  const expectedVercelEnvironment = profileEnvironment(stagedProfile);
  requireExact("VERCEL_ENV", expectedVercelEnvironment);
  if (configured(env, "VERCEL_TARGET_ENV")) {
    requireExact("VERCEL_TARGET_ENV", expectedVercelEnvironment);
  }
  if (configured(env, "NODE_ENV")) requireExact("NODE_ENV", "production");
  if (!deployment && configured(env, "LAYPIPE_APP_SOURCE_COMMIT")) {
    check(/^[0-9a-fA-F]{40}$/.test(env.LAYPIPE_APP_SOURCE_COMMIT!),
      "LAYPIPE_APP_SOURCE_COMMIT must be a full 40-character Git SHA when configured.");
  }
  if (deployment) {
    requireExact("VERCEL", "1");
    const deploymentCommit = requireConfigured("VERCEL_GIT_COMMIT_SHA");
    const applicationCommit = requireConfigured("LAYPIPE_APP_SOURCE_COMMIT");
    if (deploymentCommit !== undefined) {
      check(/^[0-9a-fA-F]{40}$/.test(deploymentCommit),
        "VERCEL_GIT_COMMIT_SHA must be a full 40-character Git SHA.");
      check(
        applicationCommit?.toLowerCase() === deploymentCommit.toLowerCase(),
        "LAYPIPE_APP_SOURCE_COMMIT must match VERCEL_GIT_COMMIT_SHA.",
      );
    }
  }
  if (expectedVercelEnvironment === "production" && siteUrl) {
    check(siteUrl.origin === "https://laypipe.fun",
      "Production NEXT_PUBLIC_SITE_URL must be https://laypipe.fun.");
  }

  for (const name of INDEXER_REQUIRED_VARIABLES) requireConfigured(name);
  for (const name of FORBIDDEN_LIVE_ALIASES) {
    check(!configured(env, name),
      `${name} is a local/operator alias and must be absent from a Vercel staged profile.`);
  }
  for (const name of FORBIDDEN_LIVE_DATABASE_ALIASES) {
    check(!configured(env, name),
      `${name} must be absent; Vercel may contain only the reviewed read/write runtime URLs.`);
  }

  const roleNames = ["LAYPIPE_DB_READ_ROLE", "LAYPIPE_DB_WRITE_ROLE", "LAYPIPE_DB_SERVICE_ROLE"] as const;
  for (const name of roleNames) {
    const value = env[name];
    if (value !== undefined) {
      check(ROLE_PATTERN.test(value) && !value.startsWith("pg_"),
        `${name} is not a valid unprivileged PostgreSQL role name.`);
    }
  }
  const roles = roleNames.map((name) => env[name]).filter(Boolean);
  check(new Set(roles).size === roles.length,
    "The LayPipe read, write, and service roles must be distinct.");

  const readDatabase = parseUrl("DATABASE_READ_URL", ["postgres:", "postgresql:"]);
  const writeDatabase = parseUrl("DATABASE_WRITE_URL", ["postgres:", "postgresql:"]);
  for (const [name, url] of [["DATABASE_READ_URL", readDatabase],
    ["DATABASE_WRITE_URL", writeDatabase]] as const) {
    if (!url) continue;
    check(Boolean(url.hostname && url.username && url.password && url.pathname.slice(1)),
      `${name} must include a host, LOGIN user, password, and database.`);
    check(url.hostname.toLowerCase().endsWith(".neon.tech"), `${name} must target Neon.`);
    check(["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? ""),
      `${name} must require TLS with sslmode=require or sslmode=verify-full.`);
    let databaseUsername = url.username;
    try {
      databaseUsername = decodeURIComponent(url.username);
    } catch {
      issue(`${name} has an invalid encoded PostgreSQL LOGIN.`);
    }
    check(!PRIVILEGED_DATABASE_USER_PATTERN.test(databaseUsername),
      `${name} must not use a known owner or privileged PostgreSQL LOGIN.`);
  }
  if (readDatabase && writeDatabase) {
    checks += 3;
    try {
      if (normalizeDatabaseEndpoint(readDatabase) !== normalizeDatabaseEndpoint(writeDatabase)) {
        issue("DATABASE_READ_URL and DATABASE_WRITE_URL must target the same Neon database endpoint.");
      }
    } catch {
      issue("DATABASE_READ_URL and DATABASE_WRITE_URL have an invalid database name.");
    }
    let readUsername = readDatabase.username;
    let writeUsername = writeDatabase.username;
    try {
      readUsername = decodeURIComponent(readDatabase.username);
      writeUsername = decodeURIComponent(writeDatabase.username);
    } catch {
      issue("DATABASE_READ_URL or DATABASE_WRITE_URL has an invalid encoded PostgreSQL LOGIN.");
    }
    if (readUsername === writeUsername) {
      issue("DATABASE_READ_URL and DATABASE_WRITE_URL must use distinct LOGIN users.");
    }
    if (env.DATABASE_READ_URL === env.DATABASE_WRITE_URL) {
      issue("DATABASE_READ_URL and DATABASE_WRITE_URL must not be identical.");
    }
  }

  const redisUrl = parseUrl("UPSTASH_REDIS_REST_KV_REST_API_URL", ["https:"]);
  if (redisUrl) {
    check(redisUrl.hostname.toLowerCase().endsWith(".upstash.io") &&
      !redisUrl.username && !redisUrl.password && !redisUrl.port &&
      !redisUrl.search && !redisUrl.hash &&
      (redisUrl.pathname === "" || redisUrl.pathname === "/"),
    "UPSTASH_REDIS_REST_KV_REST_API_URL must be a clean Upstash HTTPS origin.");
  }
  requireSecret("UPSTASH_REDIS_REST_KV_REST_API_TOKEN");

  const rpcUrl = parseUrl("ROBINHOOD_RPC_HTTP_URL", ["https:"]);
  if (rpcUrl) {
    check(Boolean(rpcUrl.hostname) && !rpcUrl.username && !rpcUrl.password &&
      !rpcUrl.hash && !["localhost", "127.0.0.1", "::1"].includes(rpcUrl.hostname),
    "ROBINHOOD_RPC_HTTP_URL must be a remote HTTPS endpoint; authentication and capability need a separate smoke test.");
  }

  integer("INDEXER_FINALITY_BLOCKS", 1, 10_000);
  integer("INDEXER_BATCH_SIZE", 1, 100);
  integer("INDEXER_MAX_BATCHES_PER_RUN", 1, 100);
  integer("INDEXER_MAX_LOGS", 100, 20_000);
  integer("INDEXER_MAX_NEW_LAUNCHES", 1, 100);
  const chunkSize = integer("INDEXER_FILTER_CHUNK_SIZE", 1, 200);
  const chunkCount = integer("INDEXER_MAX_FILTER_CHUNKS", 1, 100);
  integer("INDEXER_REORG_LOOKBACK", 2, 2_048);
  integer("INDEXER_RUN_TIMEOUT_MS", 5_000, 55_000);
  if (chunkSize !== null && chunkCount !== null) {
    check(chunkSize * chunkCount <= 2_500,
      "The current release supports at most 2,500 watched launches; reduce the indexer filter capacity.");
  }

  requireSecret("CRON_SECRET");
  requireSecret("ALCHEMY_WEBHOOK_SIGNING_KEY");

  if (tier === "readonly" || tier === "mutations") {
    requireSecret("MARKET_CURSOR_SECRET");
    const gatewayUrl = parseUrl("IPFS_GATEWAY_BASE_URL", ["https:"]);
    if (gatewayUrl) {
      const path = gatewayUrl.pathname.replace(/\/+$/, "");
      check(gatewayUrl.hostname.toLowerCase().endsWith(".mypinata.cloud") &&
        gatewayUrl.hostname.toLowerCase() !== "mypinata.cloud" &&
        !gatewayUrl.username && !gatewayUrl.password && !gatewayUrl.port &&
        !gatewayUrl.search && !gatewayUrl.hash && (path === "" || path === "/ipfs"),
      "IPFS_GATEWAY_BASE_URL must be a clean dedicated mypinata.cloud HTTPS gateway.");
    }
  }

  if (tier === "mutations") {
    requireSecret("WALLET_CHALLENGE_SECRET");
    requireSecret("PINATA_JWT");
  }
  const controlSecrets = [
    env.CRON_SECRET,
    env.ALCHEMY_WEBHOOK_SIGNING_KEY,
    env.MARKET_CURSOR_SECRET,
    tier === "mutations" ? env.WALLET_CHALLENGE_SECRET : undefined,
  ].filter((value): value is string => Boolean(value));
  check(new Set(controlSecrets).size === controlSecrets.length,
    "Cron, webhook, market cursor, and wallet challenge secrets must be distinct when configured.");

  check(configuredManifestVariables.length === PUBLIC_MANIFEST_VARIABLES.length,
    "Every public configured release manifest variable is required for a staged profile.");
  if (configuredManifestVariables.length === PUBLIC_MANIFEST_VARIABLES.length) {
    checks += 1;
    try {
      parseRobinhoodProductionManifest(env as PublicDeploymentEnvironment);
    } catch (error) {
      issue(`The public configured release manifest is invalid: ${
        error instanceof Error ? error.message : "validation failed"}`);
    }
  }
  return { profile, deployment, ok: issues.length === 0, checks, issues };
}

export function formatProductionConfigResult(result: ConfigPreflightResult) {
  const scope = result.deployment
    ? result.profile === "safe-fixture"
      ? "safe build gate"
      : "Vercel deployment gate"
    : "local precheck";
  if (result.ok) {
    return [
      `LayPipe configuration preflight passed (${result.profile}; ${scope}).`,
      `Validated ${result.checks} secret-safe rules; no provider calls were made.`,
    ].join("\n");
  }
  return [
    `LayPipe configuration preflight failed (${result.profile}; ${scope}).`,
    ...result.issues.map((message) => `- ${message}`),
    "No provider calls were made and no credential values were printed.",
  ].join("\n");
}

async function main() {
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid arguments.");
    process.exitCode = 2;
    return;
  }
  if (parsed.deployment) {
    nextEnv.loadEnvConfig(process.cwd(), false, {
      info: () => undefined,
      error: () => undefined,
    }, false);
  }
  const profile = parsed.deployment
    ? ((process.env.LAYPIPE_CONFIG_PROFILE || parsed.profile) as ConfigProfile)
    : parsed.profile;
  if (!(CONFIG_PROFILES as readonly string[]).includes(profile)) {
    console.error(`LAYPIPE_CONFIG_PROFILE must be one of: ${CONFIG_PROFILES.join(", ")}.`);
    process.exitCode = 2;
    return;
  }
  const result = verifyProductionConfig(process.env, profile, {
    deployment: parsed.deployment,
  });
  const output = formatProductionConfigResult(result);
  if (result.ok) console.log(output);
  else {
    console.error(output);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1]?.replace(/\\/g, "/");
if (invokedPath?.endsWith("/scripts/verify-production-config.ts")) void main();
