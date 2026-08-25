import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newId } from '../ids.js';
import { nowIso, tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { isValidTckn, isValidTrIban, makeDepositReference, normalizeIban } from '../turkey.js';
import { emitEvent } from '../core/events.js';
import { getCustomer } from '../core/ledger.js';
import { bankTransferOut, customerOut, depositInstructionsOut, ledgerOut } from '../core/serialize.js';
import type { BankTransferRow, CustomerRow, LedgerRow } from '../core/types.js';

const CreateCustomer = z.object({
  external_id: z.string().trim().min(1).max(120).optional(),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.email().optional(),
  tckn: z.string().trim().optional(),
  iban: z.string().trim().optional(),
});

const UpdateCustomer = z.object({
  email: z.email().nullable().optional(),
  iban: z.string().trim().nullable().optional(),
});

/** Sandbox KYC: instant approval, with magic first names to exercise the other states. */
function decideKyc(firstName: string): CustomerRow['kyc_status'] {
  const n = firstName.trim().toUpperCase();
  if (n === 'REJECT') return 'rejected';
  if (n === 'PENDING') return 'pending';
  return 'approved';
}

export function customerRoutes(deps: Deps) {
  const { db, cfg } = deps;
  const app = new Hono<AppEnv>();

  app.post('/v1/customers', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateCustomer);
    if (body.tckn !== undefined && !isValidTckn(body.tckn)) {
      throw badRequest('invalid_tckn', 'tckn must be a valid 11-digit T.C. Kimlik No (checksum failed). Test value: 10000000146');
    }
    let iban: string | null = null;
    if (body.iban !== undefined) {
      iban = normalizeIban(body.iban);
      if (!isValidTrIban(iban)) throw badRequest('invalid_iban', 'iban must be a valid Turkish IBAN (TR + 24 digits, mod-97 checksum)');
    }
    if (body.external_id) {
      const dup = db.prepare('SELECT id FROM customers WHERE partner_id = ? AND external_id = ?').get(partner.id, body.external_id);
      if (dup) throw conflict('duplicate_external_id', `external_id "${body.external_id}" already exists for this partner`);
    }
    const id = newId('cus');
    const ts = nowIso();
    const row: CustomerRow = {
      id,
      partner_id: partner.id,
      external_id: body.external_id ?? null,
      first_name: body.first_name,
      last_name: body.last_name,
      email: body.email ?? null,
      tckn: body.tckn ?? null,
      iban,
      kyc_status: decideKyc(body.first_name),
      deposit_reference: makeDepositReference(),
      try_balance: '0.00',
      usdc_balance: '0.0000000',
      created_at: ts,
      updated_at: ts,
    };
    tx(db, () => {
      db.prepare(
        `INSERT INTO customers(id, partner_id, external_id, first_name, last_name, email, tckn, iban, kyc_status, deposit_reference, try_balance, usdc_balance, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        row.id, row.partner_id, row.external_id, row.first_name, row.last_name, row.email, row.tckn, row.iban,
        row.kyc_status, row.deposit_reference, row.try_balance, row.usdc_balance, row.created_at, row.updated_at,
      );
      emitEvent(db, partner.id, 'customer.created', customerOut(row));
    });
    return c.json(customerOut(row), 201);
  });

  app.get('/v1/customers', (c) => {
    const partner = c.get('partner');
    const { limit, offset } = pageParams(c);
    const rows = db
      .prepare('SELECT * FROM customers WHERE partner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(partner.id, limit, offset) as unknown as CustomerRow[];
    return c.json({ data: rows.map(customerOut), limit, offset });
  });

  app.get('/v1/customers/:id', (c) => {
    const row = getCustomer(db, c.get('partner').id, c.req.param('id'));
    if (!row) throw notFound('customer');
    return c.json(customerOut(row));
  });

  app.patch('/v1/customers/:id', async (c) => {
    const partner = c.get('partner');
    const row = getCustomer(db, partner.id, c.req.param('id'));
    if (!row) throw notFound('customer');
    const body = await parseBody(c, UpdateCustomer);
    let iban = row.iban;
    if (body.iban !== undefined) {
      iban = body.iban === null ? null : normalizeIban(body.iban);
      if (iban !== null && !isValidTrIban(iban)) throw badRequest('invalid_iban', 'iban must be a valid Turkish IBAN');
    }
    const email = body.email === undefined ? row.email : body.email;
    const ts = nowIso();
    db.prepare('UPDATE customers SET iban = ?, email = ?, updated_at = ? WHERE id = ?').run(iban, email, ts, row.id);
    return c.json(customerOut({ ...row, iban, email, updated_at: ts }));
  });

  app.get('/v1/customers/:id/deposit-instructions', (c) => {
    const row = getCustomer(db, c.get('partner').id, c.req.param('id'));
    if (!row) throw notFound('customer');
    return c.json(depositInstructionsOut(cfg, row));
  });

  app.get('/v1/customers/:id/balances', (c) => {
    const row = getCustomer(db, c.get('partner').id, c.req.param('id'));
    if (!row) throw notFound('customer');
    return c.json({ customer_id: row.id, balances: { TRY: row.try_balance, USDC: row.usdc_balance }, as_of: nowIso() });
  });

  app.get('/v1/customers/:id/ledger', (c) => {
    const row = getCustomer(db, c.get('partner').id, c.req.param('id'));
    if (!row) throw notFound('customer');
    const { limit, offset } = pageParams(c);
    const rows = db
      .prepare('SELECT * FROM ledger WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(row.id, limit, offset) as unknown as LedgerRow[];
    return c.json({ data: rows.map(ledgerOut), limit, offset });
  });

  app.get('/v1/customers/:id/bank-transfers', (c) => {
    const row = getCustomer(db, c.get('partner').id, c.req.param('id'));
    if (!row) throw notFound('customer');
    const { limit, offset } = pageParams(c);
    const rows = db
      .prepare('SELECT * FROM bank_transfers WHERE customer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(row.id, limit, offset) as unknown as BankTransferRow[];
    return c.json({ data: rows.map(bankTransferOut), limit, offset });
  });

  return app;
}
