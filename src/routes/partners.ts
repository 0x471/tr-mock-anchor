import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { parseBody } from '../validate.js';
import { apiKeyAuth } from '../auth.js';
import { createPartner, partnerOut, rotateApiKey } from '../core/partners.js';

export const SignupSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80).optional(),
});

export function partnerRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Programmatic signup (same account model as the web dashboard). One account per email, one key per account.
  app.post('/v1/partners', async (c) => {
    const body = await parseBody(c, SignupSchema);
    const row = createPartner(deps.db, body);
    deps.log.info(`partner created ${row.id} (${row.email})`);
    return c.json({ ...partnerOut(row, true), note: 'Send the api_key as X-API-Key on every request. Log in at the dashboard to see it again.' }, 201);
  });

  app.get('/v1/partners/me', apiKeyAuth(deps), (c) => c.json(partnerOut(c.get('partner'), false)));

  // Rotate the single API key. The old key stops working immediately.
  app.post('/v1/partners/me/rotate-key', apiKeyAuth(deps), (c) => {
    const row = rotateApiKey(deps.db, c.get('partner').id);
    return c.json(partnerOut(row, true));
  });

  return app;
}
