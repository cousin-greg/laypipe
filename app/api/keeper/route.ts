import { handleKeeperRewardsRequest } from "@/lib/server/keeper/http";
import { observeOperationalRequest } from "@/lib/server/observability";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return observeOperationalRequest(request, "/api/keeper", () =>
    handleKeeperRewardsRequest(request),
  );
}
