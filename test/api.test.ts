import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createFakeGateway } from '../src/stellar.js';
import { createRateService } from '../src/rates.js';
import { createLogger, type Deps } from '../src/context.js';
import { createApp } from '../src/app.js';
import { createWorkers } from '../src/workers.js';

const cfg = { ...config, stellarMode: 'fake' as const, rateSource: 'static' as const, staticUsdTry: '40.00', spreadBps: 50, dbPath: ':memory:' };
const db = openDb(':memory:');
const stellar = createFakeGateway(cfg);
const deps: Deps = { cfg, db, stellar, rates: createRateService(cfg), log: createLogger(true) };
const app = createApp(deps);
const workers = createWorkers(deps);

let key = '';
const H = () => ({ 'content-type': 'application/json', 'x-api-key': key });
const req = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
  const res = await app.request(path, { method, headers: headers ?? H(), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};

describe('api flow', () => {
  it('rejects requests without a key', async () => {
    const r = await req('GET', '/v1/customers', undefined, {});
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('unauthorized');
  });

  it('creates an account with a single API key, and rejects duplicate emails', async () => {
    const r = await req('POST', '/v1/partners', { email: 'Dev@Example.com', password: 'hunter22hunter', name: 'Dev' }, { 'content-type': 'application/json' });
    expect(r.status).toBe(201);
    expect(r.json.api_key).toMatch(/^trma_test_/);
    key = r.json.api_key;
    const dup = await req('POST', '/v1/partners', { email: 'dev@example.com', password: 'hunter22hunter' }, { 'content-type': 'application/json' });
    expect(dup.status).toBe(409);
    const me = await req('GET', '/v1/partners/me');
    expect(me.json.email).toBe('dev@example.com');
    expect(me.json.api_key).toBeUndefined();
  });

  it('dashboard login returns the same key via a session cookie', async () => {
    const login = await app.request('/ui/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com', password: 'hunter22hunter' }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('trma_session=');
    const me = await app.request('/ui/me', { headers: { cookie: cookie.split(';')[0]! } });
    expect(((await me.json()) as { api_key: string }).api_key).toBe(key);
    const bad = await app.request('/ui/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com', password: 'wrong-password' }) });
    expect(bad.status).toBe(401);
  });

  let customerId = '';
  let reference = '';
  it('creates a customer with deposit instructions', async () => {
    const bad = await req('POST', '/v1/customers', { first_name: 'A', last_name: 'B', tckn: '12345678901' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_tckn');
    const r = await req('POST', '/v1/customers', { external_id: 'u1', first_name: 'Ayşe', last_name: 'Yılmaz', tckn: '10000000146', iban: 'TR33 0006 1005 1978 6457 8413 26' });
    expect(r.status).toBe(201);
    expect(r.json.kyc_status).toBe('approved');
    expect(r.json.iban).toBe('TR330006100519786457841326');
    customerId = r.json.id;
    reference = r.json.deposit_reference;
    const di = await req('GET', `/v1/customers/${customerId}/deposit-instructions`);
    expect(di.json.reference).toBe(reference);
    expect(di.json.iban).toMatch(/^TR\d{24}$/);
    const dup = await req('POST', '/v1/customers', { external_id: 'u1', first_name: 'X', last_name: 'Y' });
    expect(dup.status).toBe(409);
  });

  it('blocks on-ramps for unapproved KYC and insufficient balance', async () => {
    const rej = await req('POST', '/v1/customers', { first_name: 'REJECT', last_name: 'Me' });
    expect(rej.json.kyc_status).toBe('rejected');
    const r1 = await req('POST', '/v1/onramps', { customer_id: rej.json.id, amount_try: '100.00', destination_address: Keypair.random().publicKey() });
    expect(r1.json.error.code).toBe('kyc_not_approved');
    const r2 = await req('POST', '/v1/onramps', { customer_id: customerId, amount_try: '100.00', destination_address: Keypair.random().publicKey() });
    expect(r2.status).toBe(422);
    expect(r2.json.error.code).toBe('insufficient_balance');
  });

  it('simulates a TRY bank transfer matched by reference, and holds unmatched ones', async () => {
    const um = await req('POST', '/v1/sandbox/bank-transfers', { reference: 'TRMA-NOPE-NOPE', amount_try: '5.00' });
    expect(um.status).toBe(202);
    expect(um.json.status).toBe('unmatched');
    const assign = await req('POST', `/v1/sandbox/bank-transfers/${um.json.id}/assign`, { customer_id: customerId });
    expect(assign.json.status).toBe('matched');
    const r = await req('POST', '/v1/sandbox/bank-transfers', { reference: reference.toLowerCase(), amount_try: '1000.00', sender_name: 'Ayşe Yılmaz' });
    expect(r.status).toBe(201);
    const bal = await req('GET', `/v1/customers/${customerId}/balances`);
    expect(bal.json.balances.TRY).toBe('1005.00');
  });

  let onrampId = '';
  const wallet = Keypair.random().publicKey();
  it('quotes and creates an on-ramp that the worker settles on (fake) Stellar', async () => {
    const q = await req('POST', '/v1/quotes', { customer_id: customerId, side: 'buy', amount: '1000.00', amount_currency: 'TRY' });
    expect(q.status).toBe(201);
    expect(q.json.rate).toBe('40.200000'); // 40 + 50bps
    expect(q.json.destination_amount).toBe('24.8756218');
    const o = await req('POST', '/v1/onramps', { customer_id: customerId, quote_id: q.json.id, destination_address: wallet, memo: 'hi' });
    expect(o.status).toBe(201);
    expect(o.json.status).toBe('pending');
    onrampId = o.json.id;
    const reuse = await req('POST', '/v1/onramps', { customer_id: customerId, quote_id: q.json.id, destination_address: wallet });
    expect(reuse.json.error.code).toBe('quote_consumed');
    const bal = await req('GET', `/v1/customers/${customerId}/balances`);
    expect(bal.json.balances.TRY).toBe('5.00');

    expect(await workers.settleOnrampsOnce()).toBe(1);
    const done = await req('GET', `/v1/onramps/${onrampId}`);
    expect(done.json.status).toBe('completed');
    expect(done.json.settlement).toBe('payment');
    expect(done.json.stellar_tx_hash).toHaveLength(64);
    expect(stellar.sent[0]).toMatchObject({ destination: wallet, amount: '24.8756218', memo: 'hi' });
  });

  it('uses a claimable balance when the destination has no trustline', async () => {
    const noTrust = Keypair.random().publicKey();
    stellar.markNoTrustline(noTrust);
    await req('POST', '/v1/sandbox/bank-transfers', { customer_id: customerId, amount_try: '100.00' });
    const o = await req('POST', '/v1/onramps', { customer_id: customerId, amount_try: '100.00', destination_address: noTrust });
    expect(o.status).toBe(201);
    await workers.settleOnrampsOnce();
    const done = await req('GET', `/v1/onramps/${o.json.id}`);
    expect(done.json.settlement).toBe('claimable_balance');
    expect(done.json.claimable_balance_id).toBeTruthy();
  });

  it('refunds TRY when a send fails for good', async () => {
    const poor = createFakeGateway(cfg, '0.0000000');
    const w2 = createWorkers({ ...deps, stellar: poor });
    await req('POST', '/v1/sandbox/bank-transfers', { customer_id: customerId, amount_try: '60.00' });
    const before = (await req('GET', `/v1/customers/${customerId}/balances`)).json.balances.TRY;
    const o = await req('POST', '/v1/onramps', { customer_id: customerId, amount_try: '60.00', destination_address: Keypair.random().publicKey() });
    await w2.settleOnrampsOnce(); // treasury_low -> stays pending
    let cur = await req('GET', `/v1/onramps/${o.json.id}`);
    expect(cur.json.status).toBe('pending');
    expect(cur.json.pending_reason).toBe('treasury_low');
    // Force a non-retryable failure path by making the fake think it has funds but fail the send.
    db.prepare("UPDATE onramps SET amount_usdc = '0.0000001' WHERE id = ?").run(o.json.id);
    (poor as unknown as { sendUsdc: () => Promise<never> }).sendUsdc = async () => {
      const { StellarError } = await import('../src/stellar.js');
      throw new StellarError('submit failed: op_no_destination', false);
    };
    db.prepare("UPDATE onramps SET amount_usdc = '0.0000000' WHERE id = ?").run(o.json.id);
    await w2.settleOnrampsOnce();
    cur = await req('GET', `/v1/onramps/${o.json.id}`);
    expect(cur.json.status).toBe('failed');
    const after = (await req('GET', `/v1/customers/${customerId}/balances`)).json.balances.TRY;
    expect(after).toBe(before);
  });

  let offrampId = '';
  it('creates an off-ramp and completes it when USDC arrives with the memo', async () => {
    const o = await req('POST', '/v1/offramps', { customer_id: customerId, amount_usdc: '10.0000000' });
    expect(o.status).toBe(201);
    expect(o.json.status).toBe('awaiting_deposit');
    expect(o.json.deposit.address).toBe(stellar.treasuryPublicKey);
    expect(o.json.deposit.memo).toMatch(/^\d{12}$/);
    expect(o.json.rate).toBe('39.800000'); // 40 - 50bps
    offrampId = o.json.id;

    // A payment with the wrong memo is parked as unmatched.
    stellar.simulateIncoming({ amount: '1.0000000', memoId: '999999999999' });
    await workers.watchOfframpsOnce();
    const um = await req('GET', '/v1/sandbox/unmatched-deposits');
    expect(um.json.data[0].reason).toBe('no_matching_offramp');

    // The right memo: 12.5 USDC arrives (differs from the expected 10 -> we convert what arrived).
    const sim = await req('POST', '/v1/sandbox/usdc-deposits', { offramp_id: offrampId, amount_usdc: '12.5000000' });
    expect(sim.status).toBe(202);
    const before = (await req('GET', `/v1/customers/${customerId}/balances`)).json.balances.TRY;
    await workers.watchOfframpsOnce();
    const done = await req('GET', `/v1/offramps/${offrampId}`);
    expect(done.json.status).toBe('completed');
    expect(done.json.received_usdc).toBe('12.5000000');
    expect(done.json.amount_try).toBe('497.50'); // 12.5 * 39.8
    expect(done.json.payout_id).toMatch(/^po_/);
    const payout = await req('GET', `/v1/payouts/${done.json.payout_id}`);
    expect(payout.json.amount_try).toBe('497.50');
    expect(payout.json.iban).toBe('TR330006100519786457841326');
    // auto_payout: TRY balance unchanged net (credited then paid out)
    const after = (await req('GET', `/v1/customers/${customerId}/balances`)).json.balances.TRY;
    expect(after).toBe(before);
    const ledger = await req('GET', `/v1/customers/${customerId}/ledger`);
    expect(ledger.json.data.map((l: { kind: string }) => l.kind).slice(0, 4)).toEqual(['payout', 'offramp_convert', 'offramp_convert', 'offramp_deposit']);
  });

  it('does not process the same deposit twice and ignores deposits to cancelled off-ramps', async () => {
    const o = await req('POST', '/v1/offramps', { customer_id: customerId, auto_payout: false });
    await req('POST', `/v1/offramps/${o.json.id}/cancel`);
    stellar.simulateIncoming({ amount: '2.0000000', memoId: o.json.deposit.memo });
    await workers.watchOfframpsOnce();
    const um = await req('GET', '/v1/sandbox/unmatched-deposits');
    expect(um.json.data[0].reason).toBe('offramp_cancelled');
    expect(await workers.watchOfframpsOnce()).toBe(0);
  });

  it('exposes a pollable event log', async () => {
    const ev = await req('GET', '/v1/events?type=offramp.completed');
    expect(ev.json.data.length).toBe(1);
    expect(ev.json.data[0].data.id).toBe(offrampId);
    const all = await req('GET', '/v1/events?limit=3');
    const next = await req('GET', `/v1/events?after=${all.json.next_after}&limit=200`);
    expect(next.json.data.some((e: { id: string }) => e.id === all.json.data[0].id)).toBe(false);
  });

  describe('webhooks', () => {
    const received: Array<{ headers: Record<string, string>; body: string }> = [];
    let server: ReturnType<typeof createServer>;
    let url = '';
    beforeAll(async () => {
      server = createServer((rq, rs) => {
        let body = '';
        rq.on('data', (c) => (body += c));
        rq.on('end', () => {
          received.push({ headers: rq.headers as Record<string, string>, body });
          rs.writeHead(200).end('ok');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
    });
    afterAll(() => server.close());

    it('delivers signed events', async () => {
      const wh = await req('POST', '/v1/webhooks', { url, events: ['payout.completed'] });
      expect(wh.status).toBe(201);
      const secret = wh.json.secret as string;
      await req('POST', '/v1/payouts', { customer_id: customerId, amount_try: '1.00' });
      expect(await workers.deliverWebhooksOnce()).toBe(1);
      expect(received).toHaveLength(1);
      const d = received[0]!;
      expect(d.headers['x-trma-event']).toBe('payout.completed');
      const [t, v1] = d.headers['x-trma-signature']!.split(',').map((p) => p.split('=')[1]!);
      expect(createHmac('sha256', secret).update(`${t}.${d.body}`).digest('hex')).toBe(v1);
      expect(JSON.parse(d.body).data.amount_try).toBe('1.00');
      const dl = await req('GET', `/v1/webhooks/${wh.json.id}/deliveries`);
      expect(dl.json.data[0].status).toBe('delivered');
    });
  });

  it('serves public metadata', async () => {
    const h = await req('GET', '/health', undefined, {});
    expect(h.json.ok).toBe(true);
    expect(h.json.rates.mid_rate).toBe('40.000000');
    const toml = await app.request('/.well-known/stellar.toml');
    expect(await toml.text()).toContain(`ACCOUNTS=["${stellar.treasuryPublicKey}"]`);
    const spec = await req('GET', '/openapi.json', undefined, {});
    expect(spec.json.openapi).toBe('3.1.0');
    expect(Object.keys(spec.json.paths)).toContain('/v1/onramps');
  });
});
