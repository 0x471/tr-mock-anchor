/**
 * Create (or reuse) the treasury account on Stellar testnet: friendbot-fund it and open a USDC trustline.
 * Prints the env lines to paste into .env.
 *
 *   npm run setup:treasury
 */
import './_env.js';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const ISSUER = process.env.USDC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const server = new Horizon.Server(HORIZON);

const kp = process.env.TREASURY_SECRET ? Keypair.fromSecret(process.env.TREASURY_SECRET) : Keypair.random();
console.log(`treasury public key: ${kp.publicKey()}`);

let account;
try {
  account = await server.loadAccount(kp.publicKey());
  console.log('account exists on testnet');
} catch {
  console.log('funding with friendbot…');
  const r = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot failed: ${r.status} ${await r.text()}`);
  account = await server.loadAccount(kp.publicKey());
}

const hasTrust = account.balances.some((b) => 'asset_code' in b && b.asset_code === 'USDC' && (b as { asset_issuer?: string }).asset_issuer === ISSUER);
if (hasTrust) {
  console.log('USDC trustline already present');
} else {
  console.log(`opening trustline to USDC:${ISSUER}…`);
  const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', ISSUER) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  console.log(`trustline tx: ${res.hash}`);
}

console.log('\nAdd to .env:');
console.log(`TREASURY_SECRET=${kp.secret()}`);
console.log(`USDC_ISSUER=${ISSUER}`);
console.log(`\nFund it with testnet USDC: https://faucet.circle.com (Stellar Testnet, 20 USDC per address every 2 hours)`);
console.log(`Treasury address to paste there: ${kp.publicKey()}`);
console.log(`Explorer: https://stellar.expert/explorer/testnet/account/${kp.publicKey()}`);
