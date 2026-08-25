import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { newApiKey, newId } from '../ids.js';
import { conflict, unauthorized } from '../errors.js';
import type { PartnerRow } from './types.js';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** One account per email, one API key per account. */
export function createPartner(db: DB, input: { email: string; password: string; name?: string }): PartnerRow {
  const email = normalizeEmail(input.email);
  const exists = db.prepare('SELECT id FROM partners WHERE email = ?').get(email);
  if (exists) throw conflict('email_taken', 'An account with this email already exists. Log in to see your API key.');
  const { key, hash, prefix } = newApiKey();
  const row: PartnerRow = {
    id: newId('prt'),
    name: input.name?.trim() || email.split('@')[0]!,
    email,
    password_hash: hashPassword(input.password),
    api_key: key,
    api_key_hash: hash,
    api_key_prefix: prefix,
    created_at: nowIso(),
    key_rotated_at: null,
  };
  db.prepare(
    'INSERT INTO partners(id, name, email, password_hash, api_key, api_key_hash, api_key_prefix, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(row.id, row.name, row.email, row.password_hash, row.api_key, row.api_key_hash, row.api_key_prefix, row.created_at);
  return row;
}

export function authenticate(db: DB, email: string, password: string): PartnerRow {
  const row = db.prepare('SELECT * FROM partners WHERE email = ?').get(normalizeEmail(email)) as PartnerRow | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) throw unauthorized('Invalid email or password');
  return row;
}

export function rotateApiKey(db: DB, partnerId: string): PartnerRow {
  const { key, hash, prefix } = newApiKey();
  const ts = nowIso();
  db.prepare('UPDATE partners SET api_key = ?, api_key_hash = ?, api_key_prefix = ?, key_rotated_at = ? WHERE id = ?').run(key, hash, prefix, ts, partnerId);
  return db.prepare('SELECT * FROM partners WHERE id = ?').get(partnerId) as unknown as PartnerRow;
}

export const partnerOut = (p: PartnerRow, includeKey: boolean) => ({
  id: p.id,
  name: p.name,
  email: p.email,
  api_key_prefix: p.api_key_prefix,
  ...(includeKey ? { api_key: p.api_key } : {}),
  created_at: p.created_at,
  key_rotated_at: p.key_rotated_at,
});
