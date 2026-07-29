import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";

const root = process.cwd();
const publicDir = path.join(root, "public");
const brandDir = path.join(publicDir, "brand");
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

async function dataUrl(filePath, mimeType) {
  const bytes = await readFile(filePath);
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

async function findBrowser() {
  for (const candidate of chromeCandidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next installed Chromium browser.
    }
  }

  throw new Error("Chrome or Edge is required to regenerate the brand images.");
}

async function capture(browser, html, width, height, outputPath, name) {
  const temporaryHtml = path.join(root, "scripts", `.${name}.html`);
  const temporaryPng = path.join(root, "scripts", `.${name}.png`);

  await writeFile(temporaryHtml, html, "utf8");

  try {
    const result = spawnSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--force-device-scale-factor=1",
        `--window-size=${width},${height}`,
        `--screenshot=${temporaryPng}`,
        pathToFileURL(temporaryHtml).href,
      ],
      { encoding: "utf8" },
    );

    if (result.status !== 0) {
      throw new Error(result.stderr || `Chromium exited with ${result.status}`);
    }

    await sharp(temporaryPng)
      .resize(width, height, { fit: "fill" })
      .png({ compressionLevel: 9, palette: true, quality: 94 })
      .toFile(outputPath);
  } finally {
    await rm(temporaryHtml, { force: true });
    await rm(temporaryPng, { force: true });
  }
}

const [browser, dog, machine, mori, dragon] = await Promise.all([
  findBrowser(),
  dataUrl(path.join(brandDir, "pipedog-cutout.png"), "image/png"),
  dataUrl(path.join(brandDir, "pipe-furnace.png"), "image/png"),
  dataUrl(path.join(root, "app", "fonts", "PPMori-Bold.woff2"), "font/woff2"),
  dataUrl(path.join(root, "app", "fonts", "Dragon-Black.woff2"), "font/woff2"),
]);

const sharedStyles = `
  @font-face {
    font-family: "PP Mori";
    src: url("${mori}") format("woff2");
    font-weight: 700;
  }
  @font-face {
    font-family: "Dragon";
    src: url("${dragon}") format("woff2");
    font-weight: 900;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; }
`;

const openGraphHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${sharedStyles}
      body {
        background: #fff1a8;
        color: #172016;
      }
      .card {
        position: relative;
        width: 1200px;
        height: 630px;
        overflow: hidden;
        border: 14px solid #172016;
        background:
          radial-gradient(circle at 85% 14%, rgba(255, 177, 31, 0.62), transparent 25%),
          linear-gradient(180deg, #fff8d7 0 68%, #bee879 68% 100%);
      }
      .copy {
        position: absolute;
        z-index: 5;
        top: 60px;
        left: 66px;
        width: 680px;
      }
      .chain {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 10px 15px;
        border: 3px solid #172016;
        border-radius: 999px;
        background: rgba(255, 253, 235, 0.84);
        font: 700 18px/1 "PP Mori", sans-serif;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .chain::before {
        width: 13px;
        height: 13px;
        border-radius: 50%;
        background: #00c805;
        content: "";
      }
      h1 {
        margin: 34px 0 10px;
        font: 900 112px/0.82 "Dragon", sans-serif;
        letter-spacing: 0.035em;
      }
      h1 span { color: #ed5a1b; }
      .tagline {
        margin: 0;
        font: 700 31px/1.16 "PP Mori", sans-serif;
        letter-spacing: -0.02em;
      }
      .route {
        display: inline-block;
        margin-top: 22px;
        padding: 12px 16px 10px;
        border: 3px solid #172016;
        border-radius: 10px;
        background: #fffbed;
        font: 700 18px/1 "PP Mori", sans-serif;
        letter-spacing: 0.045em;
        text-transform: uppercase;
        transform: rotate(-1deg);
      }
      .dog {
        position: absolute;
        z-index: 2;
        left: 550px;
        bottom: 215px;
        width: 260px;
        height: auto;
        filter: drop-shadow(0 12px 10px rgba(34, 42, 26, 0.22));
      }
      .machine {
        position: absolute;
        z-index: 3;
        right: -38px;
        bottom: -8px;
        width: 735px;
        height: auto;
        filter: drop-shadow(0 15px 13px rgba(34, 42, 26, 0.24));
      }
      .burn {
        position: absolute;
        z-index: 4;
        right: 38px;
        bottom: 30px;
        padding: 9px 12px 8px;
        border: 3px solid #172016;
        border-radius: 8px;
        background: #fffbed;
        font: 700 15px/1 "PP Mori", sans-serif;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        transform: rotate(2deg);
      }
    </style>
  </head>
  <body>
    <main class="card">
      <section class="copy">
        <div class="chain">Robinhood Chain</div>
        <h1>LAYPIPE<span>.FUN</span></h1>
        <p class="tagline">Launch and trade in PIPEDOG.</p>
        <div class="route">Protocol lane: 25% to 0xdead</div>
      </section>
      <img class="dog" src="${dog}" alt="" />
      <img class="machine" src="${machine}" alt="" />
      <div class="burn">Fees to the furnace</div>
    </main>
  </body>
</html>`;

const iconHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${sharedStyles}
      body {
        position: relative;
        background:
          radial-gradient(circle at 72% 20%, #ffd24d, transparent 34%),
          #fff4bb;
      }
      .frame {
        position: absolute;
        inset: 18px;
        overflow: hidden;
        border: 18px solid #172016;
        border-radius: 104px;
        background: linear-gradient(180deg, #fff9dc 0 72%, #c7ec82 72%);
      }
      .dog {
        position: absolute;
        z-index: 1;
        top: 58px;
        left: 78px;
        width: 320px;
        height: auto;
        filter: drop-shadow(0 12px 10px rgba(34, 42, 26, 0.2));
      }
      .pipe-body {
        position: absolute;
        z-index: 2;
        right: 80px;
        bottom: -80px;
        left: 80px;
        height: 236px;
        border: 14px solid #172016;
        background: linear-gradient(90deg, #1f9e2a, #48d448 40%, #159722);
      }
      .pipe-rim {
        position: absolute;
        z-index: 3;
        right: 54px;
        bottom: 132px;
        left: 54px;
        height: 96px;
        border: 14px solid #172016;
        border-radius: 50%;
        background: transparent;
        box-shadow:
          inset 0 0 0 13px #32c93b,
          inset 0 11px 0 #6aec60;
      }
      .pipe-hole {
        position: absolute;
        z-index: 0;
        right: 84px;
        bottom: 154px;
        left: 84px;
        height: 54px;
        border: 9px solid #172016;
        border-radius: 50%;
        background: #073f1c;
      }
    </style>
  </head>
  <body>
    <main class="frame">
      <div class="pipe-hole"></div>
      <img class="dog" src="${dog}" alt="" />
      <div class="pipe-body"></div>
      <div class="pipe-rim"></div>
    </main>
  </body>
</html>`;

await capture(browser, openGraphHtml, 1200, 630, path.join(publicDir, "og.png"), "laypipe-og");
await capture(browser, iconHtml, 512, 512, path.join(brandDir, "favicon.png"), "laypipe-icon");

console.log("Generated public/og.png (1200x630) and public/brand/favicon.png (512x512).");
