/**
 * Sandbox-only controls that stand in for the real world: the bank that would notify us of
 * an incoming TRY transfer, the compliance team that flips KYC states, and (in fake Stellar
 * mode) the blockchain itself.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newId } from '../ids.js';
import { nowIso, tx } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { fmtTry, fmtUsdc, parseTry } from '../money.js';
import { normalizeReference } from '../turkey.js';
import { applyLedger, getCustomer } from '../core/ledger.js';
import { emitEvent } from '../core/events.js';
import { bankTransferOut, customerOut } from '../core/serialize.js';
import type { BankTransferRow, CustomerRow, OfframpRow } from '../core/types.js';
import type { FakeGateway } from '../stellar.js';

const SimulateBankTransfer = z.object({
  reference: z.string().trim().optional(),
  customer_id: z.string().optional(),
  amount_try: z.union([z.string(), z.number()]),
  sender_name: z.string().trim().max(120).optional(),
  sender_iban: z.string().trim().optional(),
});

const Assign = z.object({ customer_id: z.string() });
const Kyc = z.object({ status: z.enum(['approved', 'pending', 'rejected']) });
const SimulateUsdcDeposit = z.object({
  offramp_id: z.string().optional(),
  memo_id: z.string().optional(),
  amount_usdc: z.union([z.string(), z.number()]),
  from: z.string().optional(),
});

export function sandboxRoutes(deps: Deps) {
  const { db, stellar } = deps;
  const app = new Hono<AppEnv>();

  function creditTransfer(partnerId: string, customer: CustomerRow, kurus: bigint, ref: string | null, sender: { name?: string; iban?: string }): BankTransferRow {
    const ts = nowIso();
    const row: BankTransferRow = {
      id: newId('bt'),
      partner_id: partnerId,
      customer_id: customer.id,
      reference: ref,
      amount_try: fmtTry(kurus),
      sender_name: sender.name ?? null,
      sender_iban: sender.iban ?? null,
      status: 'matched',
      created_at: ts,
      matched_at: ts,
    };
    tx(db, () => {
      applyLedger(db, customer.id, 'TRY', kurus, 'bank_transfer', row.id);
      db.prepare(
        'INSERT INTO bank_transfers(id, partner_id, customer_id, reference, amount_try, sender_name, sender_iban, status, created_at, matched_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(row.id, row.partner_id, row.customer_id, row.reference, row.amount_try, row.sender_name, row.sender_iban, row.status, row.created_at, row.matched_at);
      emitEvent(db, partnerId, 'bank_transfer.received', bankTransferOut(row));
    });
    return row;
  }

  /** "A TRY transfer arrived at the anchor's bank account." Matched by deposit reference. */
  app.post('/v1/sandbox/bank-transfers', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, SimulateBankTransfer);
    const kurus = parseTry(body.amount_try);
    if (kurus <= 0n) throw unprocessable('amount_too_small', 'amount_try must be positive');
    if (!body.reference && !body.customer_id) throw badRequest('validation_error', 'Provide reference (as written in the transfer description) or customer_id');

    let customer: CustomerRow | undefined;
    const ref = body.reference ? normalizeReference(body.reference) : null;
    if (body.customer_id) customer = getCustomer(db, partner.id, body.customer_id);
    else if (ref) customer = db.prepare('SELECT * FROM customers WHERE partner_id = ? AND deposit_reference = ?').get(partner.id, ref) as CustomerRow | undefined;

    if (!customer) {
      // Real banks deliver the money anyway; the anchor holds it until someone matches it.
      const ts = nowIso();
      const row: BankTransferRow = {
        id: newId('bt'),
        partner_id: partner.id,
        customer_id: null,
        reference: ref,
        amount_try: fmtTry(kurus),
        sender_name: body.sender_name ?? null,
        sender_iban: body.sender_iban ?? null,
        status: 'unmatched',
        created_at: ts,
        matched_at: null,
      };
      tx(db, () => {
        db.prepare(
          'INSERT INTO bank_transfers(id, partner_id, customer_id, reference, amount_try, sender_name, sender_iban, status, created_at, matched_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)',
        ).run(row.id, row.partner_id, null, row.reference, row.amount_try, row.sender_name, row.sender_iban, row.status, row.created_at);
        emitEvent(db, partner.id, 'bank_transfer.unmatched', bankTransferOut(row));
      });
      return c.json(
        { ...bankTransferOut(row), hint: `No customer has deposit_reference "${ref}". Assign it with POST /v1/sandbox/bank-transfers/${row.id}/assign {"customer_id": "..."}.` },
        202,
      );
    }
    const row = creditTransfer(partner.id, customer, kurus, ref ?? customer.deposit_reference, { name: body.sender_name, iban: body.sender_iban });
    return c.json(bankTransferOut(row), 201);
  });

  app.get('/v1/sandbox/bank-transfers', (c) => {
    const partner = c.get('partner');
    const { limit, offset } = pageParams(c);
    const status = c.req.query('status') ?? null;
    const rows = db
      .prepare('SELECT * FROM bank_transfers WHERE partner_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(partner.id, status, status, limit, offset) as unknown as BankTransferRow[];
    return c.json({ data: rows.map(bankTransferOut), limit, offset });
  });

  /** Manually match an unmatched transfer to a customer (what a support desk would do). */
  app.post('/v1/sandbox/bank-transfers/:id/assign', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, Assign);
    const bt = db.prepare('SELECT * FROM bank_transfers WHERE id = ? AND partner_id = ?').get(c.req.param('id'), partner.id) as BankTransferRow | undefined;
    if (!bt) throw notFound('bank transfer');
    if (bt.status !== 'unmatched') throw unprocessable('already_matched', 'Transfer is already matched');
    const customer = getCustomer(db, partner.id, body.customer_id);
    if (!customer) throw notFound('customer');
    const kurus = parseTry(bt.amount_try);
    const ts = nowIso();
    tx(db, () => {
      applyLedger(db, customer.id, 'TRY', kurus, 'bank_transfer', bt.id);
      db.prepare("UPDATE bank_transfers SET customer_id = ?, status = 'matched', matched_at = ? WHERE id = ?").run(customer.id, ts, bt.id);
      emitEvent(db, partner.id, 'bank_transfer.received', bankTransferOut({ ...bt, customer_id: customer.id, status: 'matched', matched_at: ts }));
    });
    return c.json(bankTransferOut({ ...bt, customer_id: customer.id, status: 'matched', matched_at: ts }));
  });

  /** Flip a customer's KYC state. */
  app.post('/v1/sandbox/customers/:id/kyc', async (c) => {
    const partner = c.get('partner');
    const customer = getCustomer(db, partner.id, c.req.param('id'));
    if (!customer) throw notFound('customer');
    const body = await parseBody(c, Kyc);
    const ts = nowIso();
    tx(db, () => {
      db.prepare('UPDATE customers SET kyc_status = ?, updated_at = ? WHERE id = ?').run(body.status, ts, customer.id);
      emitEvent(db, partner.id, 'customer.kyc_updated', customerOut({ ...customer, kyc_status: body.status, updated_at: ts }));
    });
    return c.json(customerOut({ ...customer, kyc_status: body.status, updated_at: ts }));
  });

  /** Treasury status: where off-ramp deposits go and how much USDC is left for on-ramps. */
  app.get('/v1/sandbox/treasury', async (c) => {
    const bal = await stellar.treasuryUsdcBalance();
    return c.json({
      network: 'stellar-testnet',
      stellar_mode: stellar.mode,
      address: stellar.treasuryPublicKey,
      asset: { code: stellar.assetCode, issuer: stellar.assetIssuer },
      usdc_balance: fmtUsdc(bal),
      low_balance: bal < 100_0000000n,
    });
  });

  /** USDC that reached the treasury without a usable memo. Global (all partners), sandbox only. */
  app.get('/v1/sandbox/unmatched-deposits', (c) => {
    const { limit, offset } = pageParams(c);
    const rows = db.prepare('SELECT * FROM unmatched_deposits ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
    return c.json({ data: rows, limit, offset });
  });

  /** Fake-Stellar mode only: pretend a USDC payment reached the treasury. */
  app.post('/v1/sandbox/usdc-deposits', async (c) => {
    if (stellar.mode !== 'fake') {
      throw unprocessable('live_stellar', `This server runs against real Stellar testnet. Send ${stellar.assetCode} to ${stellar.treasuryPublicKey} with the off-ramp memo instead.`);
    }
    const partner = c.get('partner');
    const body = await parseBody(c, SimulateUsdcDeposit);
    let memoId = body.memo_id;
    if (body.offramp_id) {
      const o = db.prepare('SELECT * FROM offramps WHERE id = ? AND partner_id = ?').get(body.offramp_id, partner.id) as OfframpRow | undefined;
      if (!o) throw notFound('offramp');
      memoId = o.memo_id;
    }
    const p = (stellar as FakeGateway).simulateIncoming({ amount: String(body.amount_usdc), memoId, from: body.from });
    return c.json({ queued: true, tx_hash: p.txHash, memo: p.memo, amount_usdc: fmtUsdc(p.amountStroops), note: 'The off-ramp watcher picks this up on its next tick.' }, 202);
  });

  return app;
}
