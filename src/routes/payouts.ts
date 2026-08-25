import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newBankReference, newId } from '../ids.js';
import { nowIso, tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { fmtTry, parseTry } from '../money.js';
import { isValidTrIban, normalizeIban } from '../turkey.js';
import { applyLedger, getCustomer } from '../core/ledger.js';
import { emitEvent } from '../core/events.js';
import { payoutOut } from '../core/serialize.js';
import type { PayoutRow } from '../core/types.js';

const CreatePayout = z.object({
  customer_id: z.string(),
  amount_try: z.union([z.string(), z.number()]),
  iban: z.string().trim().optional(),
});

export function payoutRoutes(deps: Deps) {
  const { db } = deps;
  const app = new Hono<AppEnv>();

  // Withdraw TRY balance to the customer's bank account. Sandbox: settles instantly via "FAST".
  app.post('/v1/payouts', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreatePayout);
    const customer = getCustomer(db, partner.id, body.customer_id);
    if (!customer) throw notFound('customer');
    if (customer.kyc_status !== 'approved') throw unprocessable('kyc_not_approved', `Customer KYC status is ${customer.kyc_status}`);
    const iban = body.iban ? normalizeIban(body.iban) : customer.iban;
    if (!iban) throw unprocessable('missing_iban', 'Provide iban or set customer.iban first');
    if (!isValidTrIban(iban)) throw badRequest('invalid_iban', 'iban must be a valid Turkish IBAN');
    const kurus = parseTry(body.amount_try);
    if (kurus <= 0n) throw unprocessable('amount_too_small', 'amount_try must be positive');

    const row: PayoutRow = {
      id: newId('po'),
      partner_id: partner.id,
      customer_id: customer.id,
      offramp_id: null,
      amount_try: fmtTry(kurus),
      iban,
      bank_reference: newBankReference(),
      status: 'completed',
      created_at: nowIso(),
    };
    tx(db, () => {
      applyLedger(db, customer.id, 'TRY', -kurus, 'payout', row.id);
      db.prepare(
        'INSERT INTO payouts(id, partner_id, customer_id, offramp_id, amount_try, iban, bank_reference, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(row.id, row.partner_id, row.customer_id, null, row.amount_try, row.iban, row.bank_reference, row.status, row.created_at);
      emitEvent(db, partner.id, 'payout.completed', payoutOut(row));
    });
    return c.json(payoutOut(row), 201);
  });

  app.get('/v1/payouts', (c) => {
    const partner = c.get('partner');
    const { limit, offset } = pageParams(c);
    const customerId = c.req.query('customer_id');
    const rows = db
      .prepare('SELECT * FROM payouts WHERE partner_id = ? AND (? IS NULL OR customer_id = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(partner.id, customerId ?? null, customerId ?? null, limit, offset) as unknown as PayoutRow[];
    return c.json({ data: rows.map(payoutOut), limit, offset });
  });

  app.get('/v1/payouts/:id', (c) => {
    const row = db.prepare('SELECT * FROM payouts WHERE id = ? AND partner_id = ?').get(c.req.param('id'), c.get('partner').id) as PayoutRow | undefined;
    if (!row) throw notFound('payout');
    return c.json(payoutOut(row));
  });

  return app;
}
