import assert from "node:assert/strict";
import test from "node:test";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

async function render(path = "/") {
  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function expectPage(path, patterns) {
  const response = await render(path);
  assert.equal(response.status, 200, `${path} should render`);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /laypipe\.fun/i);
  assert.match(html, /Robinhood Chain/i);
  assert.match(html, /Demo feed/i);
  assert.match(html, /laypipe-mark\.png/i);
  assert.match(html, /Dragon-Regular[^"']*\.woff2/i);
  assert.match(html, /PPMori-Regular[^"']*\.woff2/i);
  assert.match(html, /--font-mori/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);

  for (const pattern of patterns) {
    assert.match(html, pattern, `${path} should contain ${pattern}`);
  }

  return html;
}

test("server-renders the board with explicit preview data", async () => {
  const html = await expectPage("/", [
    /Find the next coin down the pipe/i,
    /Preview market/i,
    /realistic demo fixtures/i,
    /THE BOARD/i,
    /Hot/i,
    /Largest/i,
    /Biggest mover/i,
  ]);

  assert.match(html, /Cards/i);
  assert.match(html, /Table/i);
  assert.match(html, /Search name or ticker/i);
});

test("server-renders all product routes", async () => {
  const routes = [
    ["/launch", /Factory deployment and audit are still pending/i],
    ["/my", /Connect to inspect your pipes/i],
    ["/rewards", /No live sweeps/i],
    ["/tokenomics", /Every trade feeds a visible pipe/i],
    ["/docs", /Contract registry/i],
  ];

  for (const [path, pattern] of routes) {
    await expectPage(path, [pattern]);
  }
});

test("server-renders demo and live protocol token detail routes", async () => {
  await expectPage("/token/pipe-dream", [
    /interface fixture/i,
    /Pool not deployed/i,
    /Self-burn/i,
  ]);

  await expectPage("/token/pipedog", [
    /LayPipe protocol token/i,
    /PIPEDOG is live on Robinhood Chain/i,
    /Pending contract deployment/i,
    /0x5Cb6F181081301b44905F3ae15419112ecaBd8A6/i,
  ]);
});

test("metadata uses the current social-card dimensions", async () => {
  const html = await expectPage("/", []);
  assert.match(html, /property="og:image:width" content="1728"/i);
  assert.match(html, /property="og:image:height" content="910"/i);
});
