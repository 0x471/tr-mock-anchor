import type { Deps } from "./context.js";
import type { CustomerRow, QuoteRow } from "./core/types.js";
import { TRY_ASSET, usdcAsset } from "./core/sep.js";
import { nowIso, tx } from "./db.js";
import { ApiError } from "./errors.js";
import { newId } from "./ids.js";
import {
  fmtRate,
  fmtTry,
  fmtUsdc,
  parseRate,
  parseTry,
  parseUsdc,
  tryToUsdc,
  tryToUsdcCeil,
  usdcToTry,
  usdcToTryCeil,
} from "./money.js";

export interface SepQuoteRequest {
  sell_asset: string;
  buy_asset: string;
  sell_amount?: string;
  buy_amount?: string;
  context: "sep6" | "sep24";
  expire_after?: string;
}

export function readSepQuote(deps: Deps, customerId: string, id: string) {
  const q = deps.db
    .prepare(
      "SELECT q.*, a.sell_asset, a.buy_asset FROM quotes q JOIN quote_assets a ON a.quote_id = q.id WHERE q.id = ? AND q.customer_id = ?"
    )
    .get(id, customerId) as unknown as
    (QuoteRow & { sell_asset: string; buy_asset: string }) | undefined;
  if (!q) throw new ApiError(404, "quote_not_found", "Quote not found.");
  const sellTry = q.sell_asset === TRY_ASSET;
  const mid = parseRate(q.mid_rate);
  const sold = sellTry ? parseTry(q.source_amount) : parseUsdc(q.source_amount);
  const atMid = sellTry
    ? usdcToTry(parseUsdc(q.destination_amount), mid)
    : tryToUsdc(parseTry(q.destination_amount), mid);
  const fee = (sellTry ? fmtTry : fmtUsdc)(sold > atMid ? sold - atMid : 0n);
  return {
    id: q.id,
    expires_at: q.expires_at,
    total_price: (
      Number(q.source_amount) / Number(q.destination_amount)
    ).toFixed(sellTry ? 7 : 10),
    price: sellTry ? fmtRate(mid) : (1 / Number(fmtRate(mid))).toFixed(10),
    sell_asset: q.sell_asset,
    sell_amount: q.source_amount,
    buy_asset: q.buy_asset,
    buy_amount: q.destination_amount,
    fee: {
      total: fee,
      asset: q.sell_asset,
      details: [
        {
          name: "spread",
          description: `${q.spread_bps} bps from the USD/TRY mid rate`,
          amount: fee,
        },
      ],
    },
  };
}

export async function createSepQuote(
  deps: Deps,
  customerId: string,
  request: SepQuoteRequest
) {
  const { db, cfg, stellar, rates } = deps;
  if (stellar.assetCode !== "USDC")
    throw new ApiError(
      503,
      "unsupported_asset",
      "This demo only quotes mock USDC."
    );
  const asset = usdcAsset(stellar.assetCode, stellar.assetIssuer);
  const sellTry =
    request.sell_asset === TRY_ASSET && request.buy_asset === asset;
  const sellToken =
    request.sell_asset === asset && request.buy_asset === TRY_ASSET;
  if (!sellTry && !sellToken)
    throw new ApiError(400, "unsupported_pair", "Unsupported asset pair.");
  if (
    (request.sell_amount === undefined) ===
    (request.buy_amount === undefined)
  )
    throw new ApiError(400, "invalid_amount", "Provide exactly one amount.");
  if (!["sep6", "sep24"].includes(request.context))
    throw new ApiError(
      400,
      "invalid_context",
      "Use sep6 or sep24 quote context."
    );
  const customer = db
    .prepare("SELECT * FROM customers WHERE id = ?")
    .get(customerId) as unknown as CustomerRow | undefined;
  if (!customer)
    throw new ApiError(404, "customer_not_found", "Customer not found.");
  let ttl = 900;
  if (request.expire_after !== undefined) {
    const wanted = Math.floor(
      (Date.parse(request.expire_after) - Date.now()) / 1000
    );
    if (!Number.isSafeInteger(wanted) || wanted <= 0)
      throw new ApiError(
        400,
        "invalid_expiry",
        "expire_after must be a future ISO timestamp."
      );
    ttl = Math.min(3600, Math.max(60, wanted));
  }
  const side = sellTry ? "buy" : "sell";
  const { rateMicro, mid } = await rates.quote(side);
  let sold: bigint;
  let bought: bigint;
  if (sellTry) {
    if (request.sell_amount !== undefined) {
      sold = parseTry(request.sell_amount, "sell_amount");
      bought = tryToUsdc(sold, rateMicro);
    } else {
      bought = parseUsdc(request.buy_amount!, "buy_amount");
      sold = usdcToTryCeil(bought, rateMicro);
    }
  } else if (request.sell_amount !== undefined) {
    sold = parseUsdc(request.sell_amount, "sell_amount");
    bought = usdcToTry(sold, rateMicro);
  } else {
    bought = parseTry(request.buy_amount!, "buy_amount");
    sold = tryToUsdcCeil(bought, rateMicro);
  }
  if (sold <= 0n || bought <= 0n)
    throw new ApiError(
      400,
      "invalid_amount",
      "Both quoted amounts must be positive."
    );
  const q: QuoteRow = {
    id: newId("qt"),
    partner_id: customer.partner_id,
    customer_id: customer.id,
    side,
    rate: fmtRate(rateMicro),
    mid_rate: fmtRate(mid.midMicro),
    spread_bps: cfg.spreadBps,
    rate_source: mid.source,
    source_currency: sellTry ? "TRY" : "USDC",
    source_amount: (sellTry ? fmtTry : fmtUsdc)(sold),
    destination_currency: sellTry ? "USDC" : "TRY",
    destination_amount: (sellTry ? fmtUsdc : fmtTry)(bought),
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    consumed_by: null,
    created_at: nowIso(),
  };
  tx(db, () => {
    db.prepare(
      `INSERT INTO quotes(id,partner_id,customer_id,side,rate,mid_rate,spread_bps,rate_source,source_currency,source_amount,destination_currency,destination_amount,expires_at,consumed_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      q.id,
      q.partner_id,
      q.customer_id,
      q.side,
      q.rate,
      q.mid_rate,
      q.spread_bps,
      q.rate_source,
      q.source_currency,
      q.source_amount,
      q.destination_currency,
      q.destination_amount,
      q.expires_at,
      null,
      q.created_at
    );
    db.prepare(
      "INSERT INTO quote_assets(quote_id,sell_asset,buy_asset) VALUES (?,?,?)"
    ).run(q.id, request.sell_asset, request.buy_asset);
  });
  return readSepQuote(deps, customerId, q.id);
}
