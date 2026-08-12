import type { WalletApiError } from "../../wallet/live";
import {
  getRequestIp,
  HttpError,
  readJsonObject,
  sameOriginRequest,
} from "../auth/http";
import { enforceRateLimit } from "../auth/redis";
import type { DbClient } from "../db/neon";
import { getReadDatabase } from "../db/neon";
import { readMarketDataMode, type MarketDataMode } from "../market/mode";
import { MarketInputError, readMarketCursorSecret } from "../market/read-model";
import {
  loadWalletPortfolio,
  parseWalletPortfolioRequest,
  type WalletReadDependencies,
} from "./read-model";

const NO_STORE = "private, no-store, max-age=0";

export interface WalletHttpDependencies extends WalletReadDependencies {
  database?: () => Promise<DbClient>;
  marketMode?: () => MarketDataMode;
  cursorSecret?: () => string;
  requestIp?: (request: Request) => string;
  rateLimit?: typeof enforceRateLimit;
}

function response(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": NO_STORE, "Content-Type": "application/json; charset=utf-8" },
  });
}

function error(
  code: WalletApiError["error"]["code"],
  message: string,
  status: number,
) {
  return response({ error: { code, message } } satisfies WalletApiError, status);
}

export async function handleWalletPortfolioRequest(
  request: Request,
  dependencies: WalletHttpDependencies = {},
) {
  if (request.method !== "POST") {
    return error("invalid_request", "Use POST for wallet portfolio requests.", 405);
  }
  try {
    if ((dependencies.marketMode ?? readMarketDataMode)() !== "live") {
      return error("wallet_data_unavailable", "Live wallet data is disabled for this deployment.", 503);
    }
  } catch {
    return error("wallet_data_unavailable", "Live wallet data is unavailable right now.", 503);
  }
  let parsed;
  let secret: string;
  let ip: string;
  try {
    if (!request.headers.get("origin")) {
      throw new HttpError(
        403,
        "ORIGIN",
        "Wallet portfolio requests require a same-origin browser request.",
      );
    }
    sameOriginRequest(request);
    ip = (dependencies.requestIp ?? getRequestIp)(request);
    await (dependencies.rateLimit ?? enforceRateLimit)({
      namespace: "wallet-portfolio-ip",
      identity: ip,
      limit: 90,
      windowSeconds: 60,
      signal: request.signal,
    });
    secret = (dependencies.cursorSecret ?? readMarketCursorSecret)();
    parsed = parseWalletPortfolioRequest(await readJsonObject(request, 4_096), secret);
    await (dependencies.rateLimit ?? enforceRateLimit)({
      namespace: "wallet-portfolio-ip-wallet",
      identity: `${ip}\0${parsed.wallet}`,
      limit: 30,
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
    return error("wallet_data_unavailable", "Live wallet data is unavailable right now.", 503);
  }
  try {
    const database = await (dependencies.database ?? getReadDatabase)();
    const payload = await loadWalletPortfolio(database, parsed, secret, dependencies);
    return response(payload, 200);
  } catch {
    return error("wallet_data_unavailable", "Live wallet data is unavailable right now.", 503);
  }
}
