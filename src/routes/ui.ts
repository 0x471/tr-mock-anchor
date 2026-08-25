/** Dashboard backend: email+password accounts, signed-cookie session, single API key per account. */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { parseBody } from '../validate.js';
import { unauthorized } from '../errors.js';
import { authenticate, createPartner, partnerOut, rotateApiKey } from '../core/partners.js';
import { clearSession, loadSessionSecret, readSession, setSession } from '../session.js';
import { SignupSchema } from './partners.js';

const LoginSchema = z.object({ email: z.email(), password: z.string().min(1) });

export function uiRoutes(deps: Deps) {
  const { db, cfg } = deps;
  const secret = loadSessionSecret(db);
  const secure = cfg.publicUrl.startsWith('https://');
  const app = new Hono<AppEnv>();

  app.post('/ui/signup', async (c) => {
    const body = await parseBody(c, SignupSchema);
    const row = createPartner(db, body);
    deps.log.info(`partner signed up ${row.id} (${row.email})`);
    setSession(c, secret, row.id, secure);
    return c.json(partnerOut(row, true), 201);
  });

  app.post('/ui/login', async (c) => {
    const body = await parseBody(c, LoginSchema);
    const row = authenticate(db, body.email, body.password);
    setSession(c, secret, row.id, secure);
    return c.json(partnerOut(row, true));
  });

  app.post('/ui/logout', (c) => {
    clearSession(c);
    return c.json({ ok: true });
  });

  app.get('/ui/me', (c) => {
    const p = readSession(c, secret, db);
    if (!p) throw unauthorized('Not logged in');
    return c.json(partnerOut(p, true));
  });

  app.post('/ui/rotate-key', (c) => {
    const p = readSession(c, secret, db);
    if (!p) throw unauthorized('Not logged in');
    return c.json(partnerOut(rotateApiKey(db, p.id), true));
  });

  return app;
}
