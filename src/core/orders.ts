/**
 * Order creation shared by the API-key routes and the SEP-6 routes. Both doors debit/lock the same
 * way; only the request shapes differ.
 */
import type { Deps } from '../context.js';
import { newId, newMemoId } from '../ids.js';
import { nowIso, plusSeconds } from '../db.js';
import { badRequest, unprocessable } from '../errors.js';
import { fmtRate, fmtTry, fmtUsdc, parseRate, parseTry, parseUsdc, tryToUsdc } from '../money.js';
import { isStellarAddress } from '../stellar.js';
import { isValidTrIban, normalizeIban } from '../turkey.js';
import { applyLedger } from './ledger.js';
import { emitEvent } from './events.js';
import { offrampOut, onrampOut } from './serialize.js';
import type { CustomerRow, OfframpRow, OnrampRow, QuoteRow } from './types.js';

export interface RateLock {
  rateMicro: bigint;
  midMicro: bigint;
  quoteId: string | null;
}

/** Resolve a rate for `side`: from a usable quote when given, else live. */
export async function resolveRate(deps: Deps, side: 'buy' | 'sell', quote: QuoteRow | null): Promise<RateLock> {
  if (quote) return { rateMicro: parseRate(quote.rate), midMicro: parseRate(quote.mid_rate), quoteId: quote.id };
  const q = await deps.rates.quote(side);
  return { rateMicro: q.rateMicro, midMicro: q.mid.midMicro, quoteId: null };
}

/**
 * Create an on-ramp: debit TRY now, pay USDC asynchronously. Must be called inside tx().
 * Throws 422 when the balance, KYC or limits do not allow it.
 */
export function createOnramp(
  deps: Deps,
  customer: CustomerRow,
  args: { kurus: bigint; rate: RateLock; destination: string; memo?: string | null },
): OnrampRow {
  const { db, cfg } = deps;
  if (customer.kyc_status !== 'approved') throw unprocessable('kyc_not_approved', `Customer KYC status is ${customer.kyc_status}`);
  if (!isStellarAddress(args.destination)) throw badRequest('invalid_destination_address', 'destination must be a Stellar account (G...) or muxed (M...) address. Contract addresses (C...) are not supported: USDC is a classic asset paid via a classic payment, which cannot target a contract.');
  if (args.kurus < parseTry(cfg.minOnrampTry)) throw unprocessable('below_minimum', `Minimum on-ramp is ${cfg.minOnrampTry} TRY`);
  if (args.kurus > parseTry(cfg.maxOnrampTry)) throw unprocessable('above_maximum', `Maximum on-ramp is ${cfg.maxOnrampTry} TRY`);
  const stroops = tryToUsdc(args.kurus, args.rate.rateMicro);
  if (stroops <= 0n) throw unprocessable('amount_too_small', 'Amount rounds to zero USDC');

  const ts = nowIso();
  const row: OnrampRow = {
    id: newId('onr'),
    partner_id: customer.partner_id,
    customer_id: customer.id,
    quote_id: args.rate.quoteId,
    amount_try: fmtTry(args.kurus),
    amount_usdc: fmtUsdc(stroops),
    rate: fmtRate(args.rate.rateMicro),
    mid_rate: fmtRate(args.rate.midMicro),
    destination_address: args.destination,
    memo: args.memo ?? null,
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
  applyLedger(db, customer.id, 'TRY', -args.kurus, 'onramp', row.id);
  db.prepare(
    `INSERT INTO onramps(id, partner_id, customer_id, quote_id, amount_try, amount_usdc, rate, mid_rate, destination_address, memo, status, attempts, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
  ).run(row.id, row.partner_id, row.customer_id, row.quote_id, row.amount_try, row.amount_usdc, row.rate, row.mid_rate, row.destination_address, row.memo, row.status, ts, ts);
  if (row.quote_id) db.prepare('UPDATE quotes SET consumed_by = ? WHERE id = ?').run(row.id, row.quote_id);
  emitEvent(db, customer.partner_id, 'onramp.created', onrampOut(row));
  return row;
}

/** Create an off-ramp (deposit address + memo). Must be called inside tx(). */
export function createOfframp(
  deps: Deps,
  customer: CustomerRow,
  args: { expected: bigint | null; rate: RateLock; autoPayout: boolean; payoutIban?: string | null },
): OfframpRow {
  const { db, cfg, stellar } = deps;
  if (customer.kyc_status !== 'approved') throw unprocessable('kyc_not_approved', `Customer KYC status is ${customer.kyc_status}`);
  if (args.expected !== null && args.expected < parseUsdc(cfg.minOfframpUsdc)) {
    throw unprocessable('below_minimum', `Minimum off-ramp is ${cfg.minOfframpUsdc} USDC`);
  }
  let payoutIban: string | null = args.payoutIban ? normalizeIban(args.payoutIban) : customer.iban;
  if (payoutIban && !isValidTrIban(payoutIban)) throw badRequest('invalid_iban', 'payout_iban must be a valid Turkish IBAN');
  if (args.autoPayout && !payoutIban) {
    throw unprocessable('missing_iban', 'auto_payout requires an IBAN: set customer.iban or pass payout_iban (or set auto_payout=false to keep TRY on the balance)');
  }
  if (!args.autoPayout) payoutIban = payoutIban ?? null;

  const ts = nowIso();
  const row: OfframpRow = {
    id: newId('ofr'),
    partner_id: customer.partner_id,
    customer_id: customer.id,
    quote_id: args.rate.quoteId,
    expected_usdc: args.expected === null ? null : fmtUsdc(args.expected),
    received_usdc: null,
    amount_try: null,
    rate: fmtRate(args.rate.rateMicro),
    mid_rate: fmtRate(args.rate.midMicro),
    rate_locked_until: plusSeconds(cfg.offrampRateLockSeconds),
    repriced: 0,
    memo_id: newMemoId(),
    deposit_address: stellar.treasuryPublicKey,
    auto_payout: args.autoPayout ? 1 : 0,
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
  db.prepare(
    `INSERT INTO offramps(id, partner_id, customer_id, quote_id, expected_usdc, rate, mid_rate, rate_locked_until, repriced, memo_id, deposit_address, auto_payout, payout_iban, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
  ).run(
    row.id, row.partner_id, row.customer_id, row.quote_id, row.expected_usdc, row.rate, row.mid_rate, row.rate_locked_until,
    row.memo_id, row.deposit_address, row.auto_payout, row.payout_iban, row.status, ts, ts,
  );
  if (row.quote_id) db.prepare('UPDATE quotes SET consumed_by = ? WHERE id = ?').run(row.id, row.quote_id);
  emitEvent(db, customer.partner_id, 'offramp.created', offrampOut(row, stellar.assetCode, stellar.assetIssuer));
  return row;
}
