import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const contracts = [
  ["LaypipeFactory.sol", "LaypipeFactory"],
  ["PipedogHook.sol", "PipedogHook"],
  ["LaypipeSelfBurner.sol", "LaypipeSelfBurner"],
  ["LaypipeDividendDistributor.sol", "LaypipeDividendDistributor"],
  ["PipedogRevenueRouter.sol", "PipedogRevenueRouter"],
  ["LaypipeToken.sol", "LaypipeToken"],
];

const output = join(ROOT, "abi");
await mkdir(output, { recursive: true });

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
