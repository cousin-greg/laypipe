import type { DbClient } from "../db/neon";
import { getDatabase } from "../db/neon";
import type { MarketApiError } from "../../market/live";
import {
  MarketInputError,
  getLiveToken,
  getMarketHealth,
  listLiveTokens,
  parseLiveTokenSlug,
  parseTokenListRequest,
} from "./read-model";
import { readMarketDataMode, type MarketDataMode } from "./mode";

export const MARKET_CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=20";
export const NO_STORE_CACHE_CONTROL = "no-store";

export interface MarketHttpDependencies {
  database?: () => Promise<DbClient>;
  marketMode?: () => MarketDataMode;
}

function json(body: unknown, status: number, cacheControl: string) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(
  code: MarketApiError["error"]["code"],
  message: string,
  status: number,
) {
  const body: MarketApiError = { error: { code, message } };
  return json(body, status, NO_STORE_CACHE_CONTROL);
}

function unavailableResponse() {
  return errorResponse(
    "market_data_unavailable",
    "Live market data is not available right now.",
    503,
  );
}

function disabledResponse() {
  return errorResponse(
    "market_data_unavailable",
    "Live market data is disabled for this deployment.",
    503,
  );
}

function liveApiGate(dependencies: MarketHttpDependencies) {
  try {
    return (dependencies.marketMode ?? readMarketDataMode)() === "live"
      ? null
      : disabledResponse();
  } catch {
    return unavailableResponse();
  }
}

export async function handleTokenListRequest(
  request: Request,
  dependencies: MarketHttpDependencies = {},
) {
  const gated = liveApiGate(dependencies);
  if (gated) return gated;

  let options;
  try {
    options = parseTokenListRequest(request.url);
  } catch (error) {
    if (error instanceof MarketInputError) {
      return errorResponse("invalid_request", error.message, 400);
    }
    return unavailableResponse();
  }

  try {
    const database = await (dependencies.database ?? getDatabase)();
    const payload = await listLiveTokens(database, options);
    return json(payload, 200, MARKET_CACHE_CONTROL);
  } catch {
    return unavailableResponse();
  }
}

export async function handleTokenDetailRequest(
  slug: string,
  dependencies: MarketHttpDependencies = {},
) {
  const gated = liveApiGate(dependencies);
  if (gated) return gated;

  let normalizedSlug: string;
  try {
    normalizedSlug = parseLiveTokenSlug(slug);
  } catch (error) {
    if (error instanceof MarketInputError) {
      return errorResponse("invalid_request", error.message, 400);
    }
    return unavailableResponse();
  }

  try {
    const database = await (dependencies.database ?? getDatabase)();
    const payload = await getLiveToken(database, normalizedSlug);
    if (!payload) {
      return errorResponse("not_found", "No indexed LayPipe token has that address.", 404);
    }
    return json(payload, 200, MARKET_CACHE_CONTROL);
  } catch (error) {
    if (error instanceof MarketInputError) {
      return errorResponse("invalid_request", error.message, 400);
    }
    return unavailableResponse();
  }
}

export async function handleMarketHealthRequest(
  dependencies: MarketHttpDependencies = {},
) {
  let mode: MarketDataMode;
  try {
    mode = (dependencies.marketMode ?? readMarketDataMode)();
  } catch {
    return json(
      {
        status: "misconfigured",
        check: "configuration",
        marketMode: null,
        readyForLiveMarkets: false,
        database: { status: "not_checked" },
        indexer: { status: "not_checked" },
      },
      503,
      NO_STORE_CACHE_CONTROL,
    );
  }

  if (mode === "fixture") {
    return json(
      {
        status: "alive",
        check: "liveness",
        marketMode: "fixture",
        readyForLiveMarkets: false,
        database: { status: "not_checked", reason: "Fixture mode does not use Neon." },
        indexer: { status: "not_checked", reason: "Fixture mode does not require an indexer." },
      },
      200,
      NO_STORE_CACHE_CONTROL,
    );
  }

  try {
    const database = await (dependencies.database ?? getDatabase)();
    const indexer = await getMarketHealth(database);
    if (!indexer) {
      return json(
        {
          status: "not_ready",
          check: "readiness",
          marketMode: "live",
          readyForLiveMarkets: false,
          database: { status: "reachable" },
          indexer: { status: "missing", cursor: null },
        },
        503,
        NO_STORE_CACHE_CONTROL,
      );
    }
    return json(
      {
        status: "ready",
        check: "readiness",
        marketMode: "live",
        readyForLiveMarkets: true,
        database: { status: "reachable" },
        indexer: {
          status: "ready",
          freshness: "not_assessed",
          cursor: indexer,
        },
      },
      200,
      NO_STORE_CACHE_CONTROL,
    );
  } catch {
    return json(
      {
        status: "unavailable",
        check: "readiness",
        marketMode: "live",
        readyForLiveMarkets: false,
        database: { status: "unavailable" },
        indexer: { status: "not_checked" },
      },
      503,
      NO_STORE_CACHE_CONTROL,
    );
  }
}
