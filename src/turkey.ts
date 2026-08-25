/** Turkish banking helpers: IBAN (TR + 24 digits), T.C. Kimlik No, deposit references. */
import { randomBytes } from 'node:crypto';

const letterToDigits = (c: string) => String(c.charCodeAt(0) - 55); // A=10 ... Z=35

function mod97(numeric: string): number {
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rem;
}

export function normalizeIban(iban: string): string {
  return iban.replace(/\s+/g, '').toUpperCase();
}

export function isValidIban(input: string): boolean {
  const s = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  const numeric = rearranged
    .split('')
    .map((c) => (/[A-Z]/.test(c) ? letterToDigits(c) : c))
    .join('');
  return mod97(numeric) === 1;
}

/** Turkish IBAN: TR + 2 check digits + 5-digit bank code + 1 reserved digit + 16-digit account = 26 chars. */
export function isValidTrIban(input: string): boolean {
  const s = normalizeIban(input);
  return /^TR\d{24}$/.test(s) && isValidIban(s);
}

export function makeTrIban(bankCode: string, account: string): string {
  if (!/^\d{5}$/.test(bankCode)) throw new Error('bankCode must be 5 digits');
  if (!/^\d{16}$/.test(account)) throw new Error('account must be 16 digits');
  const bban = bankCode + '0' + account;
  const numeric = bban + letterToDigits('T') + letterToDigits('R') + '00';
  const check = String(98 - mod97(numeric)).padStart(2, '0');
  return `TR${check}${bban}`;
}

export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})/g, '$1 ').trim();
}

/** T.C. Kimlik No checksum (11 digits, first digit non-zero). */
export function isValidTckn(input: string): boolean {
  const s = String(input).trim();
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  const d = s.split('').map(Number) as number[];
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const d10 = (odd * 7 - even) % 10;
  if ((d10 + 10) % 10 !== d[9]) return false;
  const d11 = d.slice(0, 10).reduce((a, b) => a + b, 0) % 10;
  return d11 === d[10];
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Deposit reference the customer writes in the bank transfer description ("açıklama"). */
export function makeDepositReference(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  return `TRMA-${out.slice(0, 4)}-${out.slice(4)}`;
}

export function normalizeReference(ref: string): string {
  return ref.trim().toUpperCase().replace(/\s+/g, '');
}
