/**
 * Events are written to the `events` table as an internal audit trail (visible in the read-only
 * /admin viewer). They record every state change in the ramp lifecycle.
 */
import type { DB } from '../db.js';
import { nowIso } from '../db.js';
import { newId } from '../ids.js';
import type { WebhookRow } from './types.js';

export type EventType =
  | 'customer.created'
  | 'customer.kyc_updated'
  | 'bank_transfer.received'
  | 'bank_transfer.unmatched'
  | 'onramp.created'
  | 'onramp.completed'
  | 'onramp.failed'
  | 'offramp.created'
  | 'offramp.deposit_received'
  | 'offramp.completed'
  | 'payout.completed';

export const EVENT_TYPES: EventType[] = [
  'customer.created',
  'customer.kyc_updated',
  'bank_transfer.received',
  'bank_transfer.unmatched',
  'onramp.created',
  'onramp.completed',
  'onramp.failed',
  'offramp.created',
  'offramp.deposit_received',
  'offramp.completed',
  'payout.completed',
];

/** Must be called inside tx() alongside the state change it describes. */
export function emitEvent(db: DB, partnerId: string, type: EventType, data: unknown): string {
  const id = newId('evt');
  const created_at = nowIso();
  const payload = JSON.stringify({ id, type, created_at, data });
  db.prepare('INSERT INTO events(id, partner_id, type, payload, created_at) VALUES (?,?,?,?,?)').run(id, partnerId, type, payload, created_at);

  const hooks = db.prepare('SELECT * FROM webhooks WHERE partner_id = ? AND active = 1').all(partnerId) as unknown as WebhookRow[];
  for (const h of hooks) {
    const wanted = JSON.parse(h.events) as string[];
    if (!(wanted.includes('*') || wanted.includes(type))) continue;
    db.prepare(
      `INSERT INTO webhook_deliveries(id, webhook_id, event_id, event_type, payload, attempts, status, next_attempt_at, created_at)
       VALUES (?,?,?,?,?,0,'pending',?,?)`,
    ).run(newId('whd'), h.id, id, type, payload, created_at, created_at);
  }
  return id;
}
