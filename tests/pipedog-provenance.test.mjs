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

test("lore page distinguishes PipeDog from Lay Pipedogs and records the net-art ethos", () => {
  const page = readFileSync(resolve(root, "app/lore/page.tsx"), "utf8");
  const css = readFileSync(resolve(root, "app/lore/lore.module.css"), "utf8");

  assert.match(page, /kabosu112\.exblog\.jp\/9944144/);
  assert.match(page, /instagram\.com\/p\/BYntbPTF1_f/);
  assert.match(page, /reddit\.com\/r\/dogelore\/comments\/fbzzbg\/domge_png/);
  assert.match(page, /knowyourmeme\.com\/photos\/1767872-ironic-doge-memes/);
  assert.match(page, /Shutterstock 1527641588/);
  assert.match(page, /earliest located public post/i);
  assert.doesNotMatch(page, /earliest confirmed public\s+uploader/i);
  assert.match(
    page,
    /api\.memes\.com\/m\/literally-all-balkan-grandpa-s-0mWw61GeqW3/,
  );
  assert.match(page, /balkan-grandpa-2021\.jpg/);
  assert.match(page, /detective-cheems-2020\.png/);
  assert.match(page, /dog-rushmore-2026-display\.webp/);
  assert.match(page, /Keep the marks on the objects/);
  assert.match(page, /Lay Pipedogs is LayPipe&apos;s planned\s+collection/);
  assert.match(page, /same exact Domge\s+cutout/);
  assert.match(page, /common visual substrate/);
  assert.match(page, /distributed\s+anthology rather than ten thousand claims/);
  assert.match(page, /Marlboro, Newport, Lucky Strike/);
  assert.match(page, /exact frames not found/i);
  assert.match(page, /does not itself grant a license/i);
  assert.doesNotMatch(css, /var\(--dragon\)/);
  assert.match(css, /\.masthead h1[\s\S]*font-family: var\(--mori\)/);
});

test("published timeline preserves the exact captioned Balkan artifact", () => {
  const published = resolve(root, "public/lore/balkan-grandpa-2021.jpg");
  const expected =
    "7595ade529ad0d8d92de6df5db0df2bbe111905df897fcb8814260033305f3a8";

  assert.equal(sha256(published), expected);
});
