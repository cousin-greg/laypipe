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
  assert.match(html, /100,000[\s\S]*LAYPIPE per PipeDog/i);
  assert.match(html, /pipedog-pipe-mark\.png/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
  assert.doesNotMatch(html, /buybacks?/i);
  assert.doesNotMatch(html, /Launch a coin|Latest indexed launches|Fixture feed/i);

  for (const pattern of patterns) {
    assert.match(html, pattern, `${path} should contain ${pattern}`);
  }

  return html;
}

async function expectCanonicalFontAssets(html) {
  const stylesheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/gi)]
    .map((match) => match[1]);
  assert.ok(stylesheets.length > 0, "rendered page should link its built stylesheets");
  const css = (
    await Promise.all(
      stylesheets.map(async (href) => {
        const response = await fetch(new URL(href, baseUrl));
        assert.equal(response.status, 200, `${href} should load`);
        return response.text();
      }),
    )
  ).join("\n");
  assert.match(css, /Dragon[_-]Regular[^"')]*\.woff2/i);
  assert.match(css, /PPMori[_-]Regular[^"')]*\.woff2/i);
}

test("server-renders the singleton LayPipe product surface", async () => {
  const html = await expectPage("/", [
    /One coin\. One pipe\./i,
    /1,000,000,000/i,
    /10,000/i,
    /Automatic threshold/i,
    /One clean percent/i,
    /My PipeDogs/i,
    /51,750[\s\S]*LAYPIPE to go/i,
    /Trading opens when contracts are wired/i,
  ]);

  await expectCanonicalFontAssets(html);

  assert.match(html, /Contract preview/i);
  assert.match(html, /src="\/brand\/pipedog\.png"/i);
  assert.doesNotMatch(html, /href="\/launch"|label: "Board"/i);
});

test("server-renders singleton wallet, reward, mechanics, and docs routes", async () => {
  const routes = [
    [
      "/my",
      [/My PipeDogs/i, /Preview position/i, /51,750[\s\S]*LAYPIPE to go/i],
    ],
    [
      "/rewards",
      [
        /Claim from the pipe/i,
        /Claimable PIPEDOG/i,
        /Claim PIPEDOG/i,
      ],
    ],
    [
      "/tokenomics",
      [
        /Every official-pool trade fills the PipeDog pool/i,
        /Collected in PIPEDOG/i,
        /No developer cut/i,
      ],
    ],
    [
      "/docs",
      [
        /One product/i,
        /Very large buys may need to be split/i,
        /Contract registry/i,
        /One percent to holders/i,
        /100,000 LAYPIPE held by a wallet/i,
      ],
    ],
  ];

  for (const [path, patterns] of routes) {
    await expectPage(path, patterns);
  }
});

test("metadata uses the canonical PIPEDOG social-card dimensions", async () => {
  const html = await expectPage("/", []);
  assert.match(html, /property="og:image:width" content="1200"/i);
  assert.match(html, /property="og:image:height" content="630"/i);
  assert.match(html, /The original PIPEDOG beside the LayPipe/i);
});
