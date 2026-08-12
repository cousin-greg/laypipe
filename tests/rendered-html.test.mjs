import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const nextBin = fileURLToPath(
  new URL("../node_modules/next/dist/bin/next", import.meta.url),
);

let app;
let baseUrl;
let serverOutput = "";

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(
    process.execPath,
    [nextBin, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const capture = (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-20_000);
  };
  app.stdout.on("data", capture);
  app.stderr.on("data", capture);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) {
      throw new Error(`Next.js exited before startup:\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(100);
  }

  throw new Error(`Next.js did not become ready:\n${serverOutput}`);
}, { timeout: 35_000 });

after(async () => {
  if (!app || app.exitCode !== null) return;

  app.kill();
  await Promise.race([once(app, "exit"), delay(5_000)]);
  if (app.exitCode === null) app.kill("SIGKILL");
});

async function render(path = "/") {
  return fetch(`${baseUrl}${path}`, {
    headers: { accept: "text/html" },
  });
}

async function expectPage(path, patterns) {
  const response = await render(path);
  assert.equal(response.status, 200, `${path} should render`);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /laypipe\.fun/i);
  assert.match(html, /Robinhood Chain/i);
  assert.match(html, /Fixture feed/i);
  assert.match(html, /pipedog-pipe-mark\.png/i);
  assert.match(html, /Dragon[_-]Regular[^"']*\.woff2/i);
  assert.match(html, /PPMori[_-]Regular[^"']*\.woff2/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
  assert.doesNotMatch(html, /buybacks?/i);

  for (const pattern of patterns) {
    assert.match(html, pattern, `${path} should contain ${pattern}`);
  }

  return html;
}

test("server-renders the board with explicitly labeled fixture data", async () => {
  const html = await expectPage("/", [
    /LAY SOME PIPE, DOG\./i,
    /Fixture launches/i,
    /THE BOARD/i,
    /Hot/i,
    /Largest/i,
    /Biggest mover/i,
    /0\.3% protocol lane routes 25% to 0xdead/i,
  ]);

  assert.doesNotMatch(html, /Preview market/i);
  assert.match(html, /Cards/i);
  assert.match(html, /Table/i);
  assert.match(html, /Search name or ticker/i);
});

test("server-renders all product routes", async () => {
  const routes = [
    [
      "/launch",
      [
        /configured release factory is unavailable/i,
        /IPFS pinning happens before wallet transactions/i,
        /Native ETH is used only for Robinhood Chain gas/i,
      ],
    ],
    [
      "/my",
      [/Live wallet data is disabled/i, /No balances or reward values are being substituted/i],
    ],
    [
      "/rewards",
      [
        /Live wallet data is disabled/i,
        /Claim creator PIPEDOG from the configured release hook/i,
      ],
    ],
    [
      "/tokenomics",
      [/Every trade feeds a visible pipe/i, /Collected in PIPEDOG/i],
    ],
    [
      "/docs",
      [
        /Contract registry/i,
        /initialize its PIPEDOG pair/i,
        /Native ETH pays network gas only/i,
        /Not production-calibrated/i,
      ],
    ],
  ];

  for (const [path, patterns] of routes) {
    await expectPage(path, patterns);
  }
});

test("server-renders demo and live protocol token detail routes", async () => {
  await expectPage("/token/pipe-dream", [
    /interface fixture/i,
    /Pool not deployed/i,
    /Self-burn/i,
    /Fixture data never activates approval, trade, or router mutations/i,
  ]);

  await expectPage("/token/pipedog", [
    /LayPipe protocol token/i,
    /PIPEDOG is live on Robinhood Chain/i,
    /Pending contract deployment/i,
    /verified direct distributions/i,
    /0x5Cb6F181081301b44905F3ae15419112ecaBd8A6/i,
  ]);
});

test("metadata uses the canonical PIPEDOG social-card dimensions", async () => {
  const html = await expectPage("/", []);
  assert.match(html, /property="og:image:width" content="1200"/i);
  assert.match(html, /property="og:image:height" content="630"/i);
  assert.match(html, /The original PIPEDOG beside a green pipe and burn furnace/i);
});
