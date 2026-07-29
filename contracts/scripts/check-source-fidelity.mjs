import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASELINE = join(
  ROOT,
  "reference",
  "letscash",
  "adapted-baseline",
);
const DELTAS = JSON.parse(
  await readFile(
    join(ROOT, "reference", "letscash", "adaptation-deltas.json"),
    "utf8",
  ),
);

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

const report = [];
let failed = false;
for (const entry of DELTAS.files) {
  const reviewedPath =
    entry.reviewedPath ?? join("src", entry.file);
  const [baseline, deployable] = await Promise.all([
    readFile(join(BASELINE, entry.file)),
    readFile(join(ROOT, reviewedPath)),
  ]);
  const identical = baseline.equals(deployable);
  if (identical !== entry.expectIdenticalToMechanicalBaseline) {
    failed = true;
  }
  if (
    !entry.expectIdenticalToMechanicalBaseline
    && entry.intentionalDeltas.length === 0
  ) {
    failed = true;
  }
  report.push({
    ...entry,
    actualIdenticalToMechanicalBaseline: identical,
    mechanicalBaselineSha256: hash(baseline),
    deployableSha256: hash(deployable),
  });
}

const output = {
  checkedAt: new Date().toISOString(),
  generatedBaseline:
    "node scripts/adapt-verified-sources.mjs",
  policy:
    "Exact adaptations must remain byte-identical to the mechanical baseline. Reviewed derivatives must remain different and declare every intentional delta category.",
  files: report,
};
console.log(JSON.stringify(output, null, 2));
if (failed) {
  throw new Error(
    "Source fidelity mismatch. Review the change and update adaptation-deltas.json only if the delta is intentional.",
  );
}
