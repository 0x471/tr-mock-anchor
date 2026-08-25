/** Signed-cookie sessions for the dashboard. No external deps: HMAC-SHA256 over `partnerId.expiry`. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from './db.js';
import { kvGet, kvSet } from './db.js';
import type { PartnerRow } from './core/types.js';

export const SESSION_COOKIE = 'trma_session';
const TTL_SECONDS = 60 * 60 * 24 * 30;

export function loadSessionSecret(db: DB): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;
  let s = kvGet(db, 'session_secret');
  if (!s) {
    s = randomBytes(32).toString('hex');
    kvSet(db, 'session_secret', s);
  }
  return s;
}

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function setSession(c: Context, secret: string, partnerId: string, secure: boolean) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${partnerId}.${exp}`;
  setCookie(c, SESSION_COOKIE, `${payload}.${sign(secret, payload)}`, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: TTL_SECONDS,
  });
}

export function clearSession(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function readSession(c: Context, secret: string, db: DB): PartnerRow | null {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts as [string, string, string];
  const expected = sign(secret, `${id}.${exp}`);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return (db.prepare('SELECT * FROM partners WHERE id = ?').get(id) as PartnerRow | undefined) ?? null;
}
