import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv, Deps } from './context.js';
import { ApiError } from './errors.js';
import { MoneyError } from './money.js';
import { StellarError } from './stellar.js';
import { publicRoutes } from './routes/public.js';
import { adminRoutes } from './routes/admin.js';
import { sep10Routes } from './routes/sep10.js';
import { sep6Routes } from './routes/sep6.js';
import { sep12Routes } from './routes/sep12.js';
import { sep38Routes } from './routes/sep38.js';
import { createSepContext, type SepContext } from './sepauth.js';

// This mock exposes a single, standard door: SEP-1 discovery, SEP-10 auth, SEP-6 deposit/withdraw,
// SEP-12 (simulated) KYC, SEP-38 quotes (TRY <-> USDC). That is the surface a real Turkish anchor
// (BiLira) will expose, so an integration built here moves to production by changing only the
// network and the home domain.
export function createApp(deps: Deps, sep: SepContext = createSepContext(deps)) {
  const app = new Hono<AppEnv>();

  // Sandbox: wallets/dApps call these directly from the browser. Testnet only.
  app.use('*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'], exposeHeaders: ['X-Request-Id'] }));

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

  app.route('/', adminRoutes(deps));
  app.route('/', publicRoutes(deps, sep));
  // SEP door: wallets authenticate with SEP-10 and use SEP-6 / SEP-12 / SEP-38.
  app.route('/', sep10Routes(deps, sep));
  app.route('/', sep6Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route('/', sep12Routes(deps, sep) as unknown as Hono<AppEnv>);
  app.route('/', sep38Routes(deps, sep) as unknown as Hono<AppEnv>);

  // Revalidate static assets every load so CSS/JS changes reach browsers immediately.
  app.use('/static/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-cache');
  });
  app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }));

  return app;
}
