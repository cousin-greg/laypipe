import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function reservePort() {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "Could not reserve a local port.");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function boundedLog(buffer, chunk) {
  const next = `${buffer}${chunk}`;
  return next.length > 16_000 ? next.slice(-16_000) : next;
}

async function waitForServer(origin, child, output) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next exited before becoming ready.\n${output()}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) return;
    } catch {
      // The server socket is not accepting requests yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Next did not become ready within 20 seconds.\n${output()}`);
}

async function readResponse(origin, pathname, init) {
  const response = await fetch(`${origin}${pathname}`, {
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
    ...init,
  });
  return { response, text: await response.text() };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const port = await reservePort();
const origin = `http://127.0.0.1:${port}`;
const nextBin = path.join(repositoryRoot, "node_modules", "next", "dist", "bin", "next");
let stdout = "";
let stderr = "";

const child = spawn(process.execPath, [nextBin, "start", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: repositoryRoot,
  env: {
    ...process.env,
    CRON_SECRET: "",
    DATABASE_URL: "",
    INDEXER_ENABLED: "false",
    IPFS_PINNING_ENABLED: "false",
    LAYPIPE_MARKET_MODE: "fixture",
    NEXT_PUBLIC_SITE_URL: origin,
    PINATA_JWT: "",
    UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "",
    UPSTASH_REDIS_REST_KV_REST_API_URL: "",
    WALLET_CHALLENGE_SECRET: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout = boundedLog(stdout, chunk);
});
child.stderr.on("data", (chunk) => {
  stderr = boundedLog(stderr, chunk);
});

try {
  await waitForServer(origin, child, () => `${stdout}\n${stderr}`);

  const home = await readResponse(origin, "/");
  assert.equal(home.response.status, 200);
  assert.match(home.text, /LAY SOME PIPE, DOG\./);
  assert.match(home.text, /Fixture launches/);
  assert.equal(home.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(home.response.headers.get("x-frame-options"), "DENY");
  assert.equal(home.response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  const fontPath = home.text.match(/\/_next\/static\/media\/[^"']+\.woff2/)?.[0];
  assert(fontPath, "The rendered page did not preload a bundled local font.");
  const font = await readResponse(origin, fontPath);
  assert.equal(font.response.status, 200);

  const docs = await readResponse(origin, "/docs");
  assert.equal(docs.response.status, 200);
  assert.match(docs.text, /0x5Cb6F181081301b44905F3ae15419112ecaBd8A6/);
  assert.match(docs.text, /No demo coin shown on the Board/);

  const tokenomics = await readResponse(origin, "/tokenomics");
  assert.equal(tokenomics.response.status, 200);
  assert.match(tokenomics.text, /Self-burn \(disabled\)/);
  assert.match(tokenomics.text, /25% to 0xdead/);

  const health = await readResponse(origin, "/api/health", {
    headers: { Accept: "application/json" },
  });
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(health.text), {
    status: "alive",
    check: "liveness",
    marketMode: "fixture",
    readyForLiveMarkets: false,
    database: { status: "not_checked", reason: "Fixture mode does not use Neon." },
    indexer: { status: "not_checked", reason: "Fixture mode does not require an indexer." },
  });

  const readiness = await readResponse(origin, "/api/ready", {
    headers: { Accept: "application/json" },
  });
  assert.equal(readiness.response.status, 503);
  assert.equal(readiness.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(readiness.text), {
    status: "not_ready",
    check: "readiness",
    marketMode: "fixture",
    readyForLiveMarkets: false,
    database: { status: "not_checked" },
    indexer: { status: "not_checked" },
  });

  const tokens = await readResponse(origin, "/api/tokens?limit=50", {
    headers: { Accept: "application/json" },
  });
  assert.equal(tokens.response.status, 503);
  assert.equal(tokens.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(tokens.text), {
    error: {
      code: "market_data_unavailable",
      message: "Live market data is disabled for this deployment.",
    },
  });

  const indexer = await readResponse(origin, "/api/indexer/sync", {
    headers: { Accept: "application/json" },
  });
  assert.equal(indexer.response.status, 503);
  assert.equal(indexer.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(indexer.text), {
    error: "Indexer sync is unavailable.",
    code: "INDEXER_NOT_CONFIGURED",
  });

  const stage = await readResponse(origin, "/api/ipfs/stage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
    },
    body: "{}",
  });
  assert.equal(stage.response.status, 503);
  assert.equal(stage.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(JSON.parse(stage.text), {
    error: "Artwork publishing is currently disabled.",
    code: "IPFS_DISABLED",
  });

  const manifest = await readResponse(origin, "/manifest.webmanifest");
  assert.equal(manifest.response.status, 200);
  const manifestDocument = JSON.parse(manifest.text);
  assert.equal(manifestDocument.name, "laypipe.fun");
  assert.equal(manifestDocument.short_name, "LayPipe");
  assert.equal(manifestDocument.icons?.[0]?.src, "/brand/pipedog-pipe-mark.png");

  const brandMark = await readResponse(origin, "/brand/pipedog-pipe-mark.png");
  assert.equal(brandMark.response.status, 200);

  process.stdout.write("Runtime smoke verification passed: UI, security headers, liveness/readiness, and disabled mutation boundaries.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  if (stdout || stderr) process.stderr.write(`\nNext output:\n${stdout}\n${stderr}\n`);
  process.exitCode = 1;
} finally {
  await stopServer(child);
}
