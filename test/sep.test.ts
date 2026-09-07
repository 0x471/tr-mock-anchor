import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createFakeGateway } from '../src/stellar.js';
import { createRateService } from '../src/rates.js';
import { createLogger, type Deps } from '../src/context.js';
import { createApp } from '../src/app.js';
import { createWorkers } from '../src/workers.js';
import { createSepContext } from '../src/sepauth.js';

const cfg = { ...config, publicUrl: 'http://localhost:8787', stellarMode: 'fake' as const, rateSource: 'static' as const, staticUsdTry: '40.00', spreadBps: 50, dbPath: ':memory:' };
const db = openDb(':memory:');
const stellar = createFakeGateway(cfg);
const deps: Deps = { cfg, db, stellar, rates: createRateService(cfg), log: createLogger(true) };
const sep = createSepContext(deps);
const app = createApp(deps, sep);
const workers = createWorkers(deps, sep);

const wallet = Keypair.random();
let token = '';
const auth = () => ({ authorization: `Bearer ${token}` });
const get = async (path: string, headers: Record<string, string> = auth()) => {
  const res = await app.request(path, { headers });
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text };
};

async function authenticate(kp: Keypair, memo?: string) {
  const ch = await get(`/auth?account=${kp.publicKey()}${memo ? `&memo=${memo}` : ''}`, {});
  expect(ch.status).toBe(200);
  const tx = TransactionBuilder.fromXdr(ch.json.transaction, Networks.TESTNET);
  tx.sign(kp);
  const res = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: tx.toXdr() }) });
  const body = await res.json();
  return { status: res.status, ...(body as { token?: string; error?: string }) };
}

