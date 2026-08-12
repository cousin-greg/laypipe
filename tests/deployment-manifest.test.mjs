import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const { keccak256 } = require("viem");
const ts = require("typescript");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleCache = new Map();

function loadTypeScript(relativePath) {
  const filename = resolve(repositoryRoot, relativePath);
  if (moduleCache.has(filename)) return moduleCache.get(filename).exports;
  const loadedModule = { exports: {} };
  moduleCache.set(filename, loadedModule);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  function localRequire(specifier) {
    if (!specifier.startsWith(".")) return require(specifier);
    const unresolved = resolve(dirname(filename), specifier);
    const dependency = extname(unresolved) ? unresolved : `${unresolved}.ts`;
    return loadTypeScript(dependency.slice(repositoryRoot.length + 1));
  }
  new Function("require", "module", "exports", "__filename", "__dirname", output)(
    localRequire,
    loadedModule,
    loadedModule.exports,
    filename,
    dirname(filename),
  );
  return loadedModule.exports;
}

const manifests = loadTypeScript("lib/web3/deployment-manifest.ts");
const launchClient = loadTypeScript("lib/web3/launch-client.ts");
const robinhood = loadTypeScript("lib/web3/robinhood.ts");

const addresses = {
  factoryProxy: "0x1000000000000000000000000000000000000001",
  factoryImplementation: "0x1000000000000000000000000000000000000002",
  tokenImplementation: "0x1000000000000000000000000000000000000003",
  hook: "0x1000000000000000000000000000000000000004",
  swapRouter: "0x1000000000000000000000000000000000000005",
  selfBurner: "0x1000000000000000000000000000000000000006",
  revenueRouter: "0x1000000000000000000000000000000000000007",
  finalOwner: "0x2000000000000000000000000000000000000001",
  treasury: "0x2000000000000000000000000000000000000002",
  operations: "0x2000000000000000000000000000000000000003",
};

