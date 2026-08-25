import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newId } from '../ids.js';
import { nowIso, tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { fmtRate, fmtTry, fmtUsdc, parseRate, parseTry, tryToUsdc } from '../money.js';
import { isStellarAddress } from '../stellar.js';
import { applyLedger, getCustomer } from '../core/ledger.js';
import { emitEvent } from '../core/events.js';
import { onrampOut } from '../core/serialize.js';
import type { OnrampRow } from '../core/types.js';
import { loadUsableQuote } from './quotes.js';

const CreateOnramp = z.object({
  customer_id: z.string(),
  destination_address: z.string().trim(),
  amount_try: z.union([z.string(), z.number()]).optional(),
  quote_id: z.string().optional(),
  memo: z.string().max(28).optional(),
});

export function onrampRoutes(deps: Deps) {
  const { db, cfg, rates } = deps;
  const app = new Hono<AppEnv>();

  app.post('/v1/onramps', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateOnramp);
    const customer = getCustomer(db, partner.id, body.customer_id);
    if (!customer) throw notFound('customer');
    if (customer.kyc_status !== 'approved') throw unprocessable('kyc_not_approved', `Customer KYC status is ${customer.kyc_status}`);
    if (!isStellarAddress(body.destination_address)) throw badRequest('invalid_destination_address', 'destination_address must be a Stellar G... or M... address');

    let kurus: bigint;
    let rateMicro: bigint;
    let quoteId: string | null = null;
    if (body.quote_id) {
      const q = loadUsableQuote(deps, partner.id, body.quote_id, 'buy', customer.id);
      kurus = parseTry(q.source_amount);
      rateMicro = parseRate(q.rate);
      quoteId = q.id;
    } else {
      if (body.amount_try === undefined) throw badRequest('validation_error', 'Provide amount_try or quote_id');
      kurus = parseTry(body.amount_try);
      rateMicro = (await rates.quote('buy')).rateMicro;
    }
    if (kurus < parseTry(cfg.minOnrampTry)) throw unprocessable('below_minimum', `Minimum on-ramp is ${cfg.minOnrampTry} TRY`);
    if (kurus > parseTry(cfg.maxOnrampTry)) throw unprocessable('above_maximum', `Maximum on-ramp is ${cfg.maxOnrampTry} TRY`);
    const stroops = tryToUsdc(kurus, rateMicro);
    if (stroops <= 0n) throw unprocessable('amount_too_small', 'Amount rounds to zero USDC');

    const ts = nowIso();
    const row: OnrampRow = {
      id: newId('onr'),
      partner_id: partner.id,
      customer_id: customer.id,
      quote_id: quoteId,
      amount_try: fmtTry(kurus),
      amount_usdc: fmtUsdc(stroops),
      rate: fmtRate(rateMicro),
      destination_address: body.destination_address,
      memo: body.memo ?? null,
      status: 'pending',
      pending_reason: null,
      settlement: null,
      tx_hash: null,
      claimable_balance_id: null,
      failure_reason: null,
      attempts: 0,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    };
    tx(db, () => {
      applyLedger(db, customer.id, 'TRY', -kurus, 'onramp', row.id);
      db.prepare(
        `INSERT INTO onramps(id, partner_id, customer_id, quote_id, amount_try, amount_usdc, rate, destination_address, memo, status, attempts, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      ).run(row.id, row.partner_id, row.customer_id, row.quote_id, row.amount_try, row.amount_usdc, row.rate, row.destination_address, row.memo, row.status, ts, ts);
      if (quoteId) db.prepare('UPDATE quotes SET consumed_by = ? WHERE id = ?').run(row.id, quoteId);
      emitEvent(db, partner.id, 'onramp.created', onrampOut(row));
    });
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
