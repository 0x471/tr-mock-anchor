import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { nowIso, tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { notFound, unprocessable } from '../errors.js';
import { parseUsdc } from '../money.js';
import { getCustomer } from '../core/ledger.js';
import { createOfframp, resolveRate } from '../core/orders.js';
import { offrampOut } from '../core/serialize.js';
import type { OfframpRow, QuoteRow } from '../core/types.js';
import { loadUsableQuote } from './quotes.js';

const CreateOfframp = z.object({
  customer_id: z.string(),
  amount_usdc: z.union([z.string(), z.number()]).optional(),
  quote_id: z.string().optional(),
  auto_payout: z.boolean().optional(),
  payout_iban: z.string().trim().optional(),
});

export function offrampRoutes(deps: Deps) {
  const { db, stellar } = deps;
  const app = new Hono<AppEnv>();
  const out = (o: OfframpRow) => offrampOut(o, stellar.assetCode, stellar.assetIssuer);

  app.post('/v1/offramps', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateOfframp);
    const customer = getCustomer(db, partner.id, body.customer_id);
    if (!customer) throw notFound('customer');

    let expected: bigint | null = null;
    let quote: QuoteRow | null = null;
    if (body.quote_id) {
      quote = loadUsableQuote(deps, partner.id, body.quote_id, 'sell', customer.id);
      expected = parseUsdc(quote.source_amount);
    } else if (body.amount_usdc !== undefined) {
      expected = parseUsdc(body.amount_usdc);
    }
    const rate = await resolveRate(deps, 'sell', quote);
    const row = tx(db, () => createOfframp(deps, customer, { expected, rate, autoPayout: body.auto_payout ?? true, payoutIban: body.payout_iban ?? null }));
    return c.json(out(row), 201);
  });

  app.get('/v1/offramps', (c) => {
    const partner = c.get('partner');
    const { limit, offset } = pageParams(c);
    const customerId = c.req.query('customer_id');
    const status = c.req.query('status');
    const rows = db
      .prepare(
        `SELECT * FROM offramps WHERE partner_id = ? AND (? IS NULL OR customer_id = ?) AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(partner.id, customerId ?? null, customerId ?? null, status ?? null, status ?? null, limit, offset) as unknown as OfframpRow[];
    return c.json({ data: rows.map(out), limit, offset });
  });

  app.get('/v1/offramps/:id', (c) => {
    const row = db.prepare('SELECT * FROM offramps WHERE id = ? AND partner_id = ?').get(c.req.param('id'), c.get('partner').id) as OfframpRow | undefined;
    if (!row) throw notFound('offramp');
    return c.json(out(row));
  });

  app.post('/v1/offramps/:id/cancel', (c) => {
    const row = db.prepare('SELECT * FROM offramps WHERE id = ? AND partner_id = ?').get(c.req.param('id'), c.get('partner').id) as OfframpRow | undefined;
    if (!row) throw notFound('offramp');
    if (row.status !== 'awaiting_deposit') throw unprocessable('not_cancellable', `Off-ramp is ${row.status}`);
    const ts = nowIso();
    db.prepare("UPDATE offramps SET status = 'cancelled', updated_at = ? WHERE id = ?").run(ts, row.id);
    return c.json(out({ ...row, status: 'cancelled', updated_at: ts }));
  });

  return app;
}
