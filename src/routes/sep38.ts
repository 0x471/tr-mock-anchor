/**
 * SEP-38 quotes: indicative prices (public) and firm quotes (SEP-10 auth) for TRY <-> USDC.
 * Fee is expressed in the sell asset so that  sell_amount - fee.total == price * buy_amount
 * and total_price == sell_amount / buy_amount, as the SEP-38 price formulas require.
 */
import { Hono, type Context } from "hono";
import type { Deps } from "../context.js";
import { createSepQuote, readSepQuote } from "../sep-quotes.js";
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
} from "../money.js";
import { TRY_ASSET, usdcAsset } from "../core/sep.js";
import {
  sepError,
  sepJwtAuth,
  type SepContext,
  type SepEnv,
} from "../sepauth.js";

const DELIVERY = [
  {
    name: "bank_account",
    description: "Turkish bank transfer (FAST / EFT / Havale)",
  },
];

export function sep38Routes(deps: Deps, sep: SepContext) {
  const { cfg, rates, stellar } = deps;
  const USDC = usdcAsset(stellar.assetCode, stellar.assetIssuer);
  const app = new Hono<SepEnv>();

  const decStr = (n: number, d: number) => n.toFixed(d);

  /**
   * Price a conversion. `sell`/`buy` are SEP-38 asset ids; exactly one amount is given.
   * Returns strings ready for the response; all identities hold at 2/7 decimals.
   */
  async function price(
    sell: string,
    buy: string,
    sellAmount?: string,
    buyAmount?: string
  ) {
    if (!(
      (sell === TRY_ASSET && buy === USDC) ||
      (sell === USDC && buy === TRY_ASSET)
    ))
      return null;
    const side = sell === TRY_ASSET ? "buy" : "sell"; // customer buys USDC with TRY, or sells USDC for TRY
    const { rateMicro, mid } = await rates.quote(side);
    const midMicro = mid.midMicro;
    let sellStr: string,
      buyStr: string,
      feeStr: string,
      priceStr: string,
      totalStr: string;
    if (side === "buy") {
      // sell TRY, buy USDC. price = TRY per USDC at mid; total_price = applied rate
      let kurus: bigint, stroops: bigint;
      if (sellAmount !== undefined) {
        kurus = parseTry(sellAmount, "sell_amount");
        stroops = tryToUsdc(kurus, rateMicro);
      } else {
        stroops = parseUsdc(buyAmount!, "buy_amount");
        kurus = usdcToTryCeil(stroops, rateMicro);
      }
      const atMid = usdcToTry(stroops, midMicro);
      const fee = kurus > atMid ? kurus - atMid : 0n;
      sellStr = fmtTry(kurus);
      buyStr = fmtUsdc(stroops);
      feeStr = fmtTry(fee);
      priceStr = fmtRate(midMicro);
      totalStr =
        stroops > 0n
          ? decStr(Number(sellStr) / Number(buyStr), 7)
          : fmtRate(rateMicro);
    } else {
      // sell USDC, buy TRY. price = USDC per TRY at mid; total_price = 1 / applied rate
      let stroops: bigint, kurus: bigint;
      if (sellAmount !== undefined) {
        stroops = parseUsdc(sellAmount, "sell_amount");
        kurus = usdcToTry(stroops, rateMicro);
      } else {
        kurus = parseTry(buyAmount!, "buy_amount");
        stroops = tryToUsdcCeil(kurus, rateMicro);
      }
      const atMid = tryToUsdc(kurus, midMicro); // USDC that `kurus` TRY is worth at mid
      const fee = stroops > atMid ? stroops - atMid : 0n;
      sellStr = fmtUsdc(stroops);
      buyStr = fmtTry(kurus);
      feeStr = fmtUsdc(fee);
      priceStr = decStr(1 / Number(fmtRate(midMicro)), 10);
      totalStr =
        kurus > 0n
          ? decStr(Number(sellStr) / Number(buyStr), 10)
          : decStr(1 / Number(fmtRate(rateMicro)), 10);
    }
    return {
      side,
      rateMicro,
      midMicro,
      sell_asset: sell,
      buy_asset: buy,
      sell_amount: sellStr,
      buy_amount: buyStr,
      price: priceStr,
      total_price: totalStr,
      fee: {
        total: feeStr,
        asset: sell,
        details: [
          {
            name: "spread",
            description: `${cfg.spreadBps} bps from the USD/TRY mid rate`,
            amount: feeStr,
          },
        ],
      },
      rate_source: mid.source,
    };
  }

  app.get("/sep38/info", (c) =>
    c.json({
      assets: [
        { asset: USDC },
        {
          asset: TRY_ASSET,
          country_codes: ["TUR"],
          sell_delivery_methods: DELIVERY,
          buy_delivery_methods: DELIVERY,
        },
      ],
    })
  );

  app.get("/sep38/prices", async (c) => {
    const sell = c.req.query("sell_asset");
    const sellAmount = c.req.query("sell_amount");
    if (!sell || !sellAmount)
      return sepError(c, 400, "'sell_asset' and 'sell_amount' are required");
    const buy = sell === TRY_ASSET ? USDC : sell === USDC ? TRY_ASSET : null;
    if (!buy)
      return sepError(
        c,
        400,
        `unsupported sell_asset; use ${TRY_ASSET} or ${USDC}`
      );
    const p = await price(sell, buy, sellAmount);
    if (!p) return sepError(c, 400, "unsupported asset pair");
    return c.json({
      buy_assets: [
        {
          asset: buy,
          price: p.total_price,
          decimals: buy === TRY_ASSET ? 2 : 7,
        },
      ],
    });
  });

  async function priceFromQuery(c: Context<SepEnv>) {
    const sell = c.req.query("sell_asset") ?? "";
    const buy = c.req.query("buy_asset") ?? "";
    const sellAmount = c.req.query("sell_amount");
    const buyAmount = c.req.query("buy_amount");
    if (!sell || !buy)
      return { error: "'sell_asset' and 'buy_asset' are required" };
    if ((sellAmount === undefined) === (buyAmount === undefined))
      return { error: "provide exactly one of 'sell_amount' or 'buy_amount'" };
    const p = await price(sell, buy, sellAmount, buyAmount);
    if (!p)
      return {
        error: `unsupported asset pair; supported: ${TRY_ASSET} <-> ${USDC}`,
      };
    return { p };
  }

  app.get("/sep38/price", async (c) => {
    const r = await priceFromQuery(c);
    if ("error" in r) return sepError(c, 400, r.error!);
    const { p } = r;
    return c.json({
      total_price: p.total_price,
      price: p.price,
      sell_amount: p.sell_amount,
      buy_amount: p.buy_amount,
      fee: p.fee,
    });
  });

  app.use("/sep38/quote", sepJwtAuth(deps, sep));
  app.use("/sep38/quote/*", sepJwtAuth(deps, sep));

  app.post("/sep38/quote", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return sepError(c, 400, "request body must be JSON");
    }
    const str = (k: string) =>
      typeof body[k] === "string"
        ? (body[k] as string)
        : typeof body[k] === "number"
          ? String(body[k])
          : undefined;
    const sell = str("sell_asset") ?? "";
    const buy = str("buy_asset") ?? "";
    const sellAmount = str("sell_amount");
    const buyAmount = str("buy_amount");
    if (!sell || !buy)
      return sepError(c, 400, "'sell_asset' and 'buy_asset' are required");
    if ((sellAmount === undefined) === (buyAmount === undefined))
      return sepError(
        c,
        400,
        "provide exactly one of 'sell_amount' or 'buy_amount'"
      );
    const context = str("context") ?? "sep6";
    if (context !== "sep6" && context !== "sep24")
      return sepError(c, 400, "context must be sep6 or sep24");
    const quote = await createSepQuote(deps, c.get("sepCustomer").id, {
      sell_asset: sell,
      buy_asset: buy,
      sell_amount: sellAmount,
      buy_amount: buyAmount,
      context,
      expire_after: str("expire_after"),
    });
    return c.json(quote, 201);
  });

  app.get("/sep38/quote/:id", (c) =>
    c.json(readSepQuote(deps, c.get("sepCustomer").id, c.req.param("id")))
  );

  return app;
}
