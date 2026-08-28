/**
 * SEP-12 KYC — simulated. Every wallet user is ACCEPTED as soon as they authenticate and no field is
 * required. Optional fields a wallet sends (name, email, bank account) are stored; identity numbers are
 * deliberately dropped so the sandbox never holds real personal data.
 */
import { Hono, type Context } from 'hono';
import type { Deps } from '../context.js';
import { nowIso } from '../db.js';
import { isValidTrIban, normalizeIban } from '../turkey.js';
import { ensureSepCustomer } from '../core/sep.js';
import { sepError, sepJwtAuth, type SepContext, type SepEnv } from '../sepauth.js';
import type { CustomerRow } from '../core/types.js';

const OPTIONAL_FIELDS: Record<string, { type: string; description: string }> = {
  first_name: { type: 'string', description: 'First name (optional in this sandbox)' },
  last_name: { type: 'string', description: 'Last name (optional in this sandbox)' },
  email_address: { type: 'string', description: 'Email (optional in this sandbox)' },
  bank_account_number: { type: 'string', description: 'Turkish IBAN for TRY payouts (optional; a sandbox IBAN is used otherwise)' },
  bank_name: { type: 'string', description: 'Bank name (optional)' },
};

export function sep12Routes(deps: Deps, sep: SepContext) {
  const { db } = deps;
  const app = new Hono<SepEnv>();
  app.use('/sep12/*', sepJwtAuth(deps, sep));

  const customerOut = (c: CustomerRow) => {
    const provided: Record<string, unknown> = {};
    const isPlaceholder = c.first_name === 'Wallet';
    if (!isPlaceholder) {
      provided.first_name = { ...OPTIONAL_FIELDS.first_name, status: 'ACCEPTED' };
      provided.last_name = { ...OPTIONAL_FIELDS.last_name, status: 'ACCEPTED' };
    }
    if (c.email) provided.email_address = { ...OPTIONAL_FIELDS.email_address, status: 'ACCEPTED' };
    if (c.iban) provided.bank_account_number = { ...OPTIONAL_FIELDS.bank_account_number, status: 'ACCEPTED' };
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(OPTIONAL_FIELDS)) if (!(k in provided)) fields[k] = { ...v, optional: true };
    const registered = !!c.sep12_registered;
    return {
      // SEP-12: a customer the anchor has not collected anything for has no id yet.
      ...(registered ? { id: c.id } : {}),
      status: registered ? 'ACCEPTED' : 'NEEDS_INFO',
      message: registered
        ? 'Sandbox KYC: accepted. No personal data was required.'
        : 'Sandbox KYC: send any PUT /customer (all fields optional) to be accepted. No personal data is required.',
      fields,
      provided_fields: provided,
    };
  };

  /** Resolve the customer a request refers to: by `id`, or by the token subject (+ optional memo override). */
  function resolve(c: Context<SepEnv>): CustomerRow | null {
    const id = c.req.query('id');
    const me = c.get('sepCustomer');
    if (id) {
      const row = db.prepare('SELECT * FROM customers WHERE id = ? AND partner_id = ?').get(id, me.partner_id) as unknown as CustomerRow | undefined;
      return row ?? null;
    }
    const account = c.req.query('account');
    const memo = c.req.query('memo');
    if (account || memo) {
      const base = (account ?? c.get('sepSub').split(':')[0])!;
      return ensureSepCustomer(db, memo ? `${base}:${memo}` : base);
    }
    return me;
  }

  app.get('/sep12/customer', (c) => {
    const row = resolve(c);
    if (!row) return sepError(c, 404, 'customer not found');
    return c.json(customerOut(row));
  });

  app.put('/sep12/customer', async (c) => {
    const ct = c.req.header('content-type') ?? '';
    let body: Record<string, unknown> = {};
    try {
      body = ct.includes('application/json') ? ((await c.req.json()) as Record<string, unknown>) : ((await c.req.parseBody()) as Record<string, unknown>);
    } catch {
      return sepError(c, 400, 'could not parse request body');
    }
    let row: CustomerRow | null;
    if (typeof body.id === 'string') {
      row = (db.prepare('SELECT * FROM customers WHERE id = ? AND partner_id = ?').get(body.id, c.get('sepCustomer').partner_id) as unknown as CustomerRow | undefined) ?? null;
      if (!row) return sepError(c, 404, 'customer not found');
    } else {
      const base = typeof body.account === 'string' && body.account ? body.account : c.get('sepSub').split(':')[0]!;
      const memo = typeof body.memo === 'string' && body.memo ? body.memo : c.get('sepSub').split(':')[1];
      row = ensureSepCustomer(db, memo ? `${base}:${memo}` : base);
    }
    const str = (k: string) => (typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string).trim() : undefined);
    let iban = row.iban;
    if (str('bank_account_number')) {
      const candidate = normalizeIban(str('bank_account_number')!);
      if (!isValidTrIban(candidate)) return sepError(c, 400, 'bank_account_number must be a valid Turkish IBAN (TR + 24 digits)');
      iban = candidate;
    }
    const first = str('first_name') ?? str('given_name') ?? row.first_name;
    const last = str('last_name') ?? str('family_name') ?? row.last_name;
    const email = str('email_address') ?? row.email;
    db.prepare('UPDATE customers SET first_name = ?, last_name = ?, email = ?, iban = ?, sep12_registered = 1, updated_at = ? WHERE id = ?').run(first, last, email, iban, nowIso(), row.id);
    // tax_id, id_number, birth_date, photos etc. are intentionally not stored.
    return c.json({ id: row.id }, 202);
  });

  app.put('/sep12/customer/callback', async (c) => {
    let url: string | undefined;
    try {
      const body = (c.req.header('content-type') ?? '').includes('application/json') ? ((await c.req.json()) as Record<string, unknown>) : ((await c.req.parseBody()) as Record<string, unknown>);
      url = typeof body.url === 'string' ? body.url : undefined;
    } catch {
      /* fallthrough */
    }
    if (!url) return sepError(c, 400, "'url' is required");
    db.prepare('UPDATE customers SET kyc_callback_url = ?, updated_at = ? WHERE id = ?').run(url, nowIso(), c.get('sepCustomer').id);
    return c.json({});
  });

  app.delete('/sep12/customer/:account', async (c) => {
    const account = c.req.param('account');
    const me = c.get('sepSub');
    if (account !== me.split(':')[0]) return c.json({ error: 'you can only delete your own customer records' }, 404);
    let memo: string | undefined;
    try {
      const body = (await c.req.text()).trim();
      if (body) {
        const parsed = (c.req.header('content-type') ?? '').includes('application/json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
        memo = typeof parsed.memo === 'string' ? parsed.memo : undefined;
      }
    } catch {
      /* no body */
    }
    const sub = memo ? `${account}:${memo}` : me.includes(':') && !memo ? me : account;
    const row = db.prepare('SELECT * FROM customers WHERE partner_id = ? AND external_id = ?').get(c.get('sepCustomer').partner_id, sub) as unknown as CustomerRow | undefined;
    if (!row) return sepError(c, 404, 'customer not found');
    // Forget everything optional the wallet sent; the balance/ledger history stays for the sandbox.
    db.prepare("UPDATE customers SET first_name = 'Wallet', last_name = ?, email = NULL, kyc_callback_url = NULL, sep12_registered = 0, updated_at = ? WHERE id = ?").run(
      `${sub.slice(0, 4)}…${sub.slice(-4)}`, nowIso(), row.id,
    );
    return c.json({});
  });

  app.all('/sep12/customer/files', (c) => c.json({ error: 'file uploads are not supported in this sandbox' }, 404));

  return app;
}
