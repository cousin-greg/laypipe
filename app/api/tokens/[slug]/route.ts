import { handleTokenDetailRequest } from "@/lib/server/market/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  return handleTokenDetailRequest(slug);
}
