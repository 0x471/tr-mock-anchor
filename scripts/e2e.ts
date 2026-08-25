/**
 * End-to-end check against a RUNNING server (default http://localhost:8787) on real Stellar testnet:
 *   1. account + customer + simulated TRY transfer
 *   2. on-ramp to a fresh wallet WITH a trustline  -> expect a payment, verify the wallet balance on Horizon
 *   3. on-ramp to a fresh wallet WITHOUT a trustline -> expect a claimable balance, claim it
 *   4. off-ramp: wallet sends USDC with the memo -> expect completed + payout
 *
 *   BASE_URL=http://localhost:8787 npm run e2e
 */
import './_env.js';
import { Asset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const HORIZON = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON);
const fee = String(Number(BASE_FEE) * 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (s: string) => console.log(`\n▶ ${s}`);
const assert = (cond: unknown, msg: string) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); };

let KEY = '';
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(KEY ? { 'x-api-key': KEY } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(j)}`);
  return j as T;
}
async function fund(kp: Keypair) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot failed for ${kp.publicKey()}: ${r.status}`);
}
async function trust(kp: Keypair, asset: Asset) {
  const acct = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee, networkPassphrase: Networks.TESTNET }).addOperation(Operation.changeTrust({ asset })).setTimeout(60).build();
  tx.sign(kp);
  return server.submitTransaction(tx);
}
async function usdcBalance(pub: string, asset: Asset) {
  const acct = await server.loadAccount(pub);
  const b = acct.balances.find((x) => 'asset_issuer' in x && (x as { asset_issuer?: string }).asset_issuer === asset.getIssuer() && (x as { asset_code?: string }).asset_code === asset.getCode()) as { balance: string } | undefined;
  return b ? Number(b.balance) : 0;
}
async function poll<T extends { status: string }>(path: string, pendingStates: string[], maxSeconds = 120): Promise<T> {
  const start = Date.now();
  for (;;) {
    const cur = await api<T>('GET', path);
    if (!pendingStates.includes(cur.status)) return cur;
    if (Date.now() - start > maxSeconds * 1000) throw new Error(`timeout waiting on ${path}, still ${cur.status}`);
    await sleep(3000);
  }
}

step(`health @ ${BASE}`);
const health = await api<any>('GET', '/health');
console.log(`  mode=${health.stellar_mode} asset=${health.asset.code}:${health.asset.issuer} treasury=${health.treasury.address} usdc=${health.treasury.usdc_balance} rate=${health.rates.mid_rate} (${health.rates.source})`);
assert(health.stellar_mode === 'live', 'server must run with STELLAR_MODE=live for the e2e');
const asset = new Asset(health.asset.code, health.asset.issuer);

step('account + customer + simulated bank transfer');
const acct = await api<any>('POST', '/v1/partners', { email: `e2e-${Date.now()}@example.com`, password: 'e2e-password-123', name: 'e2e' });
KEY = acct.api_key;
const customer = await api<any>('POST', '/v1/customers', { first_name: 'Ayşe', last_name: 'Yılmaz', tckn: '10000000146', iban: 'TR330006100519786457841326', external_id: `e2e-${Date.now()}` });
console.log(`  customer ${customer.id} ref ${customer.deposit_reference} kyc ${customer.kyc_status}`);
await api('POST', '/v1/sandbox/bank-transfers', { reference: customer.deposit_reference, amount_try: '300.00', sender_name: 'Ayşe Yılmaz' });
let bal = await api<any>('GET', `/v1/customers/${customer.id}/balances`);
assert(bal.balances.TRY === '300.00', `TRY balance should be 300.00, got ${bal.balances.TRY}`);
console.log(`  TRY balance ${bal.balances.TRY}`);

step('wallets: A (with trustline), B (no trustline)');
const walletA = Keypair.random();
const walletB = Keypair.random();
await Promise.all([fund(walletA), fund(walletB)]);
await trust(walletA, asset);
console.log(`  A ${walletA.publicKey()} (trustline)  B ${walletB.publicKey()} (no trustline)`);

