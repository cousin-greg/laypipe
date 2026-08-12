import type { KeeperApiError } from "../../keeper/live";
import { getRequestIp, HttpError, readJsonObject, sameOriginRequest } from "../auth/http";
import { enforceRateLimit } from "../auth/redis";
import { getReadDatabase, type DbClient } from "../db/neon";
import { readMarketDataMode, type MarketDataMode } from "../market/mode";
import { MarketInputError } from "../market/read-model";
import { loadKeeperRewards, parseKeeperRewardsRequest } from "./read-model";

const NO_STORE = "private, no-store, max-age=0";

export interface KeeperHttpDependencies {
  database?: () => Promise<DbClient>;
  marketMode?: () => MarketDataMode;
  requestIp?: (request: Request) => string;
  rateLimit?: typeof enforceRateLimit;
  now?: () => number;
}

function response(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function error(
  code: KeeperApiError["error"]["code"],
  message: string,
  status: number,
) {
  return response({ error: { code, message } } satisfies KeeperApiError, status);
}

export async function handleKeeperRewardsRequest(
  request: Request,
  dependencies: KeeperHttpDependencies = {},
) {
  if (request.method !== "POST") {
    return error("invalid_request", "Use POST for keeper reward requests.", 405);
  }
  try {
    if ((dependencies.marketMode ?? readMarketDataMode)() !== "live") {
      return error(
        "keeper_data_unavailable",
        "Live keeper data is disabled for this deployment.",
        503,
      );
    }
  } catch {
    return error("keeper_data_unavailable", "Live keeper data is unavailable right now.", 503);
  }

  let parsed: ReturnType<typeof parseKeeperRewardsRequest>;
  try {
    if (!request.headers.get("origin")) {
      throw new HttpError(
        403,
        "ORIGIN",
        "Keeper reward requests require a same-origin browser request.",
      );
    }
    sameOriginRequest(request);
    const ip = (dependencies.requestIp ?? getRequestIp)(request);
    await (dependencies.rateLimit ?? enforceRateLimit)({
      namespace: "keeper-rewards-ip",
      identity: ip,
      limit: 60,
      windowSeconds: 60,
      signal: request.signal,
    });
    parsed = parseKeeperRewardsRequest(await readJsonObject(request, 1_024));
    await (dependencies.rateLimit ?? enforceRateLimit)({
      namespace: "keeper-rewards-ip-wallet",
      identity: `${ip}\0${parsed.wallet}`,
      limit: 20,
      windowSeconds: 60,
      signal: request.signal,
    });
  } catch (cause) {
    if (cause instanceof MarketInputError) {
      return error("invalid_request", cause.message, 400);
    }
    if (cause instanceof HttpError) {
      if (cause.status === 429) {
        return error("rate_limited", "Too many requests. Try again later.", 429);
      }
      if (cause.status < 500) {
        return error("invalid_request", cause.message, cause.status);
      }
    }
    return error("keeper_data_unavailable", "Live keeper data is unavailable right now.", 503);
  }

  try {
    const database = await (dependencies.database ?? getReadDatabase)();
    return response(
      await loadKeeperRewards(database, parsed, { now: dependencies.now }),
      200,
    );
  } catch {
    return error("keeper_data_unavailable", "Live keeper data is unavailable right now.", 503);
  }
}
