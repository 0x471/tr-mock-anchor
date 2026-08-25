import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newId } from '../ids.js';
import { nowIso, plusSeconds } from '../db.js';
import { parseBody } from '../validate.js';
import { notFound, unprocessable } from '../errors.js';
import { fmtRate, fmtTry, fmtUsdc, parseTry, parseUsdc, tryToUsdc, tryToUsdcCeil, usdcToTry, usdcToTryCeil } from '../money.js';
import { getCustomer } from '../core/ledger.js';
import { quoteOut } from '../core/serialize.js';
import type { QuoteRow } from '../core/types.js';

const CreateQuote = z.object({
  customer_id: z.string().optional(),
  side: z.enum(['buy', 'sell']),
  amount: z.union([z.string(), z.number()]),
  amount_currency: z.enum(['TRY', 'USDC']),
});

export function quoteRoutes(deps: Deps) {
  const { db, cfg, rates } = deps;
  const app = new Hono<AppEnv>();

  app.get('/v1/rates', async (c) => {
    const [buy, sell] = await Promise.all([rates.quote('buy'), rates.quote('sell')]);
    return c.json({
      pair: 'USDC/TRY',
      note: 'USDC is priced 1:1 with USD; the mid rate is USD/TRY.',
      mid_rate: fmtRate(buy.mid.midMicro),
      buy_rate: fmtRate(buy.rateMicro),
      sell_rate: fmtRate(sell.rateMicro),
      spread_bps: buy.spreadBps,
      rate_source: buy.mid.source,
      oracle_timestamp: buy.mid.oracleTimestamp ?? null,
      fetched_at: new Date(buy.mid.fetchedAt).toISOString(),
    });
  });

  app.post('/v1/quotes', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateQuote);
    if (body.customer_id && !getCustomer(db, partner.id, body.customer_id)) throw notFound('customer');

    const { rateMicro, mid, spreadBps } = await rates.quote(body.side);
    let sourceCurrency: 'TRY' | 'USDC', destCurrency: 'TRY' | 'USDC', sourceAmount: string, destAmount: string;

    if (body.side === 'buy') {
      // TRY -> USDC
      sourceCurrency = 'TRY';
      destCurrency = 'USDC';
      if (body.amount_currency === 'TRY') {
        const k = parseTry(body.amount, 'amount');
        sourceAmount = fmtTry(k);
        destAmount = fmtUsdc(tryToUsdc(k, rateMicro));
      } else {
        const s = parseUsdc(body.amount, 'amount');
        destAmount = fmtUsdc(s);
        sourceAmount = fmtTry(usdcToTryCeil(s, rateMicro));
      }
    } else {
      // USDC -> TRY
      sourceCurrency = 'USDC';
      destCurrency = 'TRY';
      if (body.amount_currency === 'USDC') {
        const s = parseUsdc(body.amount, 'amount');
        sourceAmount = fmtUsdc(s);
        destAmount = fmtTry(usdcToTry(s, rateMicro));
      } else {
        const k = parseTry(body.amount, 'amount');
        destAmount = fmtTry(k);
        sourceAmount = fmtUsdc(tryToUsdcCeil(k, rateMicro));
      }
    }
    if (sourceAmount.replace(/[.0]/g, '') === '' || destAmount.replace(/[.0]/g, '') === '') {
      throw unprocessable('amount_too_small', 'Amount rounds to zero');
    }

    const row: QuoteRow = {
      id: newId('qt'),
      partner_id: partner.id,
      customer_id: body.customer_id ?? null,
      side: body.side,
      rate: fmtRate(rateMicro),
      mid_rate: fmtRate(mid.midMicro),
      spread_bps: spreadBps,
      rate_source: mid.source,
      source_currency: sourceCurrency,
      source_amount: sourceAmount,
      destination_currency: destCurrency,
      destination_amount: destAmount,
      expires_at: plusSeconds(cfg.quoteTtlSeconds),
      consumed_by: null,
      created_at: nowIso(),
    };
    db.prepare(
      `INSERT INTO quotes(id, partner_id, customer_id, side, rate, mid_rate, spread_bps, rate_source, source_currency, source_amount, destination_currency, destination_amount, expires_at, consumed_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id, row.partner_id, row.customer_id, row.side, row.rate, row.mid_rate, row.spread_bps, row.rate_source,
      row.source_currency, row.source_amount, row.destination_currency, row.destination_amount, row.expires_at, null, row.created_at,
    );
    return c.json(quoteOut(row), 201);
  });

  app.get('/v1/quotes/:id', (c) => {
    const row = db.prepare('SELECT * FROM quotes WHERE id = ? AND partner_id = ?').get(c.req.param('id'), c.get('partner').id) as QuoteRow | undefined;
    if (!row) throw notFound('quote');
    return c.json(quoteOut(row));
  });

  return app;
}

/** Shared by on/off-ramp creation: load a quote and check it is usable for `side`. */
export function loadUsableQuote(deps: Deps, partnerId: string, quoteId: string, side: 'buy' | 'sell', customerId: string): QuoteRow {
  const q = deps.db.prepare('SELECT * FROM quotes WHERE id = ? AND partner_id = ?').get(quoteId, partnerId) as QuoteRow | undefined;
  if (!q) throw notFound('quote');
  if (q.side !== side) throw unprocessable('quote_side_mismatch', `Quote ${q.id} is a ${q.side} quote; this endpoint needs ${side}`);
  if (q.consumed_by) throw unprocessable('quote_consumed', `Quote ${q.id} was already used by ${q.consumed_by}`);
  if (new Date(q.expires_at).getTime() < Date.now()) throw unprocessable('quote_expired', `Quote ${q.id} expired at ${q.expires_at}`);
  if (q.customer_id && q.customer_id !== customerId) throw unprocessable('quote_customer_mismatch', 'Quote belongs to a different customer');
  return q;
}
