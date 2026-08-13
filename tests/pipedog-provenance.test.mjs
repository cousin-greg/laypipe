import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("published Domge artifact is pinned to the documented source hash", () => {
  const published = resolve(root, "public/brand/pipedog-domge-source.png");
  const expected =
    "05450b2360b7591058bb19bc050b6c84546851d75d6623e1867e0e96b0a3f9b2";

  assert.equal(sha256(published), expected);
});

test("lore page records sources, uncertainty, and the permanent image ethos", () => {
  const page = readFileSync(resolve(root, "app/lore/page.tsx"), "utf8");

  assert.match(page, /kabosu112\.exblog\.jp\/9944144/);
  assert.match(page, /instagram\.com\/p\/BYntbPTF1_f/);
  assert.match(page, /reddit\.com\/r\/dogelore\/comments\/fbzzbg\/domge_png/);
  assert.match(page, /knowyourmeme\.com\/photos\/1767872-ironic-doge-memes/);
  assert.match(page, /Shutterstock 1527641588/);
  assert.match(page, /earliest confirmed public\s+uploader/i);
  assert.match(page, /Keep the marks on the objects/);
  assert.match(page, /We add context; we do not regenerate the ancestor/);
  assert.match(page, /exact frames not found/i);
  assert.match(page, /does not itself grant a license/i);
});
