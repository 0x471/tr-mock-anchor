import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomString(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}

export const newId = (prefix: string) => `${prefix}_${randomString(20)}`;

/** Sandbox API key. Shown once at creation; only its SHA-256 is stored. */
export function newApiKey(): { key: string; hash: string; prefix: string } {
  const key = `trma_test_${randomString(32)}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, 16) };
}

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** 12-digit numeric memo id (fits uint64, easy to copy by hand). */
export function newMemoId(): string {
  const n = randomBytes(6).readUIntBE(0, 6) % 900_000_000_000;
  return String(100_000_000_000 + n);
}

export const newWebhookSecret = () => `whsec_${randomString(40)}`;
export const newBankReference = () => `FAST-${randomString(10).toUpperCase()}`;
