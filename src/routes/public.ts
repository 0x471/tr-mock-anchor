import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEnv, Deps } from '../context.js';
import { fmtRate, fmtUsdc } from '../money.js';
import { buildOpenApi } from '../openapi.js';
import type { SepContext } from '../sepauth.js';

const PUBLIC_DIR = process.env.PUBLIC_DIR ?? join(process.cwd(), 'public');
const page = (name: string) => readFileSync(join(PUBLIC_DIR, name), 'utf8');

export function publicRoutes(deps: Deps, sep: SepContext) {
  const { cfg, stellar, rates } = deps;
  const app = new Hono<AppEnv>();
  const openapi = buildOpenApi(cfg, stellar);

  app.get('/', (c) => c.html(page('index.html')));
  app.get('/dashboard', (c) => c.html(page('dashboard.html')));
  app.get('/docs', (c) => c.html(page('docs.html')));
  app.get('/demo', (c) => c.html(page('demo.html')));
  app.get('/see-it-run', (c) => c.html(page('see-it-run.html')));
  app.get('/guide', (c) => c.html(page('guide.html')));
  app.get('/mainnet', (c) => c.html(page('mainnet.html')));

  // Endpoint list derived from the OpenAPI doc, so it never drifts from the real API.
  const apiEndpoints = () =>
    Object.entries(openapi.paths).flatMap(([p, ops]) =>
      Object.entries(ops as Record<string, { summary?: string; tags?: string[] }>)
        .filter(([m]) => ['get', 'post', 'patch', 'delete', 'put'].includes(m))
        .map(([m, o]) => ({ method: m.toUpperCase(), path: p, summary: o.summary ?? '', tag: o.tags?.[0] ?? 'Other' })),
    );

  const PAGES: Array<[string, string, string]> = [
    ['/', 'Home & sign up', 'Create an account with your email, get your single API key.'],
    ['/demo', 'How it works (interactive demo)', 'Runs the full partner-API round trip live in the browser with real testnet transactions.'],
    ['/see-it-run', 'See it run (SEP-6 door)', 'A real, completed SEP-6 round trip against this anchor — SEP-10 login, deposit, on-chain USDC, withdraw — with on-chain proof links.'],
    ['/guide', 'Guide', 'Concepts, Turkish rails, on/off-ramp flows, SEP-6 door, statuses, errors, webhooks, glossary (TR/EN).'],
    ['/mainnet', 'Mainnet: what to expect', 'What changes moving from this sandbox to a production anchor, plus a readiness checklist.'],
    ['/docs', 'API reference', 'Interactive OpenAPI 3.1 reference.'],
    ['/dashboard', 'Dashboard', 'Your API key, a playground, and live tables of customers / orders / events (login required).'],
  ];
  const MACHINE: Array<[string, string]> = [
    ['/openapi.json', 'OpenAPI 3.1 specification (JSON).'],
    ['/llms.txt', 'Concise machine index of this anchor (this file).'],
    ['/llms-full.txt', 'Full text: quickstart, every endpoint, statuses, pricing, mainnet notes — one document.'],
    ['/sitemap.md', 'Human- and AI-readable Markdown sitemap.'],
    ['/sitemap.xml', 'XML sitemap for crawlers.'],
    ['/health', 'Service, treasury balance, live rates, SEP endpoints (JSON).'],
    ['/.well-known/stellar.toml', 'SEP-1 metadata (SIGNING_KEY, TRANSFER_SERVER, WEB_AUTH_ENDPOINT, KYC_SERVER, ANCHOR_QUOTE_SERVER).'],
  ];

  app.get('/sitemap.md', (c) =>
    c.text(
      [
        '# TR Mock Anchor — Sitemap',
        '',
        `> Mock Turkish TRY <-> USDC on/off-ramp on Stellar testnet. Two doors on one ledger: an API-key partner REST API and a SEP-6 wallet door. Base URL: ${cfg.publicUrl}`,
        '',
        'If you are an AI reading this: fetch `/llms-full.txt` for the complete reference in one request, or `/openapi.json` for the machine-readable API spec.',
        '',
        '## Pages',
        ...PAGES.map(([p, t, d]) => `- [${t}](${cfg.publicUrl}${p}) — ${d}`),
        '',
        '## Machine-readable',
        ...MACHINE.map(([p, d]) => `- [${cfg.publicUrl}${p}](${cfg.publicUrl}${p}) — ${d}`),
        '',
        '## API endpoints',
        ...apiEndpoints().map((e) => `- \`${e.method} ${e.path}\` — ${e.summary} _(${e.tag})_`),
        '',
      ].join('\n'),
      200,
      { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' },
    ),
  );

  app.get('/sitemap.xml', (c) => {
    const urls = PAGES.map(([p]) => p).concat(MACHINE.map(([p]) => p));
    return c.text(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
        urls.map((u) => `  <url><loc>${cfg.publicUrl}${u}</loc></url>`).join('\n') +
        `\n</urlset>\n`,
      200,
      { 'content-type': 'application/xml; charset=utf-8', 'access-control-allow-origin': '*' },
    );
  });

  app.get('/llms-full.txt', async (c) => {
    const [buy, sell] = await Promise.all([rates.quote('buy'), rates.quote('sell')]);
    const byTag = new Map<string, ReturnType<typeof apiEndpoints>>();
    for (const e of apiEndpoints()) (byTag.get(e.tag) ?? byTag.set(e.tag, []).get(e.tag)!).push(e);
    const endpointBlock = [...byTag.entries()].flatMap(([tag, list]) => [`### ${tag}`, ...list.map((e) => `- ${e.method} ${e.path} — ${e.summary}`), '']);
    return c.text(
      [
        '# TR Mock Anchor — full reference',
        `Base URL: ${cfg.publicUrl}`,
        '',
        'Mock Turkish TRY <-> USDC on/off-ramp on Stellar testnet, for builders integrating a TRY ramp before a production anchor exists. Two doors on one ledger:',
        'partner REST API (header X-API-Key) and a SEP-6 wallet door (SEP-1/10/12/38). The bank and KYC are simulated; the Stellar leg is real testnet USDC.',
        `Asset: ${stellar.assetCode}:${stellar.assetIssuer}. Treasury: ${stellar.treasuryPublicKey}.`,
        `Rates: USD/TRY from Reflector oracle + ${buy.spreadBps} bps spread (buy ${fmtRate(buy.rateMicro)}, sell ${fmtRate(sell.rateMicro)}). Amounts are decimal strings (TRY 2dp, USDC 7dp).`,
        '',
        '## Partner API quickstart',
        '1. POST /v1/partners {"email","password","name"} -> {api_key}. Send it as X-API-Key on every /v1 call.',
        '2. POST /v1/customers {first_name,last_name,iban?,tckn?} -> {id, deposit_reference, kyc_status:"approved"}.',
        '3. GET /v1/customers/{id}/deposit-instructions -> IBAN + reference to write in the transfer description.',
        '4. POST /v1/sandbox/bank-transfers {reference, amount_try} -> simulates the incoming TRY transfer; credits TRY balance.',
        '5. POST /v1/quotes {side:"buy",amount,amount_currency} -> rate locked 120s (optional).',
        '6. POST /v1/onramps {customer_id, amount_try|quote_id, destination_address} -> real testnet USDC to the wallet (payment, or claimable balance if no trustline). Poll GET /v1/onramps/{id}.',
        '7. Off-ramp: POST /v1/offramps {customer_id, amount_usdc} -> {deposit:{address,memo_type:"id",memo}}. Send USDC on-chain with that memo; TRY is credited and paid out to the IBAN. Poll GET /v1/offramps/{id}.',
        '8. Notifications: POST /v1/webhooks {url,events} (HMAC-signed) or poll GET /v1/events.',
        '',
        '## SEP door quickstart (wallets)',
        'SEP-1 stellar.toml at /.well-known/stellar.toml. SEP-10 auth: GET/POST /auth -> JWT (Bearer). SEP-6: /sep6/{info,deposit,withdraw,deposit-exchange,withdraw-exchange,transactions,transaction}.',
        'SEP-12 simulated KYC (no personal data required). SEP-38 quotes: iso4217:TRY <-> stellar:USDC:<issuer>. Deposits wait until the simulated bank transfer is triggered at the transaction more_info_url (/sep6/tx/{id}).',
        'A real completed SEP-6 round trip (with on-chain proof links) is documented at /see-it-run.',
        '',
        '## Statuses',
        'On-ramp: pending -> completed | failed (TRY refunded). settlement: payment | claimable_balance.',
        'Off-ramp: awaiting_deposit -> completed | cancelled.',
        'SEP-6: pending_user_transfer_start -> pending_anchor -> pending_stellar -> completed | error.',
        '',
        '## Errors',
        'JSON {"error":{"code","message","details?"}}. 400 validation/invalid_iban/invalid_tckn; 401 unauthorized; 404 not_found; 409 email_taken/duplicate_external_id; 422 insufficient_balance/kyc_not_approved/quote_expired/quote_consumed/below_minimum/missing_iban; 502 stellar_error.',
        '',
        '## What changes on mainnet',
        'Auth likely becomes OAuth2 client-credentials (JWT + refresh, scopes, IP allowlist). The ramp may decompose into deposit + swap (quote->confirm, commission) + crypto withdrawal to a pre-registered address. Real compliance fields (travel-rule originator, purpose, source_of_funds), 2FA, per-tier limits. Fiat deposits may be observe-only. Notifications may be a websocket. Mainnet USDC issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN. See /mainnet.',
        '',
        '## All API endpoints',
        ...endpointBlock,
      ].join('\n'),
      200,
      { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    );
  });

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
      sep: { signing_key: sep.signingKeypair.publicKey(), web_auth_endpoint: `${cfg.publicUrl}/auth`, transfer_server: `${cfg.publicUrl}/sep6`, kyc_server: `${cfg.publicUrl}/sep12`, anchor_quote_server: `${cfg.publicUrl}/sep38` },
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
        `- Full reference in one document: ${cfg.publicUrl}/llms-full.txt`,
        `- Sitemap (Markdown): ${cfg.publicUrl}/sitemap.md`,
        `- Guide (concepts, flows, errors, webhooks, glossary): ${cfg.publicUrl}/guide`,
        `- Mainnet expectations (what changes in production, readiness checklist): ${cfg.publicUrl}/mainnet`,
        `- Interactive end-to-end demo: ${cfg.publicUrl}/demo`,
        `- See it run (a real completed SEP-6 round trip, with on-chain proof): ${cfg.publicUrl}/see-it-run`,
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
        '',
        '## SEP door (wallets)',
        `- SEP-1: ${cfg.publicUrl}/.well-known/stellar.toml (TRANSFER_SERVER, WEB_AUTH_ENDPOINT, KYC_SERVER, ANCHOR_QUOTE_SERVER, SIGNING_KEY)`,
        `- SEP-10: GET/POST ${cfg.publicUrl}/auth -> JWT`,
        `- SEP-6: ${cfg.publicUrl}/sep6/{info,deposit,deposit-exchange,withdraw,withdraw-exchange,transactions,transaction}. Deposits: bank details + reference; simulate the TRY arrival at more_info_url. Withdrawals: treasury account + memo id; pay real testnet USDC.`,
        `- SEP-12: ${cfg.publicUrl}/sep12/customer (simulated KYC, no personal data required, all fields optional)`,
        `- SEP-38: ${cfg.publicUrl}/sep38/{info,prices,price,quote} (iso4217:TRY <-> stellar:USDC:<issuer>)`,
      ].join('\n'),
    ),
  );

  app.get('/.well-known/stellar.toml', (c) =>
    c.text(
      [
        'VERSION="2.7.0"',
        `NETWORK_PASSPHRASE="${cfg.networkPassphrase}"`,
        `SIGNING_KEY="${sep.signingKeypair.publicKey()}"`,
        `WEB_AUTH_ENDPOINT="${cfg.publicUrl}/auth"`,
        `TRANSFER_SERVER="${cfg.publicUrl}/sep6"`,
        `KYC_SERVER="${cfg.publicUrl}/sep12"`,
        `ANCHOR_QUOTE_SERVER="${cfg.publicUrl}/sep38"`,
        `ACCOUNTS=["${stellar.treasuryPublicKey}", "${sep.signingKeypair.publicKey()}"]`,
        '',
        '[DOCUMENTATION]',
        'ORG_NAME="TR Mock Anchor (testnet sandbox)"',
        `ORG_URL="${cfg.publicUrl}"`,
        'ORG_DESCRIPTION="Mock Turkish TRY <-> USDC ramp for Stellar testnet builders. Not a real financial service. No real money moves."',
        '',
        '[[CURRENCIES]]',
        `code="${stellar.assetCode}"`,
        `issuer="${stellar.assetIssuer}"`,
        'status="test"',
        'display_decimals=2',
        'is_asset_anchored=true',
        'anchor_asset_type="fiat"',
        'anchor_asset="TRY"',
        'desc="USDC on Stellar testnet (Circle testnet issuer unless overridden). This anchor ramps it against TRY via SEP-6 or its partner API."',
        '',
      ].join('\n'),
      200,
      { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' },
    ),
  );

  return app;
}
