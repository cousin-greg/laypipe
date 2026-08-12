import assert from "node:assert/strict";
import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const artwork = await tsImport("../lib/ipfs/artwork.ts", import.meta.url);

function pngBytes(marker = "") {
  const header = new Uint8Array(25);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(header.buffer);
  view.setUint32(16, 256, false);
  view.setUint32(20, 256, false);
  const suffix = new TextEncoder().encode(marker);
  const bytes = new Uint8Array(header.byteLength + suffix.byteLength);
  bytes.set(header);
  bytes.set(suffix, header.byteLength);
  return bytes;
}

test("browser artwork normalization stages re-encoded pixels, never source metadata", async () => {
  const privateMarker = "GPS=39.7392,-104.9903;camera-owner=private";
  const original = new File([pngBytes(privateMarker)], "family.photo.png", {
    type: "image/png",
    lastModified: 123,
  });
  const sanitizedPixels = pngBytes();
  const encodings = [];
  let closed = false;
  let drawn = false;

  const normalized = await artwork.normalizeArtworkForPublicStage(original, {
    createBitmap: async () => ({
      width: 256,
      height: 256,
      close: () => {
        closed = true;
      },
    }),
    createCanvas: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_image, _x, _y, width, height) => {
          drawn = width === 256 && height === 256;
        },
      }),
      toBlob: (callback, type) => {
        encodings.push(type);
        callback(new Blob([sanitizedPixels], { type: "image/png" }));
      },
    }),
  });

  assert.equal(normalized.file.name, "laypipe-artwork.png");
  assert.equal(normalized.file.type, "image/png");
  assert.equal(normalized.file.lastModified, 0);
  assert.equal(normalized.width, 256);
  assert.equal(drawn, true);
  assert.equal(closed, true);
  assert.deepEqual(encodings, ["image/webp", "image/png"]);
  assert.equal(
    new TextDecoder().decode(await normalized.file.arrayBuffer()).includes(privateMarker),
    false,
  );
  assert.equal(normalized.file.name.includes("family"), false);
});

test("public staging is wired to fail closed through browser normalization", () => {
  const source = readFileSync(resolve("lib/ipfs/pin-client.ts"), "utf8");
  const normalization = source.indexOf(
    "options.normalizeArtwork ?? normalizeArtworkForPublicStage",
  );
  const digest = source.indexOf("artworkContentHash(artwork.file)");
  const upload = source.indexOf("stageFile({ uploadUrl, artwork");

  assert.ok(normalization >= 0);
  assert.ok(digest > normalization);
  assert.ok(upload > digest);
  assert.doesNotMatch(source, /stageFile\(\{[^}]*options\.file/);
});
