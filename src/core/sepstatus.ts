/**
 * SEP-6 view of our orders. Status is derived from the linked on-ramp / off-ramp so the two doors
 * never disagree; only terminal overrides (e.g. cancelled) are stored on the SEP row.
 */
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { StellarGateway } from '../stellar.js';
import { fmtTry, parseRate, parseTry, parseUsdc, usdcToTry } from '../money.js';
import { TRY_ASSET, usdcAsset } from './sep.js';
import type { OfframpRow, OnrampRow, PayoutRow, SepTransactionRow } from './types.js';

export type SepStatus =
  | 'incomplete'
  | 'pending_user_transfer_start'
  | 'pending_anchor'
  | 'pending_stellar'
  | 'pending_trust'
  | 'pending_external'
  | 'completed'
  | 'error';

export interface SepBundle {
  tx: SepTransactionRow;
  onramp: OnrampRow | null;
  offramp: OfframpRow | null;
  payout: PayoutRow | null;
}

export function loadSepTx(db: DB, id: string): SepBundle | null {
  const tx = db.prepare('SELECT * FROM sep_transactions WHERE id = ?').get(id) as unknown as SepTransactionRow | undefined;
  return tx ? bundle(db, tx) : null;
}

export function bundle(db: DB, tx: SepTransactionRow): SepBundle {
  const onramp = tx.onramp_id ? ((db.prepare('SELECT * FROM onramps WHERE id = ?').get(tx.onramp_id) as unknown as OnrampRow | undefined) ?? null) : null;
  const offramp = tx.offramp_id ? ((db.prepare('SELECT * FROM offramps WHERE id = ?').get(tx.offramp_id) as unknown as OfframpRow | undefined) ?? null) : null;
  const payout = offramp?.payout_id ? ((db.prepare('SELECT * FROM payouts WHERE id = ?').get(offramp.payout_id) as unknown as PayoutRow | undefined) ?? null) : null;
  return { tx, onramp, offramp, payout };
}

export function sepStatusOf(b: SepBundle): SepStatus {
  if (b.tx.status_override) return b.tx.status_override as SepStatus;
  if (b.tx.kind === 'deposit') {
    if (!b.onramp) return 'pending_user_transfer_start';
    if (b.onramp.status === 'pending') return b.onramp.pending_reason?.startsWith('retrying') ? 'pending_stellar' : 'pending_anchor';
    if (b.onramp.status === 'completed') return 'completed';
    return 'error';
  }
  if (!b.offramp) return 'incomplete';
  if (b.offramp.status === 'awaiting_deposit') return 'pending_user_transfer_start';
  if (b.offramp.status === 'completed') return 'completed';
  return 'error';
}

function sepMessage(b: SepBundle, status: SepStatus): string | null {
  if (b.tx.message) return b.tx.message;
  if (b.tx.kind === 'deposit') {
    if (status === 'pending_user_transfer_start') return 'Waiting for the TRY bank transfer. Sandbox: simulate it from more_info_url.';
    if (status === 'pending_anchor') return b.onramp?.pending_reason === 'treasury_low' ? 'Treasury is low on USDC; the payout will settle once it is refilled.' : 'TRY received; paying USDC on Stellar.';
    if (status === 'pending_stellar') return b.onramp?.pending_reason ?? null;
    if (status === 'error') return b.onramp?.failure_reason ?? 'On-ramp failed; TRY was refunded to the balance.';
  } else {
    if (status === 'pending_user_transfer_start') return `Send ${b.offramp?.expected_usdc ?? 'any amount of'} USDC to ${b.offramp?.deposit_address} with memo (id) ${b.offramp?.memo_id}.`;
    if (status === 'completed') return `TRY paid to ${b.payout?.iban ?? b.offramp?.payout_iban} via FAST (simulated).`;
  }
  return null;
}

/** Spread fee in TRY: the difference between converting at mid and at the applied rate. */
function feeTry(kurus: bigint, stroops: bigint, midRate: string | null): bigint | null {
  if (!midRate) return null;
  const atMid = usdcToTry(stroops, parseRate(midRate));
  const diff = kurus > atMid ? kurus - atMid : atMid - kurus;
  return diff < 0n ? 0n : diff;
}

