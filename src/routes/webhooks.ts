import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Deps } from '../context.js';
import { newId, newWebhookSecret } from '../ids.js';
import { nowIso } from '../db.js';
import { parseBody, pageParams } from '../validate.js';
import { badRequest, notFound } from '../errors.js';
import { EVENT_TYPES } from '../core/events.js';
import { webhookOut } from '../core/serialize.js';
import type { EventRow, WebhookRow } from '../core/types.js';

const CreateWebhook = z.object({
  url: z.url(),
  events: z.array(z.string()).min(1).default(['*']),
});

export function webhookRoutes(deps: Deps) {
  const { db } = deps;
  const app = new Hono<AppEnv>();

  app.post('/v1/webhooks', async (c) => {
    const partner = c.get('partner');
    const body = await parseBody(c, CreateWebhook);
    const bad = body.events.filter((e) => e !== '*' && !(EVENT_TYPES as string[]).includes(e));
    if (bad.length) throw badRequest('unknown_event_type', `Unknown event types: ${bad.join(', ')}`, { allowed: ['*', ...EVENT_TYPES] });
    const row: WebhookRow = {
      id: newId('wh'),
      partner_id: partner.id,
      url: body.url,
      events: JSON.stringify(body.events),
      secret: newWebhookSecret(),
      active: 1,
      created_at: nowIso(),
    };
    db.prepare('INSERT INTO webhooks(id, partner_id, url, events, secret, active, created_at) VALUES (?,?,?,?,?,1,?)').run(
      row.id, row.partner_id, row.url, row.events, row.secret, row.created_at,
    );
    return c.json(
      {
        ...webhookOut(row, row.secret),
        signature_scheme: 'X-TRMA-Signature: t=<unix_seconds>,v1=<hex hmac_sha256(secret, `${t}.${raw_body}`)>',
      },
      201,
    );
  });

  app.get('/v1/webhooks', (c) => {
    const rows = db.prepare('SELECT * FROM webhooks WHERE partner_id = ? ORDER BY created_at DESC').all(c.get('partner').id) as unknown as WebhookRow[];
    return c.json({ data: rows.map((w) => webhookOut(w)) });
  });

  app.delete('/v1/webhooks/:id', (c) => {
    const res = db.prepare('DELETE FROM webhooks WHERE id = ? AND partner_id = ?').run(c.req.param('id'), c.get('partner').id);
    if (!res.changes) throw notFound('webhook');
    return c.body(null, 204);
  });

  app.get('/v1/webhooks/:id/deliveries', (c) => {
    const hook = db.prepare('SELECT id FROM webhooks WHERE id = ? AND partner_id = ?').get(c.req.param('id'), c.get('partner').id);
    if (!hook) throw notFound('webhook');
    const { limit, offset } = pageParams(c);
    const rows = db
      .prepare(
        `SELECT id, event_id, event_type, attempts, status, last_status_code, last_error, next_attempt_at, created_at, delivered_at
         FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(c.req.param('id'), limit, offset);
    return c.json({ data: rows, limit, offset });
  });

  // Pollable event log (alternative to webhooks).
  app.get('/v1/events', (c) => {
    const partner = c.get('partner');
    const { limit } = pageParams(c);
    const type = c.req.query('type') ?? null;
    const after = c.req.query('after') ?? null; // event id cursor
    let afterTs: string | null = null;
    if (after) {
      const ev = db.prepare('SELECT created_at FROM events WHERE id = ? AND partner_id = ?').get(after, partner.id) as { created_at: string } | undefined;
      if (!ev) throw notFound('event (after cursor)');
      afterTs = ev.created_at;
    }
    const rows = db
      .prepare(
        `SELECT * FROM events WHERE partner_id = ? AND (? IS NULL OR type = ?) AND (? IS NULL OR created_at > ?)
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(partner.id, type, type, afterTs, afterTs, limit) as unknown as EventRow[];
    return c.json({ data: rows.map((r) => JSON.parse(r.payload)), next_after: rows.length ? rows[rows.length - 1]!.id : after, event_types: EVENT_TYPES });
  });

  return app;
}
