import type { MiddlewareHandler } from 'hono';
import { hashApiKey } from './ids.js';
import { unauthorized } from './errors.js';
import type { AppEnv, Deps } from './context.js';
import type { PartnerRow } from './core/types.js';

/** Accepts `X-API-Key: <key>` or `Authorization: Bearer <key>`. */
export function apiKeyAuth(deps: Deps): MiddlewareHandler<AppEnv> {
  const stmt = deps.db.prepare('SELECT * FROM partners WHERE api_key_hash = ?');
  return async (c, next) => {
    const raw = c.req.header('x-api-key') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const key = raw.trim();
    if (!key) throw unauthorized('Missing API key. Send it as X-API-Key or Authorization: Bearer. Create one with POST /v1/partners.');
    const partner = stmt.get(hashApiKey(key)) as PartnerRow | undefined;
    if (!partner) throw unauthorized('Unknown API key');
    c.set('partner', partner);
    await next();
  };
}
