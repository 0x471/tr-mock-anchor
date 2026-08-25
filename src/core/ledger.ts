import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { newId } from '../ids.js';
import { fmtTry, fmtUsdc, parseTry, parseUsdc } from '../money.js';
import { unprocessable } from '../errors.js';
import type { CustomerRow } from './types.js';

export type Currency = 'TRY' | 'USDC';

/**
 * Move `delta` (scaled bigint, may be negative) on a customer's balance and write a ledger row.
 * Must be called inside tx(). Throws insufficient_balance if the result would go negative.
 */
export function applyLedger(db: DB, customerId: string, currency: Currency, delta: bigint, kind: string, refId?: string): bigint {
  const col = currency === 'TRY' ? 'try_balance' : 'usdc_balance';
  const row = db.prepare(`SELECT ${col} AS bal FROM customers WHERE id = ?`).get(customerId) as { bal: string } | undefined;
  if (!row) throw new Error(`customer ${customerId} missing`);
  const parse = currency === 'TRY' ? parseTry : parseUsdc;
  const fmt = currency === 'TRY' ? fmtTry : fmtUsdc;
  const after = parse(row.bal) + delta;
  if (after < 0n) {
    throw unprocessable('insufficient_balance', `Customer ${currency} balance is ${row.bal}; ${fmt(-delta)} required`, {
      currency,
      available: row.bal,
      required: fmt(-delta),
    });
  }
  const ts = nowIso();
  db.prepare(`UPDATE customers SET ${col} = ?, updated_at = ? WHERE id = ?`).run(fmt(after), ts, customerId);
  db.prepare(
    'INSERT INTO ledger(id, customer_id, currency, delta, balance_after, kind, ref_id, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(newId('led'), customerId, currency, fmt(delta), fmt(after), kind, refId ?? null, ts);
  return after;
}

export function getCustomer(db: DB, partnerId: string, id: string): CustomerRow | undefined {
  return db.prepare('SELECT * FROM customers WHERE id = ? AND partner_id = ?').get(id, partnerId) as CustomerRow | undefined;
}
