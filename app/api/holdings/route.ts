import { handleWalletPortfolioRequest } from "@/lib/server/wallet/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleWalletPortfolioRequest(request);
}
