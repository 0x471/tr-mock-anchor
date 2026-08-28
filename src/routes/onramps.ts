import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, notFound } from '../errors.js';
import { parseTry } from '../money.js';
import { isStellarAddress } from '../stellar.js';
import { getCustomer } from '../core/ledger.js';
import { createOnramp, resolveRate } from '../core/orders.js';
import { onrampOut } from '../core/serialize.js';
import type { OnrampRow, QuoteRow } from '../core/types.js';
import { loadUsableQuote } from './quotes.js';

const CreateOnramp = z.object({
  customer_id: z.string(),
  destination_address: z.string().trim(),
  amount_try: z.union([z.string(), z.number()]).optional(),
  quote_id: z.string().optional(),
  memo: z.string().max(28).optional(),
});

export function onrampRoutes(deps: Deps) {
  const { db } = deps;
  const app = new Hono<AppEnv>();

  app.post('/v1/onramps', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateOnramp);
    const customer = getCustomer(db, partner.id, body.customer_id);
    if (!customer) throw notFound('customer');
    if (!isStellarAddress(body.destination_address)) throw badRequest('invalid_destination_address', 'destination_address must be a Stellar G... or M... address');

    let kurus: bigint;
    let quote: QuoteRow | null = null;
    if (body.quote_id) {
      quote = loadUsableQuote(deps, partner.id, body.quote_id, 'buy', customer.id);
      kurus = parseTry(quote.source_amount);
    } else {
      if (body.amount_try === undefined) throw badRequest('validation_error', 'Provide amount_try or quote_id');
      kurus = parseTry(body.amount_try);
    }
    const rate = await resolveRate(deps, 'buy', quote);
    const row = tx(db, () => createOnramp(deps, customer, { kurus, rate, destination: body.destination_address, memo: body.memo ?? null }));
    return c.json(onrampOut(row), 201);
  });

  app.get('/v1/onramps', (c) => {
    const partner = c.get('partner');
    const { limit, offset } = pageParams(c);
    const customerId = c.req.query('customer_id');
    const status = c.req.query('status');
    const rows = db
      .prepare(
        `SELECT * FROM onramps WHERE partner_id = ? AND (? IS NULL OR customer_id = ?) AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(partner.id, customerId ?? null, customerId ?? null, status ?? null, status ?? null, limit, offset) as unknown as OnrampRow[];
    return c.json({ data: rows.map(onrampOut), limit, offset });
  });

  app.get('/v1/onramps/:id', (c) => {
    const row = db.prepare('SELECT * FROM onramps WHERE id = ? AND partner_id = ?').get(c.req.param('id'), c.get('partner').id) as OnrampRow | undefined;
    if (!row) throw notFound('onramp');
    return c.json(onrampOut(row));
  });

  return app;
}
