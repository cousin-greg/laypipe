import { handleTokenListRequest } from "@/lib/server/market/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleTokenListRequest(request);
}
