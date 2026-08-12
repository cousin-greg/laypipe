import { handleMarketHealthRequest } from "@/lib/server/market/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleMarketHealthRequest();
}