export function sepTransactionOut(cfg: Config, stellar: StellarGateway, b: SepBundle) {
  const status = sepStatusOf(b);
  const usdc = usdcAsset(stellar.assetCode, stellar.assetIssuer);
  const base = {
    id: b.tx.id,
    kind: b.tx.kind,
    status,
    status_eta: status === 'pending_anchor' || status === 'pending_stellar' ? 5 : null,
    more_info_url: `${cfg.publicUrl}/sep6/tx/${b.tx.id}`,
    message: sepMessage(b, status),
    started_at: b.tx.created_at,
    updated_at: b.tx.updated_at,
    completed_at: b.onramp?.completed_at ?? b.offramp?.completed_at ?? null,
    user_action_required_by: status === 'pending_user_transfer_start' && b.tx.kind === 'withdrawal' ? b.offramp?.rate_locked_until ?? null : null,
    quote_id: b.tx.quote_id ?? b.onramp?.quote_id ?? b.offramp?.quote_id ?? null,
    refunded: false,
    refunds: null as unknown,
  };

  if (b.tx.kind === 'deposit') {
    const o = b.onramp;
    const fee = o ? feeTry(parseTry(o.amount_try), parseUsdc(o.amount_usdc), o.mid_rate) : null;
    const refunded = o?.status === 'failed';
    return {
      ...base,
      amount_in: o ? o.amount_try : b.tx.amount_expected,
      amount_in_asset: TRY_ASSET,
      amount_out: o ? o.amount_usdc : null,
      amount_out_asset: usdc,
      amount_fee: fee === null ? null : fmtTry(fee),
      amount_fee_asset: TRY_ASSET,
      fee_details: fee === null ? null : { total: fmtTry(fee), asset: TRY_ASSET, details: [{ name: 'spread', description: `${cfg.spreadBps} bps over the USD/TRY mid rate`, amount: fmtTry(fee) }] },
      from: null,
      to: b.tx.account,
      deposit_memo: b.tx.memo,
      deposit_memo_type: b.tx.memo_type,
      stellar_transaction_id: o?.tx_hash ?? null,
      external_transaction_id: b.tx.reference,
      claimable_balance_id: o?.claimable_balance_id ?? null,
      instructions: b.tx.reference ? depositInstructions(cfg, b.tx.reference) : null,
      refunded,
      refunds: refunded && o ? { amount_refunded: o.amount_try, amount_fee: '0.00', payments: [{ id: o.id, id_type: 'external', amount: o.amount_try, fee: '0.00' }] } : null,
    };
  }

  const f = b.offramp;
  const received = f?.received_usdc ?? null;
  const fee = f && received && f.amount_try ? feeTry(parseTry(f.amount_try), parseUsdc(received), f.mid_rate) : null;
  return {
    ...base,
    amount_in: received ?? f?.expected_usdc ?? b.tx.amount_expected,
    amount_in_asset: usdc,
    amount_out: f?.amount_try ?? null,
    amount_out_asset: TRY_ASSET,
    amount_fee: fee === null ? null : fmtTry(fee),
    amount_fee_asset: TRY_ASSET,
    fee_details: fee === null ? null : { total: fmtTry(fee), asset: TRY_ASSET, details: [{ name: 'spread', description: `${cfg.spreadBps} bps under the USD/TRY mid rate`, amount: fmtTry(fee) }] },
    from: f?.from_address ?? b.tx.account,
    to: f?.payout_iban ?? null,
    withdraw_anchor_account: f?.deposit_address ?? stellar.treasuryPublicKey,
    withdraw_memo: f?.memo_id ?? null,
    withdraw_memo_type: 'id',
    stellar_transaction_id: f?.tx_hash ?? null,
    external_transaction_id: b.payout?.bank_reference ?? null,
    refund_memo: b.tx.refund_memo,
    refund_memo_type: b.tx.refund_memo_type,
  };
}

/** SEP-9 financial-account style instructions for a TRY bank transfer. */
export function depositInstructions(cfg: Config, reference: string) {
  return {
    bank_name: { value: cfg.bankName, description: 'Bank holding the anchor account' },
    bank_account_number: { value: cfg.anchorIban, description: `IBAN to send TRY to (account holder: ${cfg.accountHolder})` },
    external_transfer_memo: { value: reference, description: 'Write this reference in the transfer description (açıklama). It routes the money to your account.' },
  };
}
