import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const REFERENCE = join(ROOT, "reference", "letscash", "src", "v4");
// Never write generated baselines into deployable src/. Those files contain
// reviewed compatibility and security changes beyond mechanical renaming.
// This script is evidence tooling: it produces a clean comparison baseline.
const OUTPUT = join(
  ROOT,
  "reference",
  "letscash",
  "adapted-baseline",
);

const files = [
  {
    input: "CashCatHook.sol",
    output: "PipedogHook.sol",
    replacements: [
      [/\bCashCatHook\b/g, "PipedogHook"],
      [/cashcat/gi, (match) =>
        match === "CASHCAT"
          ? "PIPEDOG"
          : match[0] === "C"
            ? "Pipedog"
            : "pipedog"],
    ],
  },
  {
    input: "CashCatToken.sol",
    output: "LaypipeToken.sol",
    replacements: [
      [/\bCashCatToken\b/g, "LaypipeToken"],
      [/\bICashCatFeeView\b/g, "ILaypipeFeeView"],
      [/\bICashCatCheckpoints\b/g, "ILaypipeCheckpoints"],
      [/\bCashCatHook\b/g, "PipedogHook"],
      [/\.\/CashCatHook\.sol/g, "./PipedogHook.sol"],
      [/cashcat/gi, (match) =>
        match === "CASHCAT"
          ? "PIPEDOG"
          : match[0] === "C"
            ? "Pipedog"
            : "pipedog"],
    ],
  },
  {
    input: "CashCatSelfBurner.sol",
    output: "LaypipeSelfBurner.sol",
    replacements: [
      [/\bCashCatSelfBurner\b/g, "LaypipeSelfBurner"],
      [/\bCashCatToken\b/g, "LaypipeToken"],
      [/\bCashCatHook\b/g, "PipedogHook"],
      [/\.\/CashCatToken\.sol/g, "./LaypipeToken.sol"],
      [/\.\/CashCatHook\.sol/g, "./PipedogHook.sol"],
      [/cashcat/gi, (match) =>
        match === "CASHCAT"
          ? "PIPEDOG"
          : match[0] === "C"
            ? "Pipedog"
            : "pipedog"],
    ],
  },
  {
    input: "CashCatBuybackBurner.sol",
    output: "PipedogBuybackBurner.sol",
    replacements: [
      [/\bCashCatBuybackBurner\b/g, "PipedogBuybackBurner"],
      [/cashcat/gi, (match) =>
        match === "CASHCAT"
          ? "PIPEDOG"
          : match[0] === "C"
            ? "Pipedog"
            : "pipedog"],
    ],
  },
  {
    input: "CashCatDividendDistributor.sol",
    output: "LaypipeDividendDistributor.sol",
    replacements: [
      [/\bCashCatDividendDistributor\b/g, "LaypipeDividendDistributor"],
      [/\bCashCatHook\b/g, "PipedogHook"],
      [/\bICashCatCheckpointToken\b/g, "ILaypipeCheckpointToken"],
      [/\.\/CashCatHook\.sol/g, "./PipedogHook.sol"],
      [/cashcat/gi, (match) =>
        match === "CASHCAT"
          ? "PIPEDOG"
          : match[0] === "C"
            ? "Pipedog"
            : "pipedog"],
    ],
  },
  {
    input: join("lib", "CurrencySettler.sol"),
    output: join("lib", "CurrencySettler.sol"),
    replacements: [],
  },
];

for (const file of files) {
  let source = await readFile(join(REFERENCE, file.input), "utf8");
  for (const [pattern, replacement] of file.replacements) {
    source = source.replace(pattern, replacement);
  }
  const outputPath = join(OUTPUT, file.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, source);
  console.log(`${file.input} -> ${file.output}`);
}

console.log(
  "Baseline only: deployable src/ was not modified. Run node scripts/check-source-fidelity.mjs to verify reviewed deltas.",
);
