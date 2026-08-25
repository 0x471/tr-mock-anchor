/**
 * Consolidate faucet drops: send the full USDC balance of each helper account to the treasury.
 * Request 20 USDC per helper address at https://faucet.circle.com, then:
 *
 *   SWEEP_SECRETS=S...,S...,S... npm run sweep
 */
import './_env.js';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const ISSUER = process.env.USDC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const server = new Horizon.Server(HORIZON);
const treasury = Keypair.fromSecret(process.env.TREASURY_SECRET ?? (() => { throw new Error('TREASURY_SECRET missing'); })());
const secrets = (process.env.SWEEP_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (!secrets.length) throw new Error('SWEEP_SECRETS is empty');
const asset = new Asset('USDC', ISSUER);

let total = 0;
for (const s of secrets) {
  const kp = Keypair.fromSecret(s);
  const acct = await server.loadAccount(kp.publicKey());
  const bal = acct.balances.find((b) => 'asset_issuer' in b && (b as { asset_issuer?: string }).asset_issuer === ISSUER) as { balance: string } | undefined;
  if (!bal || Number(bal.balance) === 0) {
    console.log(`${kp.publicKey()}: no USDC, skipping`);
    continue;
  }
  const tx = new TransactionBuilder(acct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: treasury.publicKey(), asset, amount: bal.balance }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  total += Number(bal.balance);
  console.log(`${kp.publicKey()}: swept ${bal.balance} USDC (${res.hash})`);
}
console.log(`total swept: ${total} USDC -> ${treasury.publicKey()}`);
