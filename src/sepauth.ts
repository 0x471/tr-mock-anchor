import type { Context, MiddlewareHandler } from 'hono';
import type { Keypair } from '@stellar/stellar-sdk';
import type { AppEnv, Deps } from './context.js';
import { verifyJwt } from './jwt.js';
import { ensureSepCustomer, ensureSepPartner, homeDomainOf, loadJwtSecret, loadSigningKeypair } from './core/sep.js';
import type { CustomerRow, PartnerRow } from './core/types.js';

export interface SepContext {
  partner: PartnerRow;
  signingKeypair: Keypair;
  jwtSecret: string;
  homeDomain: string;
}

export function createSepContext(deps: Deps): SepContext {
  return {
    partner: ensureSepPartner(deps.db),
    signingKeypair: loadSigningKeypair(deps.db),
    jwtSecret: loadJwtSecret(deps.db),
    homeDomain: homeDomainOf(deps.cfg),
  };
}

export type SepEnv = AppEnv & { Variables: { sepSub: string; sepCustomer: CustomerRow } };

/** SEP-10 bearer auth. Failures use the SEP-6 error shape `{"type":"authentication_required"}` (HTTP 403). */
export function sepJwtAuth(deps: Deps, sep: SepContext): MiddlewareHandler<SepEnv> {
  return async (c, next) => {
    const raw = c.req.header('authorization') ?? '';
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    const claims = token ? verifyJwt(token, sep.jwtSecret) : null;
    if (!claims) return c.json({ type: 'authentication_required', error: 'missing or invalid SEP-10 token' }, 403);
    c.set('sepSub', claims.sub);
    c.set('sepCustomer', ensureSepCustomer(deps.db, claims.sub));
    await next();
  };
}

/** Base Stellar account of a SEP-10 subject (`G...`, `G...:memo` or `M...`). */
export function subAccount(sub: string): string {
  return sub.split(':')[0]!;
}

export const sepError = (c: Context, status: 400 | 404, message: string) => c.json({ error: message }, status);
