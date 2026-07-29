import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const contracts = [
  ["LaypipeFactory.sol", "LaypipeFactory"],
  ["PipedogHook.sol", "PipedogHook"],
  ["LaypipeSelfBurner.sol", "LaypipeSelfBurner"],
  ["LaypipeSwapRouter.sol", "LaypipeSwapRouter"],
  ["PipedogRevenueRouter.sol", "PipedogRevenueRouter"],
  ["LaypipeToken.sol", "LaypipeToken"],
];
const quarantined = ["LaypipeDividendDistributor"];

const output = join(ROOT, "abi");
await mkdir(output, { recursive: true });

for (const name of quarantined) {
  await rm(join(output, `${name}.json`), { force: true });
  console.log(`excluded quarantined abi/${name}.json`);
}

for (const [source, name] of contracts) {
  const artifactPath = join(ROOT, "out", source, `${name}.json`);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Missing ${artifactPath}. Run forge build before generating ABIs.`,
      { cause: error },
    );
  }
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`Artifact ${artifactPath} has no ABI array`);
  }
  await writeFile(
    join(output, `${name}.json`),
    `${JSON.stringify(artifact.abi, null, 2)}\n`,
  );
  console.log(`abi/${name}.json`);
}
