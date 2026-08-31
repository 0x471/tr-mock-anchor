import type { Config } from '../config.js';
import { formatIban } from '../turkey.js';
import { stellarPayUri } from '../sep7.js';
import type {
  BankTransferRow,
  CustomerRow,
  LedgerRow,
  OfframpRow,
  OnrampRow,
  PayoutRow,
  QuoteRow,
  WebhookRow,
} from './types.js';

export const customerOut = (c: CustomerRow) => ({
  id: c.id,
  external_id: c.external_id,
  first_name: c.first_name,
  last_name: c.last_name,
  email: c.email,
  tckn: c.tckn,
  iban: c.iban,
  kyc_status: c.kyc_status,
  deposit_reference: c.deposit_reference,
  balances: { TRY: c.try_balance, USDC: c.usdc_balance },
  created_at: c.created_at,
  updated_at: c.updated_at,
});

export const depositInstructionsOut = (cfg: Config, c: CustomerRow) => ({
  customer_id: c.id,
  method: 'bank_transfer',
  rails: ['FAST', 'EFT', 'Havale'],
  currency: 'TRY',
  bank_name: cfg.bankName,
  account_holder: cfg.accountHolder,
  iban: cfg.anchorIban,
  iban_formatted: formatIban(cfg.anchorIban),
  reference: c.deposit_reference,
  instructions: {
    en: `Send TRY to the IBAN above and write "${c.deposit_reference}" in the transfer description. Funds are credited to your TRY balance when the transfer is matched.`,
    tr: `Yukarıdaki IBAN'a TL gönderin ve açıklama kısmına "${c.deposit_reference}" yazın. Transfer eşleştiğinde TL bakiyenize yansır.`,
  },
  sandbox_hint: `This is a sandbox: no real bank exists. Simulate the incoming transfer with POST /v1/sandbox/bank-transfers {"reference":"${c.deposit_reference}","amount_try":"1000.00"}.`,
});

export const bankTransferOut = (b: BankTransferRow) => ({
  id: b.id,
  customer_id: b.customer_id,
  reference: b.reference,
  amount_try: b.amount_try,
  currency: 'TRY',
  sender_name: b.sender_name,
  sender_iban: b.sender_iban,
  status: b.status,
  created_at: b.created_at,
  matched_at: b.matched_at,
});

export const quoteOut = (q: QuoteRow) => ({
  id: q.id,
  customer_id: q.customer_id,
  side: q.side,
  pair: 'USDC/TRY',
  rate: q.rate,
  mid_rate: q.mid_rate,
  spread_bps: q.spread_bps,
  rate_source: q.rate_source,
  source_currency: q.source_currency,
  source_amount: q.source_amount,
  destination_currency: q.destination_currency,
  destination_amount: q.destination_amount,
  expires_at: q.expires_at,
  consumed_by: q.consumed_by,
  created_at: q.created_at,
});

export const onrampOut = (o: OnrampRow) => ({
  id: o.id,
  type: 'onramp',
  customer_id: o.customer_id,
  quote_id: o.quote_id,
  amount_try: o.amount_try,
  amount_usdc: o.amount_usdc,
  rate: o.rate,
  destination_address: o.destination_address,
  memo: o.memo,
  status: o.status,
  pending_reason: o.pending_reason,
  settlement: o.settlement,
  stellar_tx_hash: o.tx_hash,
  claimable_balance_id: o.claimable_balance_id,
  failure_reason: o.failure_reason,
  created_at: o.created_at,
  updated_at: o.updated_at,
  completed_at: o.completed_at,
});

export const offrampOut = (o: OfframpRow, assetCode: string, assetIssuer: string) => ({
  id: o.id,
  type: 'offramp',
  customer_id: o.customer_id,
  quote_id: o.quote_id,
  status: o.status,
  expected_usdc: o.expected_usdc,
  received_usdc: o.received_usdc,
  amount_try: o.amount_try,
  rate: o.rate,
  rate_locked_until: o.rate_locked_until,
  repriced: !!o.repriced,
  deposit: {
    network: 'stellar',
    asset_code: assetCode,
    asset_issuer: assetIssuer,
    address: o.deposit_address,
    memo_type: 'id',
    memo: o.memo_id,
    instructions: `Send ${assetCode} to ${o.deposit_address} with memo (type id) ${o.memo_id} (a muxed address with that id also works). The MEMO is what routes your deposit \u2014 the amount is flexible (whatever you send, min 1 ${assetCode}, is converted). The treasury address is the same for every off-ramp; each off-ramp has its own memo.`,
    // SEP-7: open a pre-filled payment in a Stellar wallet (Freighter, Lobstr, …) or render it as a QR.
    payment_uri: stellarPayUri({ destination: o.deposit_address, assetCode, assetIssuer, memoId: o.memo_id, amount: o.expected_usdc, msg: 'TR Mock Anchor off-ramp' }),
  },
  auto_payout: !!o.auto_payout,
  payout_iban: o.payout_iban,
  payout_id: o.payout_id,
  stellar_tx_hash: o.tx_hash,
  from_address: o.from_address,
  failure_reason: o.failure_reason,
  created_at: o.created_at,
  updated_at: o.updated_at,
  completed_at: o.completed_at,
});

export const payoutOut = (p: PayoutRow) => ({
  id: p.id,
  customer_id: p.customer_id,
  offramp_id: p.offramp_id,
  amount_try: p.amount_try,
  currency: 'TRY',
  iban: p.iban,
  rail: 'FAST',
  bank_reference: p.bank_reference,
  status: p.status,
  created_at: p.created_at,
});

export const webhookOut = (w: WebhookRow, secret?: string) => ({
  id: w.id,
  url: w.url,
  events: JSON.parse(w.events) as string[],
  active: !!w.active,
  ...(secret ? { secret } : {}),
  created_at: w.created_at,
});

export const ledgerOut = (l: LedgerRow) => ({
  id: l.id,
  currency: l.currency,
  delta: l.delta,
  balance_after: l.balance_after,
  kind: l.kind,
  ref_id: l.ref_id,
  created_at: l.created_at,
});
