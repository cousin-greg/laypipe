import { handleMarketHealthRequest } from "@/lib/server/market/http";
import { readMarketDataMode } from "@/lib/server/market/mode";
import { observeOperationalRequest } from "@/lib/server/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let fixtureMode = false;
  try {
    fixtureMode = readMarketDataMode() === "fixture";
  } catch {
    // Let the health handler report invalid configuration as an actual failure.
  }
  return observeOperationalRequest(request, "/api/ready", () =>
    handleMarketHealthRequest({}, { requireLive: true }),
    { expectedFailureStatuses: fixtureMode ? [503] : [] },
  );
}
