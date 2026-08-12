import { handleMarketHealthRequest } from "@/lib/server/market/http";
import { observeOperationalRequest } from "@/lib/server/observability";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return observeOperationalRequest(request, "/api/ready", () =>
    handleMarketHealthRequest({}, { requireLive: true }),
  );
}
