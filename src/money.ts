/**
 * Fixed-point money math on bigint. No floats anywhere near balances.
 *  - TRY  : 2 decimals (kuruş)
 *  - USDC : 7 decimals (stroops, Stellar's native precision)
 *  - rates: 6 decimals (TRY per 1 USD)
 */
export const TRY_DECIMALS = 2;
export const USDC_DECIMALS = 7;
export const RATE_DECIMALS = 6;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const pow10 = (n: number) => 10n ** BigInt(n);

/** Parse a non-negative decimal string into a scaled bigint. Rejects excess precision. */
export function parseDecimal(input: string | number, decimals: number, label = 'amount'): bigint {
  const s = String(input).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new MoneyError(`${label} must be a non-negative decimal string`);
  const [whole, frac = ''] = s.split('.') as [string, string?];
  if (frac.length > decimals) throw new MoneyError(`${label} supports at most ${decimals} decimal places`);
  return BigInt(whole) * pow10(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
}

export function formatDecimal(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const scale = pow10(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0');
  return `${neg ? '-' : ''}${whole}${decimals > 0 ? '.' + frac : ''}`;
}

export const parseTry = (v: string | number, label = 'amount_try') => parseDecimal(v, TRY_DECIMALS, label);
export const parseUsdc = (v: string | number, label = 'amount_usdc') => parseDecimal(v, USDC_DECIMALS, label);
export const parseRate = (v: string | number, label = 'rate') => parseDecimal(v, RATE_DECIMALS, label);
export const fmtTry = (v: bigint) => formatDecimal(v, TRY_DECIMALS);
export const fmtUsdc = (v: bigint) => formatDecimal(v, USDC_DECIMALS);
export const fmtRate = (v: bigint) => formatDecimal(v, RATE_DECIMALS);

/**
 * TRY (kuruş) -> USDC (stroops) at `rate` TRY per USD.
 * usdc = try / rate  =>  stroops = kurus * 10^(7-2) * 10^6 / rateMicro = kurus * 10^11 / rateMicro
 */
export function tryToUsdc(kurus: bigint, rateMicro: bigint): bigint {
  if (rateMicro <= 0n) throw new MoneyError('rate must be positive');
  return (kurus * pow10(USDC_DECIMALS - TRY_DECIMALS + RATE_DECIMALS)) / rateMicro;
}

/** USDC (stroops) -> TRY (kuruş) at `rate` TRY per USD. Floors to the kuruş. */
export function usdcToTry(stroops: bigint, rateMicro: bigint): bigint {
  if (rateMicro <= 0n) throw new MoneyError('rate must be positive');
  return (stroops * rateMicro) / pow10(USDC_DECIMALS - TRY_DECIMALS + RATE_DECIMALS);
}

export type Side = 'buy' | 'sell';

/**
 * Apply a symmetric spread to a mid rate.
 *  buy  = customer buys USDC with TRY  -> pays more TRY per USD  (rate up)
 *  sell = customer sells USDC for TRY  -> gets fewer TRY per USD (rate down)
 */
export function applySpread(midMicro: bigint, bps: number, side: Side): bigint {
  const b = BigInt(Math.round(bps));
  return side === 'buy' ? (midMicro * (10000n + b)) / 10000n : (midMicro * (10000n - b)) / 10000n;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Ceiling variants: used when the customer fixes the *destination* amount and we solve for the source. */
export function tryToUsdcCeil(kurus: bigint, rateMicro: bigint): bigint {
  if (rateMicro <= 0n) throw new MoneyError('rate must be positive');
  return ceilDiv(kurus * pow10(USDC_DECIMALS - TRY_DECIMALS + RATE_DECIMALS), rateMicro);
}
export function usdcToTryCeil(stroops: bigint, rateMicro: bigint): bigint {
  if (rateMicro <= 0n) throw new MoneyError('rate must be positive');
  return ceilDiv(stroops * rateMicro, pow10(USDC_DECIMALS - TRY_DECIMALS + RATE_DECIMALS));
}
