/**
 * End-to-end check of the SEP door against a RUNNING server on real Stellar testnet:
 *   SEP-1 toml -> SEP-10 auth -> SEP-12 (optional PUT) -> SEP-6 deposit (simulate the bank, expect
 *   real USDC on-chain) -> SEP-38 quote -> SEP-6 withdraw-exchange (pay USDC with memo, expect
 *   completed + payout).
 *
 *   BASE_URL=http://localhost:8787 npm run e2e:sep6
 */
import './_env.js';
import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const server = new Horizon.Server(process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org');
const fee = String(Number(BASE_FEE) * 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n▶ ${s}`);
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };

let TOKEN = '';
async function sep<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const r = await fetch(BASE + path, { ...init, headers: { ...(init.headers as Record<string, string>), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) } });
  const text = await r.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html or empty */ }
  return { status: r.status, body };
}
async function poll(id: string, pending: string[], maxSeconds: number) {
  const start = Date.now();
  for (;;) {
    const { body } = await sep<any>(`/sep6/transaction?id=${id}`);
    if (!pending.includes(body.transaction.status)) return body.transaction;
    if (Date.now() - start > maxSeconds * 1000) throw new Error(`timeout: ${id} still ${body.transaction.status}`);
    await sleep(3000);
  }
}

step(`SEP-1 toml @ ${BASE}`);
const toml = await (await fetch(`${BASE}/.well-known/stellar.toml`)).text();
const field = (k: string) => toml.match(new RegExp(`^${k}="([^"]+)"`, 'm'))?.[1];
const transfer = field('TRANSFER_SERVER'), webAuth = field('WEB_AUTH_ENDPOINT'), signing = field('SIGNING_KEY');
console.log(`  TRANSFER_SERVER=${transfer} WEB_AUTH_ENDPOINT=${webAuth} SIGNING_KEY=${signing}`);
assert(transfer && webAuth && signing, 'toml must publish TRANSFER_SERVER, WEB_AUTH_ENDPOINT and SIGNING_KEY');
const health = await (await fetch(`${BASE}/health`)).json() as any;
assert(health.stellar_mode === 'live', 'server must run with STELLAR_MODE=live');
const asset = new Asset(health.asset.code, health.asset.issuer);

step('wallet: fresh testnet account with a USDC trustline');
const wallet = Keypair.random();
const fb = await fetch(`https://friendbot.stellar.org?addr=${wallet.publicKey()}`);
assert(fb.ok, 'friendbot failed');
{
  const acct = await server.loadAccount(wallet.publicKey());
  const tx = new TransactionBuilder(acct, { fee, networkPassphrase: Networks.TESTNET }).addOperation(Operation.changeTrust({ asset })).setTimeout(60).build();
  tx.sign(wallet);
  await server.submitTransaction(tx);
}
console.log(`  ${wallet.publicKey()}`);

step('SEP-10: challenge -> sign -> JWT');
const ch = await sep<any>(`/auth?account=${wallet.publicKey()}`);
assert(ch.status === 200 && ch.body.transaction, 'GET /auth failed');
const challenge = TransactionBuilder.fromXdr(ch.body.transaction, Networks.TESTNET);
challenge.sign(wallet);
const tok = await sep<any>('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: challenge.toXdr() }) });
assert(tok.status === 200 && tok.body.token, `POST /auth failed: ${JSON.stringify(tok.body)}`);
TOKEN = tok.body.token;
console.log(`  token ${TOKEN.slice(0, 24)}…`);

step('SEP-12: status without any data, then a data-free PUT');
let cust = await sep<any>('/sep12/customer');
console.log(`  before: ${cust.body.status}`);
const put = await sep<any>('/sep12/customer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' });
assert(put.status === 202, 'PUT /customer should be accepted');
cust = await sep<any>('/sep12/customer');
console.log(`  after:  ${cust.body.status} (id ${cust.body.id})`);
assert(cust.body.status === 'ACCEPTED', 'customer should be ACCEPTED without personal data');

step('SEP-6 /info');
const info = await sep<any>('/sep6/info');
assert(info.body.deposit[health.asset.code].enabled && info.body.withdraw[health.asset.code].enabled, '/info must enable the asset');

