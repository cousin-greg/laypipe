import { getReadDatabase } from "../../lib/server/db/neon";
import {
  readReconciliationConfig,
  ReconciliationGateError,
  runReadOnlyReconciliation,
} from "../../lib/server/indexer/reconciliation";
import { createHttpIndexerRpc } from "../../lib/server/indexer/rpc";
import {
  assertAuditedIndexerDeployment,
  parseRobinhoodProductionManifest,
  type PublicDeploymentEnvironment,
} from "../../lib/web3/deployment-manifest";

async function main() {
  const config = readReconciliationConfig();
  const manifest = parseRobinhoodProductionManifest(
    process.env as PublicDeploymentEnvironment,
  );
  const database = await getReadDatabase();
  const rpc = createHttpIndexerRpc({
    url: process.env.ROBINHOOD_RPC_HTTP_URL,
    deadlineAt: Date.now() + config.timeoutMs,
  });
  const report = await runReadOnlyReconciliation({
    database,
    rpc,
    manifest,
    pinnedBlock: config.pinnedBlock,
    finalityBlocks: config.finalityBlocks,
    maxPools: config.maxPools,
    rpcConcurrency: config.rpcConcurrency,
    verifyManifestSnapshot: assertAuditedIndexerDeployment,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const safe =
    error instanceof ReconciliationGateError
      ? { ok: false, code: error.code, message: error.message }
      : {
          ok: false,
          code: "RECONCILIATION_FAILED",
          message: "Read-only reconciliation failed.",
        };
  process.stderr.write(`${JSON.stringify(safe)}\n`);
  process.exitCode = 1;
}
