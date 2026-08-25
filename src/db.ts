import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS partners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  api_key TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL UNIQUE,
  api_key_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL,
  key_rotated_at TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partners(id),
  external_id TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  tckn TEXT,
  iban TEXT,
  kyc_status TEXT NOT NULL,
  deposit_reference TEXT NOT NULL UNIQUE,
  try_balance TEXT NOT NULL DEFAULT '0.00',
  usdc_balance TEXT NOT NULL DEFAULT '0.0000000',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(partner_id, external_id)
);
CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  currency TEXT NOT NULL,
  delta TEXT NOT NULL,
  balance_after TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_customer ON ledger(customer_id, created_at);
CREATE TABLE IF NOT EXISTS bank_transfers (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  customer_id TEXT,
  reference TEXT,
  amount_try TEXT NOT NULL,
  sender_name TEXT,
  sender_iban TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  matched_at TEXT
);
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  customer_id TEXT,
  side TEXT NOT NULL,
  rate TEXT NOT NULL,
  mid_rate TEXT NOT NULL,
  spread_bps INTEGER NOT NULL,
  rate_source TEXT NOT NULL,
  source_currency TEXT NOT NULL,
  source_amount TEXT NOT NULL,
  destination_currency TEXT NOT NULL,
  destination_amount TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS onramps (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  quote_id TEXT,
  amount_try TEXT NOT NULL,
  amount_usdc TEXT NOT NULL,
  rate TEXT NOT NULL,
  destination_address TEXT NOT NULL,
  memo TEXT,
  status TEXT NOT NULL,
  pending_reason TEXT,
  settlement TEXT,
  tx_hash TEXT,
  claimable_balance_id TEXT,
  failure_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS onramps_status ON onramps(status, created_at);
CREATE TABLE IF NOT EXISTS offramps (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  quote_id TEXT,
  expected_usdc TEXT,
  received_usdc TEXT,
  amount_try TEXT,
  rate TEXT NOT NULL,
  rate_locked_until TEXT NOT NULL,
  repriced INTEGER NOT NULL DEFAULT 0,
  memo_id TEXT NOT NULL UNIQUE,
  deposit_address TEXT NOT NULL,
  auto_payout INTEGER NOT NULL DEFAULT 1,
  payout_iban TEXT,
  payout_id TEXT,
  status TEXT NOT NULL,
  tx_hash TEXT,
  from_address TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS offramps_status ON offramps(status, created_at);
CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  offramp_id TEXT,
  amount_try TEXT NOT NULL,
  iban TEXT NOT NULL,
  bank_reference TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_partner ON events(partner_id, created_at);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  last_status_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_due ON webhook_deliveries(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS unmatched_deposits (
  id TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  from_address TEXT,
  amount_usdc TEXT NOT NULL,
  memo_type TEXT,
  memo TEXT,
  to_muxed_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Run `fn` inside a write transaction. node:sqlite is synchronous, so this is safe to nest-free use. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const nowIso = () => new Date().toISOString();
export const plusSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export function kvGet(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
export function kvSet(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