step('SEP-6 deposit: 150 TRY -> simulate the bank -> real USDC on-chain');
const dep = await sep<any>(`/sep6/deposit?asset_code=${health.asset.code}&account=${wallet.publicKey()}&funding_method=bank_account&amount=150.00`);
assert(dep.status === 200, `deposit failed: ${JSON.stringify(dep.body)}`);
console.log(`  id ${dep.body.id}; pay ${dep.body.instructions.bank_account_number.value} with memo ${dep.body.instructions.external_transfer_memo.value}`);
let t = (await sep<any>(`/sep6/transaction?id=${dep.body.id}`)).body.transaction;
assert(t.status === 'pending_user_transfer_start', `expected pending_user_transfer_start, got ${t.status}`);
const sim = await fetch(`${BASE}/sep6/tx/${dep.body.id}/simulate-bank-transfer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '150.00' }) });
assert(sim.ok, 'simulate-bank-transfer failed');
t = await poll(dep.body.id, ['pending_anchor', 'pending_stellar'], 120);
console.log(`  ${t.status}: ${t.amount_in} ${t.amount_in_asset} -> ${t.amount_out} USDC (fee ${t.amount_fee} TRY) tx ${t.stellar_transaction_id}`);
assert(t.status === 'completed', 'deposit should complete');
{
  const acct = await server.loadAccount(wallet.publicKey());
  const bal = acct.balances.find((b) => 'asset_issuer' in b && (b as { asset_issuer?: string }).asset_issuer === asset.getIssuer()) as { balance: string };
  console.log(`  Horizon: wallet holds ${bal.balance} USDC`);
  assert(Math.abs(Number(bal.balance) - Number(t.amount_out)) < 1e-7, 'on-chain balance must match amount_out');
}

step('SEP-38 quote + SEP-6 withdraw-exchange: send the USDC back with the memo');
const usdcId = `stellar:${health.asset.code}:${health.asset.issuer}`;
const quote = await sep<any>('/sep38/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sell_asset: usdcId, buy_asset: 'iso4217:TRY', sell_amount: t.amount_out, context: 'sep6' }) });
assert(quote.status === 201, `quote failed: ${JSON.stringify(quote.body)}`);
console.log(`  quote ${quote.body.id}: ${quote.body.sell_amount} USDC -> ${quote.body.buy_amount} TRY (total_price ${quote.body.total_price}, fee ${quote.body.fee.total} ${quote.body.fee.asset})`);
const wd = await sep<any>(`/sep6/withdraw-exchange?asset_code=${health.asset.code}&source_asset=${encodeURIComponent(usdcId)}&destination_asset=iso4217:TRY&amount=${t.amount_out}&quote_id=${quote.body.id}&funding_method=bank_account`);
assert(wd.status === 200, `withdraw failed: ${JSON.stringify(wd.body)}`);
console.log(`  withdraw ${wd.body.id}: pay ${wd.body.account_id} memo(${wd.body.memo_type}) ${wd.body.memo}`);
{
  const acct = await server.loadAccount(wallet.publicKey());
  const tx = new TransactionBuilder(acct, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: wd.body.account_id, asset, amount: t.amount_out }))
    .addMemo(Memo.id(wd.body.memo))
    .setTimeout(60)
    .build();
  tx.sign(wallet);
  const res = await server.submitTransaction(tx);
  console.log(`  paid in ${res.hash}`);
}
const w = await poll(wd.body.id, ['pending_user_transfer_start', 'pending_external'], 180);
console.log(`  ${w.status}: ${w.amount_in} USDC -> ${w.amount_out} TRY (fee ${w.amount_fee} TRY), payout ref ${w.external_transaction_id} to ${w.to}, quote ${w.quote_id}`);
assert(w.status === 'completed' && w.quote_id === quote.body.id, 'withdrawal should complete with the quote');
assert(w.amount_out === quote.body.buy_amount, `payout ${w.amount_out} should equal quoted ${quote.body.buy_amount}`);

const list = await sep<any>(`/sep6/transactions?asset_code=${health.asset.code}`);
console.log(`\n✅ SEP-6 e2e passed. ${list.body.transactions.length} transactions for this wallet.`);
console.log(`   deposit  https://stellar.expert/explorer/testnet/tx/${t.stellar_transaction_id}`);
console.log(`   withdraw https://stellar.expert/explorer/testnet/tx/${w.stellar_transaction_id}`);
console.log(`   more_info_url ${t.more_info_url}`);