step('on-ramp 100 TRY -> A (expect payment)');
const q = await api<any>('POST', '/v1/quotes', { customer_id: customer.id, side: 'buy', amount: '100.00', amount_currency: 'TRY' });
console.log(`  quote ${q.id}: ${q.source_amount} TRY -> ${q.destination_amount} USDC @ ${q.rate} (${q.rate_source})`);
let onA = await api<any>('POST', '/v1/onramps', { customer_id: customer.id, quote_id: q.id, destination_address: walletA.publicKey(), memo: 'e2e' });
onA = await poll<any>(`/v1/onramps/${onA.id}`, ['pending']);
console.log(`  ${onA.status} via ${onA.settlement} tx ${onA.stellar_tx_hash} ${onA.failure_reason ?? ''}`);
assert(onA.status === 'completed' && onA.settlement === 'payment', 'on-ramp A should complete as payment');
const balA = await usdcBalance(walletA.publicKey(), asset);
console.log(`  Horizon: wallet A holds ${balA} USDC`);
assert(Math.abs(balA - Number(onA.amount_usdc)) < 1e-7, `wallet A balance ${balA} != ${onA.amount_usdc}`);

step('on-ramp 100 TRY -> B (expect claimable balance), then claim it');
let onB = await api<any>('POST', '/v1/onramps', { customer_id: customer.id, amount_try: '100.00', destination_address: walletB.publicKey() });
onB = await poll<any>(`/v1/onramps/${onB.id}`, ['pending']);
console.log(`  ${onB.status} via ${onB.settlement} tx ${onB.stellar_tx_hash} cb ${onB.claimable_balance_id} ${onB.failure_reason ?? ''}`);
assert(onB.status === 'completed' && onB.settlement === 'claimable_balance', 'on-ramp B should complete as claimable balance');
{
  const bAcct = await server.loadAccount(walletB.publicKey());
  const tx = new TransactionBuilder(bAcct, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset }))
    .addOperation(Operation.claimClaimableBalance({ balanceId: onB.claimable_balance_id }))
    .setTimeout(60)
    .build();
  tx.sign(walletB);
  const res = await server.submitTransaction(tx);
  const balB = await usdcBalance(walletB.publicKey(), asset);
  console.log(`  claimed in ${res.hash}; wallet B holds ${balB} USDC`);
  assert(Math.abs(balB - Number(onB.amount_usdc)) < 1e-7, 'wallet B balance after claim mismatch');
}

step('off-ramp: A sends its USDC back with the memo');
const off = await api<any>('POST', '/v1/offramps', { customer_id: customer.id, amount_usdc: onA.amount_usdc });
console.log(`  offramp ${off.id} -> ${off.deposit.address} memo(id) ${off.deposit.memo} rate ${off.rate}`);
{
  const aAcct = await server.loadAccount(walletA.publicKey());
  const tx = new TransactionBuilder(aAcct, { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: off.deposit.address, asset, amount: onA.amount_usdc }))
    .addMemo(Memo.id(off.deposit.memo))
    .setTimeout(60)
    .build();
  tx.sign(walletA);
  const res = await server.submitTransaction(tx);
  console.log(`  sent ${onA.amount_usdc} USDC in ${res.hash}`);
}
const offDone = await poll<any>(`/v1/offramps/${off.id}`, ['awaiting_deposit'], 180);
console.log(`  ${offDone.status}: received ${offDone.received_usdc} USDC -> ${offDone.amount_try} TRY, payout ${offDone.payout_id}, tx ${offDone.stellar_tx_hash}`);
assert(offDone.status === 'completed' && offDone.payout_id, 'off-ramp should complete with a payout');
const payout = await api<any>('GET', `/v1/payouts/${offDone.payout_id}`);
console.log(`  payout ${payout.amount_try} TRY -> ${payout.iban} (${payout.rail} ${payout.bank_reference})`);

bal = await api<any>('GET', `/v1/customers/${customer.id}/balances`);
console.log(`\n✅ e2e passed. Final balances: TRY ${bal.balances.TRY}, USDC ${bal.balances.USDC}`);
console.log(`   on-ramp A tx  https://stellar.expert/explorer/testnet/tx/${onA.stellar_tx_hash}`);
console.log(`   on-ramp B tx  https://stellar.expert/explorer/testnet/tx/${onB.stellar_tx_hash}`);
console.log(`   off-ramp tx   https://stellar.expert/explorer/testnet/tx/${offDone.stellar_tx_hash}`);
