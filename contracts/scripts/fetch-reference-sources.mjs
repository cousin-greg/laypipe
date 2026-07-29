import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BLOCKSCOUT = "https://robinhoodchain.blockscout.com";
const LETSCASH_API = "https://api.letscash.fun";
const OUTPUT = fileURLToPath(new URL("../reference/letscash/", import.meta.url));

const references = [
  {
    role: "hook",
    address: "0xEfe669814e5Eec33406Bd50ffa8331618D076aEc",
    expectedName: "CashCatHook",
  },
  {
    role: "dividend-distributor",
    address: "0xCa8B8e3ffE1f48A3555059AacBb962BFB668f522",
    expectedName: "CashCatDividendDistributor",
  },
  {
    role: "self-burner-reference",
    address: "0x147420B86A5f9C9C955c7551e5D866607c6eD807",
    expectedName: "CashCatSelfBurner",
    note: "Verified earlier implementation. The currently configured burner is unverified and has different bytecode.",
  },
  {
    role: "token-reference",
    address: "0xb7d4470443689995E286bEaAf456d24762703F05",
    expectedName: "CashCatToken",
  },
];

const currentUnverified = [
  {
    role: "factory-implementation",
    address: "0xCaC351078C2CB6486E765108dF688ac89FD58024",
  },
  {
    role: "self-burner",
    address: "0x580C70D2234a579B2631593693c66caE3886A98E",
  },
  {
    role: "revenue-splitter",
    address: "0x6D3d822F6e625c59804F47cf2Cc1d53B8301016F",
  },
];

function sha256Hex(hex) {
  return createHash("sha256")
    .update(Buffer.from(hex.replace(/^0x/, ""), "hex"))
    .digest("hex");
}

function metadataCid(bytecode) {
  const hex = bytecode.replace(/^0x/, "");
  const marker = "697066735822";
  const offset = hex.lastIndexOf(marker);
  if (offset < 0) return null;

  const multihash = Buffer.from(
    hex.slice(offset + marker.length, offset + marker.length + 68),
    "hex",
  );
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${multihash.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of multihash) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

async function blockscout(address) {
  const response = await fetch(
    `${BLOCKSCOUT}/api/v2/smart-contracts/${address}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`Blockscout ${response.status} for ${address}`);
  }
  return response.json();
}

async function letscash(path) {
  const response = await fetch(`${LETSCASH_API}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`LetsCash API ${response.status} for ${path}`);
  }
  return response.json();
}

async function save(path, contents) {
  const outputPath = join(OUTPUT, path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents);
}

const manifest = {
  generatedAt: new Date().toISOString(),
  blockscout: BLOCKSCOUT,
  letscashApi: LETSCASH_API,
  references: [],
  currentUnverified: [],
};

for (const reference of references) {
  const contract = await blockscout(reference.address);
  if (
    !contract.is_verified ||
    !contract.source_code ||
    contract.name !== reference.expectedName
  ) {
    throw new Error(
      `Expected verified ${reference.expectedName} at ${reference.address}`,
    );
  }

  const sources = [
    {
      file_path: contract.file_path,
      source_code: contract.source_code,
    },
    ...(contract.additional_sources ?? []),
  ].filter((source) => source.file_path.startsWith("src/"));

  for (const source of sources) {
    await save(source.file_path, source.source_code);
  }
  await save(
    `abi/${reference.expectedName}.json`,
    `${JSON.stringify(contract.abi, null, 2)}\n`,
  );

  manifest.references.push({
    ...reference,
    blockscoutUrl: `${BLOCKSCOUT}/address/${reference.address}?tab=contract`,
    filePath: contract.file_path,
    compilerVersion: contract.compiler_version,
    evmVersion: contract.evm_version,
    optimizationEnabled: contract.optimization_enabled,
    optimizationRuns: contract.optimization_runs,
    verifiedAt: contract.verified_at,
    isFullyVerified: contract.is_fully_verified,
    deployedBytecodeSha256: sha256Hex(contract.deployed_bytecode),
    metadataCid: metadataCid(contract.deployed_bytecode),
    sources: sources.map((source) => source.file_path),
  });
}

for (const deployed of currentUnverified) {
  const contract = await blockscout(deployed.address);
  if (contract.is_verified || contract.source_code) {
    throw new Error(`${deployed.address} unexpectedly became verified`);
  }
  manifest.currentUnverified.push({
    ...deployed,
    blockscoutUrl: `${BLOCKSCOUT}/address/${deployed.address}?tab=contract`,
    deployedBytecodeSha256: sha256Hex(contract.deployed_bytecode),
    metadataCid: metadataCid(contract.deployed_bytecode),
    note: "No verified source or ABI was returned by Blockscout at acquisition time.",
  });
}

// These are first-party behavioral snapshots, not immutable protocol facts.
// Re-run this script immediately before a deployment review: addresses,
// enablement, balances, and counters can drift after generatedAt.
const [configSnapshot, tokenomicsSnapshot] = await Promise.all([
  letscash("/api/config"),
  letscash("/api/tokenomics?surface=current"),
]);
await save(
  "api/config.current.json",
  `${JSON.stringify(
    {
      fetchedAt: manifest.generatedAt,
      source: `${LETSCASH_API}/api/config`,
      driftWarning:
        "Current first-party API snapshot. Re-fetch before relying on addresses or enablement.",
      response: configSnapshot,
    },
    null,
    2,
  )}\n`,
);
await save(
  "api/tokenomics.current.json",
  `${JSON.stringify(
    {
      fetchedAt: manifest.generatedAt,
      source: `${LETSCASH_API}/api/tokenomics?surface=current`,
      driftWarning:
        "Current first-party API snapshot. Balances and counters are expected to drift.",
      behavioralTarget:
        "Platform revenue defaults: 25% token buy-to-sink, 25% token buy-to-treasury, 50% operations ETH.",
      response: tokenomicsSnapshot,
    },
    null,
    2,
  )}\n`,
);
manifest.apiSnapshots = [
  {
    role: "runtime-config",
    source: `${LETSCASH_API}/api/config`,
    file: "api/config.current.json",
    driftWarning:
      "Re-fetch immediately before relying on current addresses or launch enablement.",
  },
  {
    role: "tokenomics-policy",
    source: `${LETSCASH_API}/api/tokenomics?surface=current`,
    file: "api/tokenomics.current.json",
    driftWarning: "Balances and counters are expected to drift.",
  },
];

await save("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `Saved ${manifest.references.length} verified reference bundles, ${manifest.currentUnverified.length} unverified bytecode records, and ${manifest.apiSnapshots.length} first-party API snapshots.`,
);
