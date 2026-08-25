import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEnv, Deps } from '../context.js';
import { fmtRate, fmtUsdc } from '../money.js';
import { buildOpenApi } from '../openapi.js';

const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(process.cwd(), 'public');
const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), 'utf8');

export function publicRoutes(deps: Deps) {
  const { cfg, stellar, rates } = deps;
  const app = new Hono<AppEnv>();
  const openapi = buildOpenApi(cfg, stellar);

  app.get('/', (c) => c.html(page('index.html')));
  app.get('/dashboard', (c) => c.html(page('dashboard.html')));
  app.get('/docs', (c) => c.html(page('docs.html')));
  app.get('/demo', (c) => c.html(page('demo.html')));
  app.get('/guide', (c) => c.html(page('guide.html')));

  app.get('/health', async (c) => {
    const [bal, buy, sell] = await Promise.all([
      stellar.treasuryUsdcBalance().catch(() => null),
      rates.quote('buy'),
      rates.quote('sell'),
    ]);
    return c.json({
      ok: true,
      service: 'tr-mock-anchor',
      environment: 'sandbox',
      stellar_mode: stellar.mode,
      network_passphrase: cfg.networkPassphrase,
      horizon_url: cfg.horizonUrl,
      asset: { code: stellar.assetCode, issuer: stellar.assetIssuer },
      treasury: {
        address: stellar.treasuryPublicKey,
        usdc_balance: bal === null ? null : fmtUsdc(bal),
        low_balance: bal === null ? null : bal < 100_0000000n,
      },
      rates: {
        pair: 'USDC/TRY',
        mid_rate: fmtRate(buy.mid.midMicro),
        buy_rate: fmtRate(buy.rateMicro),
        sell_rate: fmtRate(sell.rateMicro),
        spread_bps: buy.spreadBps,
        source: buy.mid.source,
      },
      time: new Date().toISOString(),
    });
  });

  app.get('/openapi.json', (c) => c.json(openapi));

  app.get('/llms.txt', (c) =>
    c.text(
      [
        '# TR Mock Anchor (Stellar testnet sandbox)',
        '',
        '> Mock Turkish TRY <-> USDC on/off-ramp for Stellar testnet builders. API-key based, modelled on how Turkish exchanges ramp: bank transfer with a reference code -> TRY balance -> convert to USDC at USD/TRY -> USDC paid to the wallet. Off-ramp is the reverse. Nothing here is a real financial service.',
        '',
        `- Base URL: ${cfg.publicUrl}`,
        `- Guide (concepts, flows, errors, webhooks, glossary): ${cfg.publicUrl}/guide`,
        `- Interactive end-to-end demo: ${cfg.publicUrl}/demo`,
        `- OpenAPI: ${cfg.publicUrl}/openapi.json`,
        `- Health & treasury: ${cfg.publicUrl}/health`,
        `- Dashboard (sign up with email, get your single API key): ${cfg.publicUrl}/`,
        `- Auth: header X-API-Key: <key>  (or Authorization: Bearer <key>)`,
        `- Signup via API: POST ${cfg.publicUrl}/v1/partners {"email","password","name"}`,
        `- Stellar: testnet, asset ${stellar.assetCode}:${stellar.assetIssuer}, treasury ${stellar.treasuryPublicKey}`,
        '',
        '## Flow',
        '1. POST /v1/customers -> customer with deposit_reference',
        '2. GET /v1/customers/{id}/deposit-instructions -> IBAN + reference (write reference in the bank transfer description)',
        '3. POST /v1/sandbox/bank-transfers {reference, amount_try} -> simulates the incoming TRY transfer, credits TRY balance',
        '4. POST /v1/quotes {side:"buy", amount, amount_currency} -> locked rate for 120s',
        '5. POST /v1/onramps {customer_id, quote_id|amount_try, destination_address} -> USDC sent on Stellar testnet (payment or claimable balance)',
        '6. POST /v1/offramps {customer_id, amount_usdc} -> deposit address + memo id; send USDC on-chain; TRY credited and paid out to IBAN',
        '7. Webhooks: POST /v1/webhooks {url, events}. Poll alternative: GET /v1/events',
      ].join('\n'),
    ),
  );

  app.get('/.well-known/stellar.toml', (c) =>
    c.text(
      [
        'VERSION="2.7.0"',
        `NETWORK_PASSPHRASE="${cfg.networkPassphrase}"`,
        `ACCOUNTS=["${stellar.treasuryPublicKey}"]`,
        '',
        '[DOCUMENTATION]',
        'ORG_NAME="TR Mock Anchor (testnet sandbox)"',
        `ORG_URL="${cfg.publicUrl}"`,
        'ORG_DESCRIPTION="Mock Turkish TRY <-> USDC ramp for Stellar testnet builders. Not a real financial service. No real money moves."',
        '',
        '[[CURRENCIES]]',
        `code="${stellar.assetCode}"`,
        `issuer="${stellar.assetIssuer}"`,
        'display_decimals=2',
        'desc="USDC on Stellar testnet (Circle testnet issuer unless overridden). This anchor ramps it against TRY."',
        '',
      ].join('\n'),
      200,
      { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    ),
  );

  return app;
}
