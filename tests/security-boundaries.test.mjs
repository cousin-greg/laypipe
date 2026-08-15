import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const nextConfigModule = await tsImport("../next.config.ts", import.meta.url);
const observability = await tsImport(
  "../lib/server/observability.ts",
  import.meta.url,
);

test("production CSP covers every intentional browser network boundary", async () => {
  const policy = nextConfigModule.buildContentSecurityPolicy(false);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self' 'unsafe-inline'/);
  assert.doesNotMatch(policy, /unsafe-eval/);
  assert.match(policy, /connect-src[^;]*https:\/\/uploads\.pinata\.cloud/);
  assert.match(
    policy,
    /connect-src[^;]*https:\/\/rpc\.mainnet\.chain\.robinhood\.com/,
  );
  assert.match(policy, /img-src[^;]*https:\/\/\*\.mypinata\.cloud/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /script-src-attr 'none'/);
  assert.match(policy, /frame-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /base-uri 'self'/);
  assert.doesNotMatch(policy, /[\r\n]/);

  const rules = await nextConfigModule.default.headers();
  const globalRule = rules.find((rule) => rule.source === "/(.*)");
  const header = globalRule.headers.find(
    (candidate) => candidate.key === "Content-Security-Policy",
  );
  assert.equal(
    header.value,
    nextConfigModule.buildContentSecurityPolicy(
      process.env.NODE_ENV !== "production",
    ),
  );
});

test("layout uses one light scheme without a runtime theme bootstrap", () => {
  const layout = readFileSync(resolve("app/layout.tsx"), "utf8");
  assert.match(layout, /colorScheme: "light"/);
  assert.doesNotMatch(layout, /theme-init\.js|next\/script|data-theme/);
  assert.doesNotMatch(layout, /dangerouslySetInnerHTML/);
});

test("expected fixture readiness is quiet while real failures remain secret-free", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try {
    const request = new Request("https://laypipe.fun/api/ready", {
      headers: { authorization: "Bearer must-never-be-logged" },
    });
    await observability.observeOperationalRequest(
      request,
      "/api/ready",
      async () => Response.json({ status: "not_ready" }, { status: 503 }),
      { expectedFailureStatuses: [503] },
    );
    assert.equal(lines.length, 0);

    await observability.observeOperationalRequest(
      request,
      "/api/ready",
      async () => Response.json({ status: "not_ready" }, { status: 503 }),
    );
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"status":503/);
  assert.doesNotMatch(lines[0], /must-never-be-logged/);
});

test("routine public client errors cannot amplify custom operational logs", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const lines = [];
  console.error = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try {
    const request = new Request("https://laypipe.fun/api/auth/challenge");
    for (let index = 0; index < 25; index += 1) {
      await observability.observeOperationalRequest(
        request,
        "/api/auth/challenge",
        async () => Response.json({ code: "ORIGIN" }, { status: 403 }),
      );
    }
    assert.equal(lines.length, 0);

    await observability.observeOperationalRequest(
      request,
      "/api/auth/challenge",
      async () => Response.json({ code: "INTERNAL_ERROR" }, { status: 500 }),
    );
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /"status":500/);
});

test("wallet-authorized IPFS routes emit bounded failure summaries", () => {
  const http = readFileSync(resolve("lib/server/auth/http.ts"), "utf8");
  assert.doesNotMatch(http, /LayPipe API request failed|console\.error/);
  for (const [path, route] of [
    ["app/api/auth/challenge/route.ts", "/api/auth/challenge"],
    ["app/api/ipfs/stage/route.ts", "/api/ipfs/stage"],
    ["app/api/ipfs/pin/route.ts", "/api/ipfs/pin"],
  ]) {
    const source = readFileSync(resolve(path), "utf8");
    assert.match(source, /observeOperationalRequest/);
    assert.ok(source.includes(`"${route}"`));
    assert.doesNotMatch(source, /emitOperationalSummary\([^)]*(signature|challenge)/s);
  }
});

test("keeper read failures emit bounded summaries without wallet/body logging", () => {
  const source = readFileSync(resolve("app/api/keeper/route.ts"), "utf8");
  assert.match(source, /observeOperationalRequest/);
  assert.ok(source.includes('"/api/keeper"'));
  assert.doesNotMatch(source, /console\.|emitOperationalSummary|request\.json/);
});
