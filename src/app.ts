import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv, Deps } from './context.js';
import { ApiError } from './errors.js';
import { MoneyError } from './money.js';
import { StellarError } from './stellar.js';
import { apiKeyAuth } from './auth.js';
import { publicRoutes } from './routes/public.js';
import { uiRoutes } from './routes/ui.js';
import { partnerRoutes } from './routes/partners.js';
import { customerRoutes } from './routes/customers.js';
import { quoteRoutes } from './routes/quotes.js';
import { onrampRoutes } from './routes/onramps.js';
import { offrampRoutes } from './routes/offramps.js';
import { payoutRoutes } from './routes/payouts.js';
import { webhookRoutes } from './routes/webhooks.js';
import { sandboxRoutes } from './routes/sandbox.js';
import { adminRoutes } from './routes/admin.js';
import { sep10Routes } from './routes/sep10.js';
import { sep6Routes } from './routes/sep6.js';
import { sep12Routes } from './routes/sep12.js';
import { sep38Routes } from './routes/sep38.js';
import { createSepContext, type SepContext } from './sepauth.js';

export function createApp(deps: Deps, sep: SepContext = createSepContext(deps)) {
  const app = new Hono<AppEnv>();

  // Sandbox: browsers may call this directly during hackathons. Keys are testnet-only.
  app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization'], exposeHeaders: ['X-Request-Id'] }));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, err.status as 400);
    }
    if (err instanceof MoneyError) return c.json({ error: { code: 'invalid_amount', message: err.message } }, 400);
    if (err instanceof StellarError) return c.json({ error: { code: 'stellar_error', message: err.message } }, 502);
    deps.log.error(`unhandled: ${err.stack ?? err.message}`);
    return c.json({ error: { code: 'internal_error', message: 'Internal error' } }, 500);
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: `No route for ${c.req.method} ${c.req.path}` } }, 404));

  // Everything under /v1 needs an API key, except account creation.
  const auth = apiKeyAuth(deps);
  app.use('/v1/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    if (c.req.path === '/v1/partners' && c.req.method === 'POST') return next();
    return auth(c, next);
  });

  app.route('/', adminRoutes(deps));
  app.route('/', publicRoutes(deps, sep));
  app.route('/', uiRoutes(deps));
  app.route('/', partnerRoutes(deps));
  app.route('/', customerRoutes(deps));
  app.route('/', quoteRoutes(deps));
  app.route('/', onrampRoutes(deps));
  app.route('/', offrampRoutes(deps));
  app.route('/', payoutRoutes(deps));
  app.route('/', webhookRoutes(deps));
  app.route('/', sandboxRoutes(deps));
  // SEP door: wallets authenticate with SEP-10 and use SEP-6 / SEP-12 / SEP-38.
  app.route('/', sep10Routes(deps, sep));
  app.route('/', sep6Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route('/', sep12Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route('/', sep38Routes(deps, sep) as unknown as Hono<AppEnv>);

  // Revalidate static assets every load so CSS/JS changes reach browsers immediately
  // (no Cache-Control previously meant browsers heuristically cached stale style.css / site.js).
  app.use('/static/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-cache');
  });
  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));

  return app;
}
