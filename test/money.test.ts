import { describe, expect, it } from 'vitest';
import { applySpread, fmtTry, fmtUsdc, parseRate, parseTry, parseUsdc, tryToUsdc, tryToUsdcCeil, usdcToTry, usdcToTryCeil } from '../src/money.js';

describe('money', () => {
  it('parses and formats fixed-point decimals', () => {
    expect(parseTry('1000')).toBe(100000n);
    expect(parseTry('1000.5')).toBe(100050n);
    expect(fmtTry(100050n)).toBe('1000.50');
    expect(parseUsdc('21.0526315')).toBe(210526315n);
    expect(fmtUsdc(210526315n)).toBe('21.0526315');
    expect(() => parseTry('1.234')).toThrow(/decimal places/);
    expect(() => parseTry('-1')).toThrow();
    expect(() => parseTry('abc')).toThrow();
  });

  it('converts TRY <-> USDC at a rate', () => {
    const rate = parseRate('47.500000');
    expect(fmtUsdc(tryToUsdc(parseTry('1000.00'), rate))).toBe('21.0526315');
    expect(fmtTry(usdcToTry(parseUsdc('21.0526315'), rate))).toBe('999.99'); // floor
    expect(fmtTry(usdcToTryCeil(parseUsdc('21.0526315'), rate))).toBe('1000.00');
    expect(fmtUsdc(tryToUsdcCeil(parseTry('1000.00'), rate))).toBe('21.0526316');
  });

  it('applies a symmetric spread', () => {
    const mid = parseRate('40.000000');
    expect(applySpread(mid, 50, 'buy')).toBe(parseRate('40.200000'));
    expect(applySpread(mid, 50, 'sell')).toBe(parseRate('39.800000'));
  });
});
