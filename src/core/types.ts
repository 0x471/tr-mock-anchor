export interface PartnerRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  /** Sandbox: stored in clear so the dashboard can show the single key again. */
  api_key: string;
  api_key_hash: string;
  api_key_prefix: string;
  created_at: string;
  key_rotated_at: string | null;
}

export interface CustomerRow {
  id: string;
  partner_id: string;
  external_id: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  tckn: string | null;
  iban: string | null;
  kyc_status: 'approved' | 'pending' | 'rejected';
  kyc_callback_url?: string | null;
  sep12_registered?: number;
  deposit_reference: string;
  try_balance: string;
  usdc_balance: string;
  created_at: string;
  updated_at: string;
}

export interface BankTransferRow {
  id: string;
  partner_id: string;
  customer_id: string | null;
  reference: string | null;
  amount_try: string;
  sender_name: string | null;
  sender_iban: string | null;
  status: 'matched' | 'unmatched';
  created_at: string;
  matched_at: string | null;
}

export interface QuoteRow {
  id: string;
  partner_id: string;
  customer_id: string | null;
  side: 'buy' | 'sell';
  rate: string;
  mid_rate: string;
  spread_bps: number;
  rate_source: string;
  source_currency: 'TRY' | 'USDC';
  source_amount: string;
  destination_currency: 'TRY' | 'USDC';
  destination_amount: string;
  expires_at: string;
  consumed_by: string | null;
  created_at: string;
}

export interface OnrampRow {
  id: string;
  partner_id: string;
  customer_id: string;
  quote_id: string | null;
  amount_try: string;
  amount_usdc: string;
  rate: string;
  mid_rate: string | null;
  destination_address: string;
  memo: string | null;
  claimable_balance_supported: number;
  status: 'pending' | 'completed' | 'failed';
  pending_reason: string | null;
  settlement: 'payment' | 'claimable_balance' | null;
  tx_hash: string | null;
  claimable_balance_id: string | null;
  failure_reason: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface OfframpRow {
  id: string;
  partner_id: string;
  customer_id: string;
  quote_id: string | null;
  expected_usdc: string | null;
  received_usdc: string | null;
  amount_try: string | null;
  rate: string;
  mid_rate: string | null;
  rate_locked_until: string;
  repriced: number;
  memo_id: string;
  deposit_address: string;
  auto_payout: number;
  payout_iban: string | null;
  payout_id: string | null;
  status: 'awaiting_deposit' | 'completed' | 'cancelled';
  tx_hash: string | null;
  from_address: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface PayoutRow {
  id: string;
  partner_id: string;
  customer_id: string;
  offramp_id: string | null;
  amount_try: string;
  iban: string;
  bank_reference: string;
  status: 'completed';
  created_at: string;
}

export interface WebhookRow {
  id: string;
  partner_id: string;
  url: string;
  events: string;
  secret: string;
  active: number;
  created_at: string;
}

export interface EventRow {
  id: string;
  partner_id: string;
  type: string;
  payload: string;
  created_at: string;
}

export interface LedgerRow {
  id: string;
  customer_id: string;
  currency: 'TRY' | 'USDC';
  delta: string;
  balance_after: string;
  kind: string;
  ref_id: string | null;
  created_at: string;
}

export interface SepTransactionRow {
  id: string;
  partner_id: string;
  customer_id: string;
  stellar_account: string;
  kind: 'deposit' | 'withdrawal';
  account: string | null;
  memo: string | null;
  memo_type: string | null;
  amount_expected: string | null;
  source_asset: string | null;
  destination_asset: string | null;
  quote_id: string | null;
  funding_method: string | null;
  claimable_balance_supported: number;
  on_change_callback: string | null;
  lang: string | null;
  reference: string | null;
  refund_memo: string | null;
  refund_memo_type: string | null;
  onramp_id: string | null;
  offramp_id: string | null;
  status_override: string | null;
  message: string | null;
  last_callback_status: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
