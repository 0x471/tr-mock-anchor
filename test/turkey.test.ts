import { describe, expect, it } from 'vitest';
import { isValidIban, isValidTckn, isValidTrIban, makeDepositReference, makeTrIban, normalizeReference } from '../src/turkey.js';

describe('turkey', () => {
  it('generates and validates TR IBANs (mod 97)', () => {
    const iban = makeTrIban('00099', '0000000000000001');
    expect(iban).toMatch(/^TR\d{24}$/);
    expect(isValidTrIban(iban)).toBe(true);
    expect(isValidTrIban('TR330006100519786457841326')).toBe(true); // common documentation example
    expect(isValidTrIban('TR330006100519786457841327')).toBe(false);
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(isValidTrIban('GB82WEST12345698765432')).toBe(false);
  });

  it('validates T.C. Kimlik No', () => {
    expect(isValidTckn('10000000146')).toBe(true);
    expect(isValidTckn('10000000147')).toBe(false);
    expect(isValidTckn('00000000146')).toBe(false);
    expect(isValidTckn('1234567890')).toBe(false);
  });

  it('makes deposit references', () => {
    const ref = makeDepositReference();
    expect(ref).toMatch(/^TRMA-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(normalizeReference(' trma-abcd-efgh ')).toBe('TRMA-ABCD-EFGH');
  });
});
