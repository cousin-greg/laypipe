import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
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

test("server-renders the laypipe product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /laypipe\.fun/i);
  assert.match(html, /Fees in\./i);
  assert.match(html, /PIPEDOG burns\./i);
  assert.match(html, /Launch preview/i);
  assert.match(html, /Contracts pending audit/i);
  assert.match(html, /0x5Cb6F181081301b44905F3ae15419112ecaBd8A6/i);
  assert.match(html, /Dragon-Regular[^"']*\.woff2/i);
  assert.match(html, /--font-dragon/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});