const hash = (byte) => keccak256(`0x60${byte.toString(16).padStart(2, "0")}00`);
const fakeHash = (byte) => `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;

function completeEnvironment() {
  return {
    NEXT_PUBLIC_UNISWAP_V4_POOL_MANAGER_ADDRESS:
      robinhood.ROBINHOOD_POOL_MANAGER_ADDRESS,
    NEXT_PUBLIC_LAYPIPE_DEPLOYMENT_BLOCK: "100",
    NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS: addresses.factoryProxy,
    NEXT_PUBLIC_LAYPIPE_FACTORY_RUNTIME_CODEHASH: fakeHash(1),
    NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_ADDRESS:
      addresses.factoryImplementation,
    NEXT_PUBLIC_LAYPIPE_FACTORY_IMPLEMENTATION_RUNTIME_CODEHASH: fakeHash(2),
    NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_ADDRESS:
      addresses.tokenImplementation,
    NEXT_PUBLIC_LAYPIPE_TOKEN_IMPLEMENTATION_RUNTIME_CODEHASH: fakeHash(3),
    NEXT_PUBLIC_LAYPIPE_HOOK_ADDRESS: addresses.hook,
    NEXT_PUBLIC_LAYPIPE_HOOK_RUNTIME_CODEHASH: fakeHash(4),
    NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_ADDRESS: addresses.swapRouter,
    NEXT_PUBLIC_LAYPIPE_SWAP_ROUTER_RUNTIME_CODEHASH: fakeHash(5),
    NEXT_PUBLIC_LAYPIPE_SELF_BURNER_ADDRESS: addresses.selfBurner,
    NEXT_PUBLIC_LAYPIPE_SELF_BURNER_RUNTIME_CODEHASH: fakeHash(6),
    NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_ADDRESS: addresses.revenueRouter,
    NEXT_PUBLIC_LAYPIPE_REVENUE_ROUTER_RUNTIME_CODEHASH: fakeHash(7),
    NEXT_PUBLIC_LAYPIPE_FINAL_OWNER_ADDRESS: addresses.finalOwner,
    NEXT_PUBLIC_LAYPIPE_TREASURY_ADDRESS: addresses.treasury,
    NEXT_PUBLIC_LAYPIPE_OPERATIONS_ADDRESS: addresses.operations,
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
    NEXT_PUBLIC_LAYPIPE_SOURCE_COMMIT: "ab".repeat(20),
    NEXT_PUBLIC_LAYPIPE_COMPILER_VERSION: "0.8.26+commit.8a97fa7a",
    NEXT_PUBLIC_LAYPIPE_ABI_BUNDLE_SHA256: fakeHash(8),
    NEXT_PUBLIC_LAYPIPE_ARTIFACT_BUNDLE_SHA256: fakeHash(9),
  };
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function signedWord(value) {
  const bigint = BigInt(value);
  return word(bigint < 0n ? (1n << 256n) + bigint : bigint);
}

function addressWord(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function uintWord(value) {
  return `0x${word(value)}`;
}

function configData(config) {
  return `0x${[
    word(config.supply),
    signedWord(config.tickSpacing),
    signedWord(config.startTick),
    word(config.creatorFeeBps),
    word(config.baseFeeRate),
    word(config.launchFeeRate),
    word(config.launchFeeDecay),
    word(config.enabled ? 1 : 0),
    word(config.selfBurn ? 1 : 0),
  ].join("")}`;
}

function runtimeManifest() {
  const parsed = manifests.parseRobinhoodProductionManifest(completeEnvironment());
  const labels = Object.keys(parsed.contracts);
  labels.forEach((label, index) => {
    parsed.contracts[label].runtimeCodehash = hash(index + 1);
  });
  return parsed;
}

function manifestProvider(manifest, options = {}) {
  const calls = [];
  const contractEntries = Object.entries(manifest.contracts);
  const codeByAddress = new Map(
    contractEntries.map(([, contract], index) => [
      contract.address.toLowerCase(),
      `0x60${(index + 1).toString(16).padStart(2, "0")}00`,
    ]),
  );
  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const selectors = {
    launchFee: "0xcf3cf573",
    launchEnabled: "0x236a4afb",
    getLaunchConfig: "0x1cad862d",
    hook: "0x7f5a7c7b",
    tokenImplementation: "0x2f3a3d5d",
    selfBurner: "0xdc605138",
    treasury: "0x61d027b3",
    poolManager: "0xdc4c90d3",
    factory: "0xc45a0155",
    quoteToken: "0x217a4b70",
    pipedog: "0xa9ca72e2",
    operationsWallet: "0xfd72e22a",
    owner: "0x8da5cb5b",
    pendingOwner: "0xe30c3978",
    maxBurnPerCall: "0x8ace49e4",
    bountyBps: "0x415307cc",
    paused: "0x5c975abb",
    maxSequesterPerCall: "0x9c6ce490",
    maxTreasuryRoutePerCall: "0x260070fc",
  };

  function binding(to, selector, data) {
    const target = to.toLowerCase();
    const factory = manifest.contracts.factoryProxy.address.toLowerCase();
    const hook = manifest.contracts.hook.address.toLowerCase();
    const burner = manifest.contracts.selfBurner.address.toLowerCase();
    const swap = manifest.contracts.swapRouter.address.toLowerCase();
    const revenue = manifest.contracts.revenueRouter.address.toLowerCase();
    const c = manifest.contracts;
    if (target === factory) {
      if (selector === selectors.poolManager) return addressWord(c.poolManager.address);
      if (selector === selectors.quoteToken) return addressWord(c.pipedog.address);
      if (selector === selectors.hook) {
        return addressWord(options.factoryHook ?? c.hook.address);
      }
      if (selector === selectors.tokenImplementation) return addressWord(c.tokenImplementation.address);
      if (selector === selectors.selfBurner) return addressWord(c.selfBurner.address);
      if (selector === selectors.treasury) return addressWord(c.revenueRouter.address);
      if (selector === selectors.owner) return addressWord(manifest.governance.finalOwner);
      if (selector === selectors.pendingOwner) return addressWord(zeroAddress);
      if (selector === selectors.launchFee) return uintWord(manifest.launch.launchFee);
      if (selector === selectors.launchEnabled) return uintWord(1);
      if (selector === selectors.getLaunchConfig) {
        const configId = BigInt(`0x${data.slice(10)}`);
        const expected =
          configId === manifest.launch.creator.id
            ? manifest.launch.creator.config
            : manifest.launch.selfBurn.config;
        return configData(
          options.mutatedConfig
            ? { ...expected, startTick: expected.startTick + 60 }
            : expected,
        );
      }
    }
    if (target === hook) {
      if (selector === selectors.factory) return addressWord(c.factoryProxy.address);
      if (selector === selectors.poolManager) return addressWord(c.poolManager.address);
      if (selector === selectors.quoteToken) return addressWord(c.pipedog.address);
      if (selector === selectors.treasury) return addressWord(c.revenueRouter.address);
      if (selector === selectors.owner) return addressWord(manifest.governance.finalOwner);
      if (selector === selectors.pendingOwner) return addressWord(zeroAddress);
    }
    if (target === burner) {
      if (selector === selectors.factory) return addressWord(c.factoryProxy.address);
      if (selector === selectors.poolManager) return addressWord(c.poolManager.address);
      if (selector === selectors.hook) return addressWord(c.hook.address);
      if (selector === selectors.quoteToken) return addressWord(c.pipedog.address);
      if (selector === selectors.maxBurnPerCall) return uintWord(manifest.routing.selfBurnMaxPerCall);
      if (selector === selectors.bountyBps) return uintWord(manifest.routing.selfBurnBountyBps);
    }
    if (target === swap) {
      if (selector === selectors.poolManager) return addressWord(c.poolManager.address);
      if (selector === selectors.pipedog) return addressWord(c.pipedog.address);
      if (selector === selectors.hook) return addressWord(c.hook.address);
    }
    if (target === revenue) {
      if (selector === selectors.pipedog) return addressWord(c.pipedog.address);
      if (selector === selectors.treasury) return addressWord(manifest.governance.treasury);
      if (selector === selectors.operationsWallet) return addressWord(manifest.governance.operations);
      if (selector === selectors.owner) return addressWord(manifest.governance.finalOwner);
      if (selector === selectors.pendingOwner) return addressWord(zeroAddress);
      if (selector === selectors.paused) return uintWord(0);
      if (selector === selectors.maxSequesterPerCall) return uintWord(manifest.routing.revenueMaxSequesterPerCall);
      if (selector === selectors.maxTreasuryRoutePerCall) return uintWord(manifest.routing.revenueMaxTreasuryRoutePerCall);
      if (selector === selectors.bountyBps) return uintWord(manifest.routing.revenueBountyBps);
    }
    throw new Error(`Unhandled call ${to} ${selector}`);
  }

  return {
    calls,
    async request({ method, params = [] }) {
      calls.push(method);
      if (method === "eth_chainId") return manifest.chain.chainIdHex;
      if (method === "eth_blockNumber") return "0x100";
      if (method === "eth_getCode") return codeByAddress.get(params[0].toLowerCase());
      if (method === "eth_getStorageAt") {
        return addressWord(
          options.implementation ?? manifest.contracts.factoryImplementation.address,
        );
      }
      if (method === "eth_call") {
        const { to, data } = params[0];
        return binding(to, data.slice(0, 10), data);
      }
      if (method === "eth_estimateGas") return "0x5208";
      if (method === "eth_sendTransaction") return `0x${"ab".repeat(32)}`;
      throw new Error(`Unhandled RPC method ${method}`);
    },
  };
}

test("production manifest is complete-or-disabled and pins canonical externals", () => {
  const disabled = robinhood.readPublicLaunchDeployment({
    NEXT_PUBLIC_LAYPIPE_FACTORY_ADDRESS: addresses.factoryProxy,
  });
  assert.equal(disabled.configured, false);
  assert.match(disabled.reason, /PoolManager address is not configured/);

  const configured = robinhood.readPublicLaunchDeployment(completeEnvironment());
  assert.equal(configured.configured, true);
  assert.equal(configured.deployment.chain.chainId, 4663);
  assert.equal(
    configured.deployment.contracts.pipedog.address.toLowerCase(),
    robinhood.PIPEDOG_ADDRESS.toLowerCase(),
  );
  assert.equal(
    configured.deployment.contracts.poolManager.address.toLowerCase(),
    robinhood.ROBINHOOD_POOL_MANAGER_ADDRESS.toLowerCase(),
  );
  assert.equal(configured.deployment.launch.creator.config.selfBurn, false);
  assert.equal(configured.deployment.launch.selfBurn.config.selfBurn, true);
});

test("address-only clients cannot reach wallet mutations", async () => {
  const provider = { calls: [], async request({ method }) { this.calls.push(method); } };
  const client = new launchClient.LaypipeLaunchClient(
    provider,
    addresses.factoryProxy,
  );
  await assert.rejects(client.sendApproval(addresses.finalOwner, 1n), /manifest is not loaded/);
  assert.deepEqual(provider.calls, []);
});

test("fully configured audited manifest reaches a wallet mutation", async () => {
  const manifest = runtimeManifest();
  const provider = manifestProvider(manifest);
  const client = new launchClient.LaypipeLaunchClient(provider, manifest);
  const transactionHash = await client.sendApproval(addresses.finalOwner, 10n);
  assert.equal(transactionHash, `0x${"ab".repeat(32)}`);
  assert.equal(provider.calls.includes("eth_getStorageAt"), true);
  assert.equal(provider.calls.includes("eth_estimateGas"), true);
  assert.equal(provider.calls.includes("eth_sendTransaction"), true);
});

test("implementation, component, and config drift fail closed before a mutation", async () => {
  const cases = [
    {
      label: "implementation",
      options: { implementation: "0x3000000000000000000000000000000000000001" },
      message: /implementation address does not match/,
    },
    {
      label: "component",
      options: { factoryHook: "0x3000000000000000000000000000000000000002" },
      message: /Factory hook does not match/,
    },
    {
      label: "config",
      options: { mutatedConfig: true },
      message: /startTick does not match/,
    },
  ];
  for (const drift of cases) {
    const manifest = runtimeManifest();
    const provider = manifestProvider(manifest, drift.options);
    const client = new launchClient.LaypipeLaunchClient(provider, manifest);
    await assert.rejects(
      client.sendApproval(addresses.finalOwner, 10n),
      drift.message,
      drift.label,
    );
    assert.equal(provider.calls.includes("eth_sendTransaction"), false);
  }
});

test("Base Sepolia manifest construction requires an explicit test-only marker", () => {
  assert.equal(manifests.BASE_SEPOLIA_TEST_ACKNOWLEDGEMENT, "BASE_SEPOLIA_REHEARSAL_ONLY");
  const source = readFileSync(
    resolve(repositoryRoot, "lib/web3/deployment-manifest.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /NEXT_PUBLIC_(?:LAYPIPE_)?NETWORK/);
  assert.match(source, /environment: "base-sepolia-test-only"/);
});
