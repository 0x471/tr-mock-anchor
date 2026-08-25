import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newId, newMemoId } from '../ids.js';
import { nowIso, plusSeconds, tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { fmtRate, fmtUsdc, parseRate, parseUsdc } from '../money.js';
import { isValidTrIban, normalizeIban } from '../turkey.js';
import { getCustomer } from '../core/ledger.js';
import { emitEvent } from '../core/events.js';
import { offrampOut } from '../core/serialize.js';
import type { OfframpRow } from '../core/types.js';
import { loadUsableQuote } from './quotes.js';

const CreateOfframp = z.object({
  customer_id: z.string(),
  amount_usdc: z.union([z.string(), z.number()]).optional(),
  quote_id: z.string().optional(),
  auto_payout: z.boolean().optional(),
  payout_iban: z.string().trim().optional(),
});

export function offrampRoutes(deps: Deps) {
  const { db, cfg, rates, stellar } = deps;
  const app = new Hono<AppEnv>();
  const out = (o: OfframpRow) => offrampOut(o, stellar.assetCode, stellar.assetIssuer);

  app.post('/v1/offramps', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateOfframp);
    const customer = getCustomer(db, partner.id, body.customer_id);
    if (!customer) throw notFound('customer');
    if (customer.kyc_status !== 'approved') throw unprocessable('kyc_not_approved', `Customer KYC status is ${customer.kyc_status}`);

    let expected: bigint | null = null;
    let rateMicro: bigint;
    let quoteId: string | null = null;
    if (body.quote_id) {
      const q = loadUsableQuote(deps, partner.id, body.quote_id, 'sell', customer.id);
      expected = parseUsdc(q.source_amount);
      rateMicro = parseRate(q.rate);
      quoteId = q.id;
    } else {
      if (body.amount_usdc !== undefined) expected = parseUsdc(body.amount_usdc);
      rateMicro = (await rates.quote('sell')).rateMicro;
    }
    if (expected !== null && expected < parseUsdc(cfg.minOfframpUsdc)) {
      throw unprocessable('below_minimum', `Minimum off-ramp is ${cfg.minOfframpUsdc} USDC`);
    }

    const autoPayout = body.auto_payout ?? true;
    let payoutIban: string | null = body.payout_iban ? normalizeIban(body.payout_iban) : customer.iban;
    if (payoutIban && !isValidTrIban(payoutIban)) throw badRequest('invalid_iban', 'payout_iban must be a valid Turkish IBAN');
    if (autoPayout && !payoutIban) {
      throw unprocessable('missing_iban', 'auto_payout requires an IBAN: set customer.iban or pass payout_iban (or set auto_payout=false to keep TRY on the balance)');
    }
    if (!autoPayout) payoutIban = payoutIban ?? null;

    const ts = nowIso();
    const row: OfframpRow = {
      id: newId('ofr'),
      partner_id: partner.id,
      customer_id: customer.id,
      quote_id: quoteId,
      expected_usdc: expected === null ? null : fmtUsdc(expected),
      received_usdc: null,
      amount_try: null,
      rate: fmtRate(rateMicro),
      rate_locked_until: plusSeconds(cfg.offrampRateLockSeconds),
      repriced: 0,
      memo_id: newMemoId(),
      deposit_address: stellar.treasuryPublicKey,
      auto_payout: autoPayout ? 1 : 0,
      payout_iban: payoutIban,
      payout_id: null,
      status: 'awaiting_deposit',
      tx_hash: null,
      from_address: null,
      failure_reason: null,
      created_at: ts,
      updated_at: ts,
      completed_at: null,
    };
    tx(db, () => {
      db.prepare(
        `INSERT INTO offramps(id, partner_id, customer_id, quote_id, expected_usdc, rate, rate_locked_until, repriced, memo_id, deposit_address, auto_payout, payout_iban, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
      ).run(
        row.id, row.partner_id, row.customer_id, row.quote_id, row.expected_usdc, row.rate, row.rate_locked_until,
        row.memo_id, row.deposit_address, row.auto_payout, row.payout_iban, row.status, ts, ts,
      );
      if (quoteId) db.prepare('UPDATE quotes SET consumed_by = ? WHERE id = ?').run(row.id, quoteId);
      emitEvent(db, partner.id, 'offramp.created', out(row));
    });
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