describe('SEP door', () => {
  it('publishes a SEP-1 toml with the SEP endpoints and signing key', async () => {
    const toml = await (await app.request('/.well-known/stellar.toml')).text();
    expect(toml).toContain(`SIGNING_KEY="${sep.signingKeypair.publicKey()}"`);
    expect(toml).toContain('WEB_AUTH_ENDPOINT="http://localhost:8787/auth"');
    expect(toml).toContain('TRANSFER_SERVER="http://localhost:8787/sep6"');
    expect(toml).toContain('KYC_SERVER="http://localhost:8787/sep12"');
    expect(toml).toContain('ANCHOR_QUOTE_SERVER="http://localhost:8787/sep38"');
  });

  it('SEP-10: issues a challenge and a JWT for a client-signed challenge', async () => {
    const bad = await get('/auth?account=nope', {});
    expect(bad.status).toBe(400);
    const r = await authenticate(wallet);
    expect(r.status).toBe(200);
    expect(r.token).toBeTruthy();
    token = r.token!;
    const [, payload] = token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.sub).toBe(wallet.publicKey());
    expect(claims.iss).toBe('http://localhost:8787/auth');
  });

  it('SEP-10: rejects unsigned, wrongly signed and tampered challenges', async () => {
    const ch = await get(`/auth?account=${wallet.publicKey()}`, {});
    const unsigned = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: ch.json.transaction }) });
    expect(unsigned.status).toBe(400);
    const tx = TransactionBuilder.fromXdr(ch.json.transaction, Networks.TESTNET);
    tx.sign(Keypair.random());
    const wrong = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: tx.toXdr() }) });
    expect(wrong.status).toBe(400);
    const garbage = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: 'AAAA' }) });
    expect(garbage.status).toBe(400);
    const missing = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(400);
  });

  it('SEP-10: funded accounts are verified against their signers and threshold', async () => {
    const funded = Keypair.random();
    const signer2 = Keypair.random();
    stellar.registerAccount(funded.publicKey(), {
      signers: [{ key: funded.publicKey(), weight: 1, type: 'ed25519_public_key' }, { key: signer2.publicKey(), weight: 1, type: 'ed25519_public_key' }],
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
    });
    const ch = await get(`/auth?account=${funded.publicKey()}`, {});
    const one = TransactionBuilder.fromXdr(ch.json.transaction, Networks.TESTNET);
    one.sign(funded);
    const tooWeak = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: one.toXdr() }) });
    expect(tooWeak.status).toBe(400);
    one.sign(signer2);
    const ok = await app.request('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: one.toXdr() }) });
    expect(ok.status).toBe(200);
  });

  it('protects SEP endpoints with the token', async () => {
    const r = await get('/sep6/transactions?asset_code=USDC', {});
    expect(r.status).toBe(403);
    expect(r.json.type).toBe('authentication_required');
    const info = await get('/sep6/info', {});
    expect(info.status).toBe(200);
    expect(info.json.deposit.USDC.enabled).toBe(true);
    expect(info.json.withdraw.USDC.types.bank_account).toBeTruthy();
    expect(info.json.features.claimable_balances).toBe(true);
  });

  it('SEP-12: new wallet user is NEEDS_INFO with only optional fields, PUT accepts without personal data', async () => {
    const before = await get('/sep12/customer');
    expect(before.json.status).toBe('NEEDS_INFO');
    expect(Object.values(before.json.fields).every((f: any) => f.optional === true)).toBe(true);
    const put = await app.request('/sep12/customer', { method: 'PUT', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ email_address: 'w@example.com' }) });
    expect(put.status).toBe(202);
    const id = ((await put.json()) as { id: string }).id;
    const after = await get(`/sep12/customer?id=${id}`);
    expect(after.json.status).toBe('ACCEPTED');
    expect(after.json.provided_fields.email_address.status).toBe('ACCEPTED');
    // Identity numbers are dropped, not stored.
    const put2 = await app.request('/sep12/customer', { method: 'PUT', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ tax_id: '10000000146', bank_account_number: 'TR33 0006 1005 1978 6457 8413 26' }) });
    expect(put2.status).toBe(202);
    const row = db.prepare('SELECT tckn, iban FROM customers WHERE id = ?').get(id) as { tckn: string | null; iban: string };
    expect(row.tckn).toBeNull();
    expect(row.iban).toBe('TR330006100519786457841326');
    const badIban = await app.request('/sep12/customer', { method: 'PUT', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ bank_account_number: 'TR000' }) });
    expect(badIban.status).toBe(400);
  });

  it('SEP-12: memos distinguish customers on the same account, DELETE forgets', async () => {
    const a = await authenticate(wallet, '1');
    const b = await authenticate(wallet, '2');
    const reg = async (t: string) => ((await (await app.request('/sep12/customer', { method: 'PUT', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}' })).json()) as { id: string }).id;
    const ida = await reg(a.token!);
    const idb = await reg(b.token!);
    expect(ida).not.toBe(idb);
    const ca = await get('/sep12/customer', { authorization: `Bearer ${a.token}` });
    expect(ca.json.id).toBe(ida);
    expect(ca.json.status).toBe('ACCEPTED');
    const fresh = await get('/sep12/customer', { authorization: `Bearer ${(await authenticate(Keypair.random())).token}` });
    expect(fresh.json.id).toBeUndefined(); // no data collected yet -> no id, NEEDS_INFO
    const del = await app.request(`/sep12/customer/${wallet.publicKey()}`, { method: 'DELETE', headers: auth() });
    expect(del.status).toBe(200);
    const again = await get('/sep12/customer');
    expect(again.json.status).toBe('NEEDS_INFO');
  });

  let depositId = '';
  it('SEP-6 deposit: returns bank instructions, then the simulated transfer triggers a real on-ramp', async () => {
    const noAsset = await get(`/sep6/deposit?account=${wallet.publicKey()}`);
    expect(noAsset.status).toBe(400);
    const badAsset = await get(`/sep6/deposit?asset_code=XYZ&account=${wallet.publicKey()}`);
    expect(badAsset.status).toBe(400);
    const dep = await get(`/sep6/deposit?asset_code=USDC&account=${wallet.publicKey()}&funding_method=bank_account&amount=200.00&claimable_balance_supported=true`);
    expect(dep.status).toBe(200);
    expect(dep.json.id).toMatch(/^sep_/);
    expect(dep.json.how).toContain('TRMA-');
    expect(dep.json.instructions.bank_account_number.value).toMatch(/^TR\d{24}$/);
    expect(dep.json.instructions.external_transfer_memo.value).toMatch(/^TRMA-/);
    depositId = dep.json.id;

    let t = await get(`/sep6/transaction?id=${depositId}`);
    expect(t.json.transaction.status).toBe('pending_user_transfer_start');
    expect(t.json.transaction.kind).toBe('deposit');
    expect(t.json.transaction.to).toBe(wallet.publicKey());
    expect(t.json.transaction.amount_in).toBe('200.00');
    expect(t.json.transaction.more_info_url).toBe(`http://localhost:8787/sep6/tx/${depositId}`);

    const page = await app.request(`/sep6/tx/${depositId}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Simulate incoming TRY transfer');

    const fund = await app.request(`/sep6/tx/${depositId}/simulate-bank-transfer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '200.00' }) });
    expect(fund.status).toBe(200);
    t = await get(`/sep6/transaction?id=${depositId}`);
    expect(t.json.transaction.status).toBe('pending_anchor');
    const twice = await app.request(`/sep6/tx/${depositId}/simulate-bank-transfer`, { method: 'POST' });
    expect(twice.status).toBe(409);

    await workers.settleOnrampsOnce();
    t = await get(`/sep6/transaction?id=${depositId}`);
    expect(t.json.transaction.status).toBe('completed');
    expect(t.json.transaction.amount_out).toBe('4.9751243'); // 200 / 40.20
    expect(t.json.transaction.amount_fee).toBe('1.00'); // 200 - 4.9751243*40 = 0.995 -> 2dp
    expect(t.json.transaction.stellar_transaction_id).toHaveLength(64);
    expect(t.json.transaction.completed_at).toBeTruthy();
    const byHash = await get(`/sep6/transaction?stellar_transaction_id=${t.json.transaction.stellar_transaction_id}`);
    expect(byHash.json.transaction.id).toBe(depositId);
  });

  it('SEP-6 withdraw: returns the treasury account + memo, completes when the payment lands', async () => {
    const w = await get(`/sep6/withdraw?asset_code=USDC&type=bank_account&amount=2.5`);
    expect(w.status).toBe(200);
    expect(w.json.account_id).toBe(stellar.treasuryPublicKey);
    expect(w.json.memo_type).toBe('id');
    expect(w.json.memo).toMatch(/^\d{12}$/);
    let t = await get(`/sep6/transaction?id=${w.json.id}`);
    expect(t.json.transaction.status).toBe('pending_user_transfer_start');
    expect(t.json.transaction.kind).toBe('withdrawal');
    expect(t.json.transaction.withdraw_anchor_account).toBe(stellar.treasuryPublicKey);
    expect(t.json.transaction.withdraw_memo).toBe(w.json.memo);
    expect(t.json.transaction.from).toBe(wallet.publicKey());

    stellar.simulateIncoming({ amount: '2.5000000', memoId: w.json.memo, from: wallet.publicKey() });
    await workers.watchOfframpsOnce();
    t = await get(`/sep6/transaction?id=${w.json.id}`);
    expect(t.json.transaction.status).toBe('completed');
    expect(t.json.transaction.amount_in).toBe('2.5000000');
    expect(t.json.transaction.amount_out).toBe('99.50'); // 2.5 * 39.80
    expect(t.json.transaction.external_transaction_id).toMatch(/^FAST-/);
    expect(t.json.transaction.to).toMatch(/^TR\d{24}$/);
  });

  it('SEP-6 transactions: list newest first, honours limit, kind, no_older_than and paging_id', async () => {
    const all = await get('/sep6/transactions?asset_code=USDC');
    expect(all.json.transactions.length).toBe(2);
    expect(all.json.transactions[0].kind).toBe('withdrawal');
    expect(new Date(all.json.transactions[0].started_at) >= new Date(all.json.transactions[1].started_at)).toBe(true);
    const one = await get('/sep6/transactions?asset_code=USDC&limit=1');
    expect(one.json.transactions.length).toBe(1);
    const deposits = await get('/sep6/transactions?asset_code=USDC&kind=deposit');
    expect(deposits.json.transactions.map((t: any) => t.id)).toEqual([depositId]);
    const paged = await get(`/sep6/transactions?asset_code=USDC&paging_id=${all.json.transactions[0].id}`);
    expect(paged.json.transactions.map((t: any) => t.id)).toEqual([depositId]);
    const recent = await get(`/sep6/transactions?asset_code=USDC&no_older_than=${encodeURIComponent(all.json.transactions[0].started_at)}`);
    expect(recent.json.transactions.length).toBeGreaterThanOrEqual(1);
    const missing = await get('/sep6/transaction?id=sep_nope');
    expect(missing.status).toBe(404);
  });

  it('SEP-38: prices, price and firm quotes with consistent formulas', async () => {
    const info = await get('/sep38/info', {});
    expect(info.json.assets.map((a: any) => a.asset)).toContain('iso4217:TRY');
    const prices = await get('/sep38/prices?sell_asset=iso4217:TRY&sell_amount=100', {});
    expect(prices.json.buy_assets[0].asset).toBe(`stellar:USDC:${stellar.assetIssuer}`);
    const price = await get(`/sep38/price?sell_asset=iso4217:TRY&buy_asset=stellar:USDC:${stellar.assetIssuer}&sell_amount=100&context=sep6`, {});
    expect(price.status).toBe(200);
    const p = price.json;
    // sell_amount = buy_amount * total_price ; sell_amount - fee = price * buy_amount (2 decimals)
    expect(Math.round((Number(p.sell_amount) / Number(p.total_price)) * 100) / 100).toBe(Number(p.buy_amount) > 0 ? Math.round(Number(p.buy_amount) * 100) / 100 : 0);
    expect(Math.round((Number(p.sell_amount) - Number(p.fee.total)) * 100) / 100).toBe(Math.round(Number(p.price) * Number(p.buy_amount) * 100) / 100);
    expect(p.fee.asset).toBe('iso4217:TRY');

    const q = await app.request('/sep38/quote', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ sell_asset: `stellar:USDC:${stellar.assetIssuer}`, buy_asset: 'iso4217:TRY', sell_amount: '10', context: 'sep6' }) });
    expect(q.status).toBe(201);
    const quote = (await q.json()) as any;
    expect(quote.buy_amount).toBe('398.00');
    expect(quote.fee.asset).toBe(`stellar:USDC:${stellar.assetIssuer}`);
    const fetched = await get(`/sep38/quote/${quote.id}`);
    expect(fetched.json.id).toBe(quote.id);
    const nope = await get('/sep38/quote/qt_nope');
    expect(nope.status).toBe(404);
    const noauth = await app.request('/sep38/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noauth.status).toBe(403);

    // withdraw-exchange with the quote locks its rate
    const wx = await get(`/sep6/withdraw-exchange?source_asset=USDC&destination_asset=iso4217:TRY&amount=10&quote_id=${quote.id}&funding_method=bank_account`);
    expect(wx.status).toBe(200);
    const t = await get(`/sep6/transaction?id=${wx.json.id}`);
    expect(t.json.transaction.quote_id).toBe(quote.id);

    // deposit-exchange (the path wallets take): destination_asset is the on-chain code, source_asset
    // is the SEP-38 TRY identifier, and there is no asset_code param.
    const dq = await app.request('/sep38/quote', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ sell_asset: 'iso4217:TRY', buy_asset: `stellar:USDC:${stellar.assetIssuer}`, sell_amount: '100', context: 'sep6' }) });
    expect(dq.status).toBe(201);
    const dquote = (await dq.json()) as any;
    const dx = await get(`/sep6/deposit-exchange?destination_asset=USDC&source_asset=iso4217:TRY&amount=100&quote_id=${dquote.id}&type=bank_account`);
    expect(dx.status).toBe(200);
    const dxTx = await get(`/sep6/transaction?id=${dx.json.id}`);
    expect(dxTx.json.transaction.quote_id).toBe(dquote.id);
  });

  it('SEP-6 on_change_callback: posts signed status changes', async () => {
    const received: Array<{ headers: Record<string, string>; body: string }> = [];
    const server = createServer((rq, rs) => {
      let body = '';
      rq.on('data', (c) => (body += c));
      rq.on('end', () => {
        received.push({ headers: rq.headers as Record<string, string>, body });
        rs.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/cb`;
    try {
      const dep = await get(`/sep6/deposit?asset_code=USDC&account=${wallet.publicKey()}&on_change_callback=${encodeURIComponent(url)}`);
      expect(dep.status).toBe(200);
      expect(await workers.sepCallbacksOnce()).toBe(1);
      expect(await workers.sepCallbacksOnce()).toBe(0); // unchanged status -> no repeat
      const d = received[0]!;
      const m = /t=(\d+), s=(.+)/.exec(d.headers['signature']!)!;
      const ok = sep.signingKeypair.verify(Buffer.from(`${m[1]}.127.0.0.1:${(server.address() as { port: number }).port}.${d.body}`), Buffer.from(m[2]!, 'base64'));
      expect(ok).toBe(true);
      expect(JSON.parse(d.body).transaction.status).toBe('pending_user_transfer_start');
      await app.request(`/sep6/tx/${dep.json.id}/simulate-bank-transfer`, { method: 'POST' });
      expect(await workers.sepCallbacksOnce()).toBe(1);
      expect(JSON.parse(received[1]!.body).transaction.status).toBe('pending_anchor');
    } finally {
      server.close();
    }
  });
});
