/**
 * Alternative supply for load testing: issue a self-controlled "USDC" on testnet and mint it to the treasury.
 * Wallets that want to receive it must trust USDC:<this issuer> instead of Circle's.
 *
 *   npm run mock:usdc                # create issuer, trust from treasury, mint 1,000,000
 *   npm run mock:usdc -- --mint 5000 # mint more (needs MOCK_USDC_ISSUER_SECRET in env)
 */
import './_env.js';
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';

const HORIZON = process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON);
const treasurySecret = process.env.TREASURY_SECRET;
if (!treasurySecret) throw new Error('TREASURY_SECRET missing (run npm run setup:treasury first)');
const treasury = Keypair.fromSecret(treasurySecret);
const mintArg = process.argv.indexOf('--mint');
const amount = mintArg > -1 ? process.argv[mintArg + 1]! : '1000000';

const issuer = process.env.MOCK_USDC_ISSUER_SECRET ? Keypair.fromSecret(process.env.MOCK_USDC_ISSUER_SECRET) : Keypair.random();
if (!process.env.MOCK_USDC_ISSUER_SECRET) {
  console.log(`creating mock issuer ${issuer.publicKey()} via friendbot…`);
  const r = await fetch(`https://friendbot.stellar.org?addr=${issuer.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot failed: ${r.status}`);
}
const asset = new Asset('USDC', issuer.publicKey());

const tAcct = await server.loadAccount(treasury.publicKey());
if (!tAcct.balances.some((b) => 'asset_issuer' in b && (b as { asset_issuer?: string }).asset_issuer === issuer.publicKey())) {
  const trust = new TransactionBuilder(tAcct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  trust.sign(treasury);
  console.log(`treasury trustline tx: ${(await server.submitTransaction(trust)).hash}`);
}

const iAcct = await server.loadAccount(issuer.publicKey());
const mint = new TransactionBuilder(iAcct, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.payment({ destination: treasury.publicKey(), asset, amount }))
  .setTimeout(60)
  .build();
mint.sign(issuer);
console.log(`minted ${amount} USDC to treasury: ${(await server.submitTransaction(mint)).hash}`);

console.log('\nAdd to .env to run the anchor on the mock asset:');
console.log(`USDC_ISSUER=${issuer.publicKey()}`);
console.log(`MOCK_USDC_ISSUER_SECRET=${issuer.secret()}`);
