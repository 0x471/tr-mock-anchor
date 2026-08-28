/**
 * Shared plumbing for the SEP (wallet-facing) door: the built-in partner that owns wallet users,
 * the anchor signing key (SEP-1 SIGNING_KEY / SEP-10 server key / callback signatures), the JWT
 * secret, and the mapping from a SEP-10 subject to a customer row.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db.js';
import { kvGet, kvSet, nowIso } from '../db.js';
import { hashApiKey, newApiKey, newId } from '../ids.js';
import { hashPassword } from './partners.js';
import { makeDepositReference, makeTrIban } from '../turkey.js';
import type { Config } from '../config.js';
import type { CustomerRow, PartnerRow } from './types.js';

export const SEP_PARTNER_ID = 'prt_sep_wallets';

export function ensureSepPartner(db: DB): PartnerRow {
  const existing = db.prepare('SELECT * FROM partners WHERE id = ?').get(SEP_PARTNER_ID) as unknown as PartnerRow | undefined;
  if (existing) return existing;
  const { key, hash, prefix } = newApiKey();
  // Nobody logs in as this account; the password is random and discarded.
  db.prepare(
    'INSERT INTO partners(id, name, email, password_hash, api_key, api_key_hash, api_key_prefix, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(SEP_PARTNER_ID, 'SEP wallet users', 'sep-wallets@sandbox.invalid', hashPassword(randomBytes(32).toString('hex')), key, hash, prefix, nowIso());
  void hashApiKey;
  return db.prepare('SELECT * FROM partners WHERE id = ?').get(SEP_PARTNER_ID) as unknown as PartnerRow;
}

/** Anchor signing keypair: env ANCHOR_SIGNING_SECRET, else generated once and kept in the DB. */
export function loadSigningKeypair(db: DB): Keypair {
  const fromEnv = process.env.ANCHOR_SIGNING_SECRET;
  if (fromEnv) return Keypair.fromSecret(fromEnv);
  let s = kvGet(db, 'anchor_signing_secret');
  if (!s) {
    s = Keypair.random().secret();
    kvSet(db, 'anchor_signing_secret', s);
  }
  return Keypair.fromSecret(s);
}

export function loadJwtSecret(db: DB): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) return fromEnv;
  let s = kvGet(db, 'jwt_secret');
  if (!s) {
    s = randomBytes(32).toString('hex');
    kvSet(db, 'jwt_secret', s);
  }
  return s;
}

/** Host part of PUBLIC_URL, e.g. "tr-mock-anchor.fly.dev" or "localhost:8787" (SEP-10 home/web-auth domain). */
export function homeDomainOf(cfg: Config): string {
  return new URL(cfg.publicUrl).host;
}

/**
 * A wallet user is identified by the SEP-10 `sub` (G..., G...:memo or M...). Each one maps to a
 * customer under the SEP partner. KYC is simulated: every wallet user is approved on creation and
 * no personal data is required. A deterministic sandbox IBAN stands in for the user's bank account
 * so simulated payouts have somewhere to go.
 */
export function ensureSepCustomer(db: DB, sub: string): CustomerRow {
  const found = db.prepare('SELECT * FROM customers WHERE partner_id = ? AND external_id = ?').get(SEP_PARTNER_ID, sub) as unknown as CustomerRow | undefined;
  if (found) return found;
  const digits = createHash('sha256').update(sub).digest('hex').replace(/\D/g, '').padEnd(16, '7').slice(0, 16);
  const ts = nowIso();
  const id = newId('cus');
  db.prepare(
    `INSERT INTO customers(id, partner_id, external_id, first_name, last_name, email, tckn, iban, kyc_status, deposit_reference, try_balance, usdc_balance, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, SEP_PARTNER_ID, sub, 'Wallet', `${sub.slice(0, 4)}…${sub.slice(-4)}`, null, null, makeTrIban('00099', digits), 'approved', makeDepositReference(), '0.00', '0.0000000', ts, ts);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as unknown as CustomerRow;
}

/** SEP-38 asset identifiers. */
export const TRY_ASSET = 'iso4217:TRY';
export const usdcAsset = (code: string, issuer: string) => `stellar:${code}:${issuer}`;
