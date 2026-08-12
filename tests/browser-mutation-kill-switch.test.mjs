import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = new Map();

function loadTypeScript(relativePath) {
  const filename = resolve(root, relativePath);
  if (cache.has(filename)) return cache.get(filename).exports;
  const loaded = { exports: {} };
  cache.set(filename, loaded);
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const localRequire = (specifier) => {
    if (!specifier.startsWith(".")) return require(specifier);
    const unresolved = resolve(dirname(filename), specifier);
    const dependency = extname(unresolved) ? unresolved : `${unresolved}.ts`;
    return loadTypeScript(dependency.slice(root.length + 1));
  };
  new Function("require", "module", "exports", "__filename", "__dirname", output)(
    localRequire,
    loaded,
    loaded.exports,
    filename,
    dirname(filename),
  );
  return loaded.exports;
}

test("browser deployment stays inert unless the public mutation switch is exactly true", () => {
  const source = readFileSync(resolve(root, "lib/web3/browser-deployment.ts"), "utf8");
  assert.match(
    source,
    /process\.env\.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED !== "true"/,
    "the public switch must remain a static Next.js-inlinable process.env reference",
  );

  const saved = process.env.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED;
  const browserDeployment = loadTypeScript("lib/web3/browser-deployment.ts");
  try {
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED;
      else process.env.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED = value;
      const result = browserDeployment.readBrowserPublicLaunchDeployment();
      assert.equal(result.configured, false, String(value));
      assert.match(result.reason, /kill switch/i);
    }
    process.env.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED = "true";
    const enabled = browserDeployment.readBrowserPublicLaunchDeployment();
    assert.equal(enabled.configured, false);
    assert.doesNotMatch(enabled.reason, /kill switch/i);
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED;
    else process.env.NEXT_PUBLIC_LAYPIPE_WALLET_MUTATIONS_ENABLED = saved;
  }
});
