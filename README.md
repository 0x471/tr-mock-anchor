# TR Mock Anchor

**A mock Turkish TRY ⇄ USDC on/off-ramp on Stellar testnet, for builders who need to integrate a TRY ramp before a production anchor exists.**

Live sandbox: **https://tr-mock-anchor.fly.dev**

| | |
| --- | --- |
| 🏠 [Home / sign up](https://tr-mock-anchor.fly.dev/) | Create an account with your email, get your single API key |
| ▶️ [How it works](https://tr-mock-anchor.fly.dev/demo) | Runs the whole round trip live in your browser: throwaway wallets, real testnet transactions |
| 📖 [Guide](https://tr-mock-anchor.fly.dev/guide) | Concepts, Turkish rails, flows, statuses, errors, webhooks, glossary (TR/EN) |
| 🧾 [API reference](https://tr-mock-anchor.fly.dev/docs) | Interactive OpenAPI 3.1 ([raw spec](https://tr-mock-anchor.fly.dev/openapi.json)) |
| 🎛 [Dashboard](https://tr-mock-anchor.fly.dev/dashboard) | Your key, a playground, live tables of customers / orders / events |
| 🤖 [llms.txt](https://tr-mock-anchor.fly.dev/llms.txt) · [stellar.toml](https://tr-mock-anchor.fly.dev/.well-known/stellar.toml) · [/health](https://tr-mock-anchor.fly.dev/health) | For agents, wallets and monitors |

> **TL;DR (TR):** Türkiye'deki borsaların onramp/offramp akışını taklit eden, Stellar testnet üzerinde çalışan bir
> mock anchor. Kullanıcı e-postasıyla kaydolur, tek bir API key alır. TL banka transferi *simüle* edilir
> (açıklamaya referans kodu yazma mantığıyla), TL bakiyesi USD/TRY kuruna göre USDC'ye çevrilir ve **gerçek testnet
> USDC** kullanıcının Stellar adresine gönderilir. Offramp tam tersi: memo ile USDC gönder, TL bakiyesi oluşur,
> IBAN'a ödeme simüle edilir. Banka, KYC ve ödeme sahte; Stellar tarafı gerçek.

<p align="center"><img src="docs/demo.png" alt="The interactive demo after a full run: eight steps completed with transaction links" width="820"></p>
<p align="center">
  <a href="docs/landing.png"><img src="docs/landing.png" alt="Landing page with signup" width="270"></a>
  <a href="docs/guide.png"><img src="docs/guide.png" alt="Guide" width="270"></a>
  <a href="docs/apidocs.png"><img src="docs/apidocs.png" alt="API reference" width="270"></a>
</p>

## Contents

- [Why this exists](#why-this-exists)
- [What is real and what is simulated](#what-is-real-and-what-is-simulated)
- [How a Turkish ramp works (and how the mock mirrors it)](#how-a-turkish-ramp-works-and-how-the-mock-mirrors-it)
- [Quickstart](#quickstart)
- [The interactive demo](#the-interactive-demo)
- [API overview](#api-overview)
- [Statuses, errors and events](#statuses-errors-and-events)
- [Pricing](#pricing)
- [Stellar details](#stellar-details)
- [Architecture](#architecture)
- [Running locally](#running-locally)
- [Testing](#testing)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Operating the sandbox](#operating-the-sandbox)
- [Security notes](#security-notes)
- [Limitations](#limitations)
- [Project layout](#project-layout)
- [License](#license)

## Why this exists

Turkish exchanges and payment institutions expose fiat ramps to partners through **API-key based REST APIs**: the
integrator owns the customer UI, holds a key, and drives the journey (register customer → show bank details → detect
deposit → convert → pay out on-chain). That is a different shape from the wallet-initiated SEP-24 / SEP-6 flows the
Stellar test anchor implements, and it is the shape hackathon and pilot builders will meet when a production
Turkish anchor launches.

This project gives them something to build against today: the same shape, the same vocabulary, real Stellar
settlement — and a simulated bank so the whole loop can be exercised in seconds without moving lira.

## What is real and what is simulated

| Piece | Status | Detail |
| --- | --- | --- |
| USDC paid to wallets on on-ramp | **Real (testnet)** | Payment from the treasury, or a claimable balance when the wallet is unfunded / has no trustline |
| USDC deposits detected on off-ramp | **Real (testnet)** | Horizon payments watcher, matched by memo id or muxed id |
| Rates | **Real, indicative** | USD/TRY from Reflector's FX oracle on Stellar mainnet, plus a flat spread; static fallback |
| Balances, ledger, quotes, orders, events, webhooks | **Real logic** | Fixed-point money math, append-only ledger, HMAC-signed webhooks with retries |
| Incoming TRY bank transfers | *Simulated* | `POST /v1/sandbox/bank-transfers` plays the bank; unknown references are held as `unmatched` |
| TRY payouts to IBANs | *Simulated* | Instant record with a FAST-style bank reference |
| KYC | *Simulated* | Instant approval; magic first names `REJECT` / `PENDING`; TCKN and IBAN checksums validated |

## How a Turkish ramp works (and how the mock mirrors it)

1. **Customer + KYC.** The app registers its user with the anchor (name, T.C. Kimlik No, IBAN). → `POST /v1/customers`
   returns `kyc_status` and a personal `deposit_reference` like `TRMA-7K2M-Q9XZ`.
2. **Bank transfer with a reference.** The customer sends TRY by FAST/EFT/Havale to the anchor's IBAN and writes the
   reference in the description (*açıklama*). → `GET /v1/customers/{id}/deposit-instructions` gives the app exactly
   what to show; `POST /v1/sandbox/bank-transfers` is the bank telling the anchor the money arrived.
3. **TRY balance.** The anchor matches the reference and credits the customer. Unmatched transfers wait for support.
4. **Buy USDC.** The customer converts at the USD/TRY rate. → `POST /v1/quotes` (locks a rate for 120 s) then
   `POST /v1/onramps` (debits TRY, pays USDC on Stellar).
5. **Off-ramp.** The customer sends USDC to the anchor with a memo; the anchor sells it for TRY and pays the IBAN.
   → `POST /v1/offramps` returns the deposit address + memo id; the watcher does the rest; `auto_payout` pays out.

```mermaid
sequenceDiagram
  autonumber
  participant App as Your app
  participant A as TR Mock Anchor
  participant S as Stellar testnet
  App->>A: POST /v1/customers
  A-->>App: deposit_reference
  App->>A: POST /v1/sandbox/bank-transfers (plays the bank)
  A-->>App: TRY balance credited · bank_transfer.received
  App->>A: POST /v1/quotes (buy) → POST /v1/onramps
  A->>S: payment / createClaimableBalance (USDC)
  A-->>App: onramp.completed + stellar_tx_hash
  App->>A: POST /v1/offramps
  A-->>App: treasury address + memo id
  App->>S: wallet pays USDC with memo
  S-->>A: payment seen on Horizon
  A-->>App: offramp.completed · payout.completed (TRY → IBAN, simulated)
```

## Quickstart

1. Sign up at https://tr-mock-anchor.fly.dev with your email; copy the API key from the dashboard
   (or `POST /v1/partners {"email","password","name"}`).
2. Get a testnet wallet (Freighter on testnet, or [Stellar Lab](https://lab.stellar.org/account/create)), fund it with
   Friendbot. A trustline to the sandbox's USDC is optional — without it you receive a claimable balance.
3. Run the flow:

```bash
export BASE=https://tr-mock-anchor.fly.dev
export KEY=trma_test_...

# 1) customer -> deposit reference
curl -s -X POST $BASE/v1/customers -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"first_name":"Ayşe","last_name":"Yılmaz","tckn":"10000000146","iban":"TR330006100519786457841326"}'
# {"id":"cus_...","deposit_reference":"TRMA-7K2M-Q9XZ","kyc_status":"approved", ...}

# 2) what the customer sees in your app
curl -s $BASE/v1/customers/cus_.../deposit-instructions -H "X-API-Key: $KEY"

# 3) play the bank: the transfer arrives with the reference in its description
curl -s -X POST $BASE/v1/sandbox/bank-transfers -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"reference":"TRMA-7K2M-Q9XZ","amount_try":"1000.00","sender_name":"Ayşe Yılmaz"}'

# 4) lock a rate and on-ramp
curl -s -X POST $BASE/v1/quotes -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"customer_id":"cus_...","side":"buy","amount":"1000.00","amount_currency":"TRY"}'
curl -s -X POST $BASE/v1/onramps -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"customer_id":"cus_...","quote_id":"qt_...","destination_address":"G..."}'
# poll GET /v1/onramps/{id} until status = completed → settlement, stellar_tx_hash, claimable_balance_id

# 5) off-ramp: get an address + memo, send USDC on-chain from the wallet, poll
curl -s -X POST $BASE/v1/offramps -H "X-API-Key: $KEY" -H 'content-type: application/json' \
  -d '{"customer_id":"cus_...","amount_usdc":"5.0000000"}'
# {"deposit":{"address":"G<treasury>","memo_type":"id","memo":"482913005771"},"status":"awaiting_deposit"}
# -> completed: received_usdc, amount_try, payout_id
```

JavaScript and Python versions of the same flow are pre-filled with your key in the dashboard's *Quickstart* panel.

## The interactive demo

[`/demo`](https://tr-mock-anchor.fly.dev/demo) is the end-to-end test turned into a page. It runs eight steps
against the live API and Stellar testnet from your browser, showing every request and response and linking every
transaction to stellar.expert:

1. create the customer → 2. show the bank details → 3. play the bank (300 TRY arrives) → 4. generate a throwaway
wallet, Friendbot-fund it and open a USDC trustline → 5. quote + on-ramp 100 TRY, verify the wallet balance on
Horizon → 6. on-ramp 100 TRY to a second wallet **without** a trustline, receive a claimable balance and claim it
→ 7. off-ramp: the wallet pays the USDC back with the memo, the anchor converts and pays the IBAN → 8. read the
ledger and events.

It uses your dashboard session if you are logged in, or a pasted key, or a temporary demo account. The whole run
takes about a minute and consumes ~4 USDC from the shared treasury, ~2 of which come back. Append `?autorun=1` to
start automatically (handy for livestreams).

## API overview

Base path `/v1`. Auth header `X-API-Key: <key>` (or `Authorization: Bearer <key>`). All amounts are decimal
**strings** — TRY has 2 decimals, USDC 7, rates 6. Pagination: `limit` (1–200, default 50) and `offset`.

| Area | Endpoints |
| --- | --- |
| Account | `POST /partners` (signup, returns the key) · `GET /partners/me` · `POST /partners/me/rotate-key` |
| Customers | `POST/GET /customers` · `GET/PATCH /customers/{id}` · `GET /customers/{id}/deposit-instructions` · `/balances` · `/ledger` · `/bank-transfers` |
| Rates & quotes | `GET /rates` · `POST /quotes` · `GET /quotes/{id}` |
| On-ramp | `POST/GET /onramps` · `GET /onramps/{id}` |
| Off-ramp | `POST/GET /offramps` · `GET /offramps/{id}` · `POST /offramps/{id}/cancel` |
| Payouts | `POST/GET /payouts` · `GET /payouts/{id}` |
| Webhooks & events | `POST/GET /webhooks` · `DELETE /webhooks/{id}` · `GET /webhooks/{id}/deliveries` · `GET /events` |
| Sandbox | `POST/GET /sandbox/bank-transfers` · `POST /sandbox/bank-transfers/{id}/assign` · `POST /sandbox/customers/{id}/kyc` · `GET /sandbox/treasury` · `GET /sandbox/unmatched-deposits` · `POST /sandbox/usdc-deposits` (fake-Stellar mode only) |
| Public (no auth) | `GET /health` · `/openapi.json` · `/docs` · `/guide` · `/demo` · `/llms.txt` · `/.well-known/stellar.toml` |

The full field-level reference is the OpenAPI document; the [guide](https://tr-mock-anchor.fly.dev/guide) explains
the model behind it.

## Statuses, errors and events

- **On-ramp:** `pending` → `completed` | `failed` (TRY refunded). `pending_reason` explains waits
  (`treasury_low`, `retrying: …`). `settlement` is `payment` or `claimable_balance`.
- **Off-ramp:** `awaiting_deposit` → `completed` | `cancelled`. The **received** amount is converted, not
  `expected_usdc`. Rate locked for 30 min, then `repriced: true`. Deposits that cannot be attributed (no memo, unknown
  memo, cancelled order) land in `GET /v1/sandbox/unmatched-deposits`.
- **Errors** are `{"error":{"code","message","details"?}}`. Business-rule failures are `422`: `insufficient_balance`,
  `kyc_not_approved`, `quote_expired`, `quote_consumed`, `quote_side_mismatch`, `below_minimum`, `above_maximum`,
  `missing_iban`, `not_cancellable`, `live_stellar`. Validation is `400`, auth `401`, uniqueness `409`.
- **Events** (`customer.created`, `customer.kyc_updated`, `bank_transfer.received`, `bank_transfer.unmatched`,
  `onramp.created`, `onramp.completed`, `onramp.failed`, `offramp.created`, `offramp.deposit_received`,
  `offramp.completed`, `payout.completed`) are delivered by webhook and readable via `GET /v1/events?after=<id>`.
- **Webhook signature:** `X-TRMA-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`, plus
  `X-TRMA-Event` and `X-TRMA-Delivery`. Retries at 5 s, 30 s, 2 min, 10 min. Verification snippets (Node, Python)
  are in the guide.

## Pricing

`GET /v1/rates` returns `mid_rate` (USD/TRY read from Reflector's FX feed on Stellar **mainnet**, contract
`CBKGPWGKSKZF52CFHMTRR23TBWTPMRDIYZ4O2P5VS65BMHYH4DXMCJZC`, via `simulateTransaction`, cached 60 s), `buy_rate` =
mid × (1 + spread) and `sell_rate` = mid × (1 − spread). The spread is `SPREAD_BPS` (default 50) and there are no
fixed fees, so a full round trip costs ≈ 1 %. USDC is treated as 1 USD. If the oracle is unreachable the service
falls back to `STATIC_USDTRY` and reports `rate_source: "static_fallback"`. Quotes are single-use and valid 120 s.

## Stellar details

| | |
| --- | --- |
| Network | Testnet — `Test SDF Network ; September 2015` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Asset | `USDC` issued by Circle's testnet issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` (authoritative: `GET /health`) |
| Treasury | `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6` — pays every on-ramp, receives every off-ramp |
| Off-ramp routing | `memo_type: id` (12-digit id) or a muxed `M…` address with that id |
| First-time wallets | No account / no trustline → claimable balance with the destination as sole unconditional claimant |
| Memos on on-ramps | Optional text memo, ≤ 28 bytes |
| stellar.toml | SEP-1, informational only — this anchor does not implement SEP-10/24/31 |

## Architecture

```
                 ┌──────────────── Hono (Node 24) ────────────────┐
 browser ──────▶ │ public pages  /  /dashboard  /demo  /guide  /docs│
 your backend ─▶ │ /v1/* (X-API-Key)  ─┐                           │
                 │ /ui/* (session)     ├─▶ routes ─▶ core (ledger,  │
                 │                     │            events, money) │
                 └─────────────────────┼───────────┬───────────────┘
                                       ▼           ▼
                                  node:sqlite   workers (3 loops)
                                  (WAL, one     ├─ settleOnramps   ─▶ Horizon: payment / claimable balance
                                   file)        ├─ watchOfframps   ◀─ Horizon: payments to treasury (cursor persisted)
                                                └─ deliverWebhooks ─▶ partner URLs (HMAC, retries)
                                  rates ◀── Reflector FX oracle (mainnet RPC, simulateTransaction) / static
```

- **One process, one SQLite file.** All writes go through `tx()`; balance changes are ledger entries written in the
  same transaction as the state change and the event they emit.
- **Money is bigint fixed-point.** Kuruş for TRY, stroops for USDC, micro-units for rates. Conversions floor toward
  the anchor; "solve for the source amount" variants ceil.
- **Stellar is behind an interface** (`StellarGateway`) with a live Horizon implementation and an in-memory fake, so
  the whole API can be tested offline (`STELLAR_MODE=fake`).
- **Nothing throws after a transaction is submitted.** Post-submit lookups (claimable balance id via Horizon effects)
  are best-effort, so a retry can never pay twice.
- **Per-account isolation.** Every row carries `partner_id`; API keys are looked up by SHA-256 hash.

## Running locally

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native dependencies).

```bash
npm install
cp .env.example .env
npm run setup:treasury          # creates a testnet account + USDC trustline, prints TREASURY_SECRET
# paste TREASURY_SECRET into .env, then fund the treasury (see "Operating the sandbox")
npm run dev                     # http://localhost:8787 — API, dashboard, demo, guide, docs
```

Offline / CI: `STELLAR_MODE=fake RATE_SOURCE=static npm run dev` runs with an in-memory chain; then
`POST /v1/sandbox/usdc-deposits` stands in for the wallet's payment. The `/demo` page needs live mode.

## Testing

```bash
npm test          # vitest: money math, IBAN/TCKN, full API flow (in-memory DB + fake Stellar), webhooks
npm run typecheck
npm run e2e       # against a RUNNING server: creates wallets, moves real testnet USDC, asserts balances on Horizon
```

`scripts/e2e.ts` performs the same eight steps as the `/demo` page from Node: on-ramp as payment, on-ramp as
claimable balance (then claims it), off-ramp with memo, payout — and fails loudly if any on-chain balance disagrees
with the API. Run it against production with `BASE_URL=https://tr-mock-anchor.fly.dev npm run e2e`.

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT`, `PUBLIC_URL` | `8787`, `http://localhost:8787` | Listening port; public origin used in stellar.toml, OpenAPI servers, secure cookies |
| `DB_PATH` | `./data/anchor.db` | SQLite file (`:memory:` allowed) |
| `STELLAR_MODE` | `live` | `live` = Horizon testnet, `fake` = in-memory chain |
| `HORIZON_URL`, `NETWORK_PASSPHRASE` | testnet | Stellar network |
| `USDC_ISSUER` | Circle testnet issuer | Asset issuer; point at a self-issued asset for load tests |
| `TREASURY_SECRET` | — | Treasury signing key (required in live mode) |
| `RATE_SOURCE`, `STATIC_USDTRY` | `reflector`, `47.50` | Rate source and fallback |
| `SPREAD_BPS`, `QUOTE_TTL_SECONDS`, `OFFRAMP_RATE_LOCK_SECONDS` | `50`, `120`, `1800` | Pricing behaviour |
| `MIN_ONRAMP_TRY`, `MAX_ONRAMP_TRY`, `MIN_OFFRAMP_USDC` | `50.00`, `250000.00`, `1.0000000` | Order limits |
| `BANK_NAME`, `ACCOUNT_HOLDER`, `ANCHOR_IBAN` | mock bank identity | Shown in deposit instructions |
| `SESSION_SECRET` | auto-generated, persisted in DB | Signs dashboard session cookies |
| `WORKERS`, `*_POLL_MS` | `true`, 3000/5000/2000 | Background loops |

## Deployment

The service is one Node process with a SQLite file and background workers, so it wants a host that keeps a single
instance running on a persistent disk. The live sandbox runs on Fly.io from the included `Dockerfile` and `fly.toml`
(single machine, 1 GB volume at `/data`, `auto_stop_machines = "off"` so the workers keep running):

```bash
fly apps create tr-mock-anchor
fly volumes create anchor_data --region fra --size 1 --app tr-mock-anchor
fly secrets set TREASURY_SECRET=S... SESSION_SECRET=$(openssl rand -hex 32) --app tr-mock-anchor --stage
fly deploy --app tr-mock-anchor --ha=false
```

Set `PUBLIC_URL` in `fly.toml` to the public origin. Redeploys are `fly deploy --app tr-mock-anchor --ha=false`.
Any Docker host with a persistent volume works the same way (`docker build -t tr-mock-anchor . && docker run -p 8787:8787 -v anchor:/data --env-file .env tr-mock-anchor`).

## Operating the sandbox

**Funding the treasury.** On-ramps pay USDC out of the treasury and off-ramps pay it back, so usage roughly recycles
the same pool. To add Circle-issued testnet USDC:

- Send any amount to the treasury address from a wallet that holds testnet USDC (no memo needed; the watcher parks
  it as an unmatched deposit, which is harmless).
- Or use [Circle's faucet](https://faucet.circle.com) → *Stellar Testnet* → treasury address: **20 USDC per address
  every 2 hours** (reCAPTCHA, no login). Request to several helper accounts and consolidate with
  `SWEEP_SECRETS=S...,S... npm run sweep`. Circle's Discord handles larger requests.
- For load tests where wallets don't need Circle's issuer, `npm run mock:usdc` issues a self-controlled `USDC` on
  testnet and mints 1,000,000 to the treasury; run the anchor with that `USDC_ISSUER`.

**Monitoring.** `GET /health` reports treasury balance (`low_balance` below 100 USDC), rate source and mode; the
dashboard and demo show the same. On-ramps never fail for lack of funds — they wait with
`pending_reason: "treasury_low"` and settle when funds arrive. Logs: `fly logs --app tr-mock-anchor`.

**Data.** Everything lives in the SQLite file on the volume (Fly snapshots it daily). Wiping it resets all accounts,
customers and orders; the treasury and its on-chain history are unaffected.

## Security notes

- This is a **testnet sandbox**. API keys grant access to mock balances only. They are stored in clear so the
  dashboard can display them again; rotate from the dashboard or `POST /v1/partners/me/rotate-key`.
- Passwords are scrypt-hashed; sessions are HMAC-signed cookies (`SESSION_SECRET`).
- CORS is open (`*`) so hackathon prototypes can call the API from a browser, but an API key is a server credential:
  keep it in a backend and use the browser only for the wallet side.
- The treasury secret lives only in the server's environment (`.env` locally, Fly secrets in production).
- Never reuse sandbox passwords or keys anywhere else.

## Limitations

- No real bank, KYC, compliance, or payout rails. The bank is you.
- Single treasury and single process: settlement is sequential (a few seconds per on-ramp).
- Off-ramp detection polls Horizon every 5 s and matches only `memo_type: id` or muxed ids.
- Rates are indicative; the spread is a flat number, not an order book.
- A shared sandbox may be reset. Do not build anything that depends on its data persisting.

## Project layout

```
src/
  index.ts, server.ts, app.ts    bootstrap, Hono app, error handling, auth wiring
  config.ts                      env → typed config
  db.ts                          node:sqlite schema, tx() helper, kv
  money.ts                       bigint fixed-point TRY/USDC/rate math
  turkey.ts                      TR IBAN (mod-97), TCKN checksum, deposit references
  rates.ts                       Reflector oracle client, cache, spread, static fallback
  stellar.ts                     StellarGateway: live Horizon implementation + in-memory fake
  workers.ts                     on-ramp settlement, off-ramp watcher, webhook delivery
  session.ts, auth.ts            dashboard cookies, API-key middleware
  routes/                        partners, customers, quotes, onramps, offramps, payouts, webhooks, sandbox, ui, public
  core/                          ledger, events, serializers, account model, row types
  openapi.ts                     OpenAPI 3.1 document
public/                          index (signup), dashboard (key + playground), demo (interactive e2e), guide, docs, style.css
scripts/                         setup-treasury, issue-mock-usdc, sweep, e2e
test/                            vitest suites
docs/                            screenshots
Dockerfile, fly.toml             deployment
```

## License

[MIT](LICENSE). TR Mock Anchor is not a bank, an exchange or a licensed payment institution, and it moves no real money.
