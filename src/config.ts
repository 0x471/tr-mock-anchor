import { Networks } from '@stellar/stellar-sdk';
import { makeTrIban } from './turkey.js';

const env = process.env;
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));
const str = (v: string | undefined, d: string) => (v === undefined || v === '' ? d : v);
const port = num(env.PORT, 8787);

export const config = {
  port,
  publicUrl: str(env.PUBLIC_URL, `http://localhost:${port}`).replace(/\/$/, ''),
  dbPath: str(env.DB_PATH, './data/anchor.db'),

  // Stellar
  stellarMode: str(env.STELLAR_MODE, 'live') as 'live' | 'fake',
  horizonUrl: str(env.HORIZON_URL, 'https://horizon-testnet.stellar.org'),
  rpcUrl: str(env.RPC_URL, 'https://soroban-testnet.stellar.org'),
  networkPassphrase: str(env.NETWORK_PASSPHRASE, Networks.TESTNET),
  usdcCode: 'USDC',
  // Circle's USDC issuer on Stellar testnet.
  usdcIssuer: str(env.USDC_ISSUER, 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'),
  treasurySecret: str(env.TREASURY_SECRET, ''),

  // Pricing
  rateSource: str(env.RATE_SOURCE, 'reflector') as 'reflector' | 'static',
  staticUsdTry: str(env.STATIC_USDTRY, '47.50'),
  spreadBps: num(env.SPREAD_BPS, 50),
  quoteTtlSeconds: num(env.QUOTE_TTL_SECONDS, 120),
  offrampRateLockSeconds: num(env.OFFRAMP_RATE_LOCK_SECONDS, 1800),
  // Reflector "Foreign Exchange" feed on Stellar mainnet (base USD, 14 decimals).
  reflectorFxContract: str(env.REFLECTOR_FX_CONTRACT, 'CBKGPWGKSKZF52CFHMTRR23TBWTPMRDIYZ4O2P5VS65BMHYH4DXMCJZC'),
  reflectorRpcUrls: str(
    env.REFLECTOR_RPC_URLS,
    'https://mainnet.sorobanrpc.com,https://soroban-rpc.creit.tech,https://rpc.ankr.com/stellar_soroban',
  ).split(',').map((s) => s.trim()).filter(Boolean),
  rateCacheSeconds: num(env.RATE_CACHE_SECONDS, 60),

  // Limits (decimal strings)
  minOnrampTry: str(env.MIN_ONRAMP_TRY, '50.00'),
  maxOnrampTry: str(env.MAX_ONRAMP_TRY, '250000.00'),
  minOfframpUsdc: str(env.MIN_OFFRAMP_USDC, '1.0000000'),

  // Mock bank identity shown in deposit instructions.
  bankName: str(env.BANK_NAME, 'TR Mock Bank A.Ş.'),
  accountHolder: str(env.ACCOUNT_HOLDER, 'TR Mock Anchor Teknoloji A.Ş.'),
  // Structurally valid TR IBAN with a fictional bank code (00099).
  anchorIban: str(env.ANCHOR_IBAN, makeTrIban('00099', '0000000000000001')),

  adminUser: str(env.ADMIN_USER, ''),
  adminPassword: str(env.ADMIN_PASSWORD, ''),

  workers: str(env.WORKERS, 'true') !== 'false',
  pollMs: {
    onramp: num(env.ONRAMP_POLL_MS, 3000),
    offramp: num(env.OFFRAMP_POLL_MS, 5000),
    webhook: num(env.WEBHOOK_POLL_MS, 2000),
  },
};

export type Config = typeof config;
