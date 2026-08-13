import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadTypeScript(relativePath) {
  const filename = resolve(root, relativePath);
  const loaded = { exports: {} };
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  new Function("require", "module", "exports", output)(
    require,
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const laypipe = loadTypeScript("app/_data/laypipe.ts");

test("one billion LAYPIPE divides into exactly 10,000 automatic PipeDogs", () => {
  assert.equal(laypipe.LAYPIPE_TOTAL_SUPPLY, 1_000_000_000);
  assert.equal(laypipe.LAYPIPE_MAX_PIPE_DOGS, 10_000);
  assert.equal(laypipe.LAYPIPE_PER_PIPE_DOG, 100_000);
  assert.equal(
    laypipe.LAYPIPE_PER_PIPE_DOG * laypipe.LAYPIPE_MAX_PIPE_DOGS,
    laypipe.LAYPIPE_TOTAL_SUPPLY,
  );
  assert.equal(laypipe.LAYPIPE_TRADE_FEE_BPS, 100);
});

test("automatic NFT and reward weight use only whole 100,000-token units", () => {
  assert.deepEqual(laypipe.calculatePipeDogPosition(BigInt(99_999)), {
    balance: "99999",
    pipeDogCount: 0,
    rewardUnits: 0,
    remainder: "99999",
    tokensToNextPipeDog: "1",
    progressBps: 9999,
  });
  assert.deepEqual(laypipe.calculatePipeDogPosition(BigInt(100_000)), {
    balance: "100000",
    pipeDogCount: 1,
    rewardUnits: 1,
    remainder: "0",
    tokensToNextPipeDog: "100000",
    progressBps: 0,
  });
  assert.deepEqual(laypipe.calculatePipeDogPosition(BigInt(248_250)), {
    balance: "248250",
    pipeDogCount: 2,
    rewardUnits: 2,
    remainder: "48250",
    tokensToNextPipeDog: "51750",
    progressBps: 4825,
  });
  assert.throws(
    () => laypipe.calculatePipeDogPosition(BigInt(-1)),
    /cannot be negative/i,
  );
});

test("preview adapter fails closed until singleton addresses and ABIs land", async () => {
  const data = await laypipe.readLaypipePageData();
  assert.equal(data.protocol.mode, "contract-preview");
  assert.equal(data.protocol.tradingEnabled, false);
  assert.equal(data.protocol.claimEnabled, false);
  assert.equal(data.protocol.quoteSymbol, "PIPEDOG");
  assert.equal(data.wallet.mode, "contract-preview");
  assert.equal(data.wallet.pipeDogCount, data.wallet.rewardUnits);
});

test("primary product surface is singleton-only and exposes no wallet mutation adapter", () => {
  const page = readFileSync(resolve(root, "app/page.tsx"), "utf8");
  const product = readFileSync(
    resolve(root, "app/_components/LaypipeProduct.tsx"),
    "utf8",
  );
  const trade = readFileSync(
    resolve(root, "app/_components/LaypipeTradePanel.tsx"),
    "utf8",
  );
  const shell = readFileSync(
    resolve(root, "app/_components/SiteShell.tsx"),
    "utf8",
  );
  const retiredLaunch = readFileSync(
    resolve(root, "app/launch/page.tsx"),
    "utf8",
  );
  const retiredToken = readFileSync(
    resolve(root, "app/token/[slug]/page.tsx"),
    "utf8",
  );

  assert.match(page, /readLaypipePageData/);
  assert.match(page, /<LaypipeProduct data=\{data\}/);
  assert.match(product, /1,000,000,000/);
  assert.match(product, /100,000-token threshold/);
  assert.match(product, /All to NFT holders/);
  assert.match(product, /src="\/brand\/pipedog\.png"/);
  assert.match(trade, /Trading opens when contracts are wired/);
  assert.match(trade, /at most 20 NFT thresholds[\s\S]*split across transactions/);
  assert.doesNotMatch(trade, /@\/lib\/web3|eth_sendTransaction|writeContract/);
  assert.doesNotMatch(shell, /Launch a coin|Latest indexed launches|Fixture feed/);
  assert.doesNotMatch(shell, /href="\/launch"|label: "Board"/);
  assert.match(shell, /label: "My PipeDogs"/);
  assert.match(shell, /label: "Lore"/);
  assert.match(shell, /1%<\/strong> PIPEDOG fee to NFT holders/);
  assert.match(retiredLaunch, /redirect\("\/#trade"\)/);
  assert.match(retiredToken, /redirect\("\/#trade"\)/);
});
