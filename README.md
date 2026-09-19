# ZKPassport mock anchor

Experimental fork of [Kaan's TR Mock Anchor](https://github.com/kaankacar/tr-mock-anchor), based on commit `81eef8af29fa8fdc6f6596a4472c8bedb5381668`. Work lives on `feat/zkpassport-anchor` in [0x471/tr-mock-anchor](https://github.com/0x471/tr-mock-anchor/tree/feat/zkpassport-anchor).

This is a Testnet-only development project. It is not an audited verifier or a production anchor. Fresh country-proof acceptance, full settlement and public hosting are still being tested. Upstream hosted URLs do not run this fork.

## Current deposit and withdrawal demo

The `/anchor-gate` browser interface implements real SEP-10 wallet authentication,
exact SEP-38 quotes and wallet-signed native proof calls. It requires Freighter
on Testnet and a trustline to the configured mock asset. A configured hosted
demo admits specific public wallets; never paste a wallet secret into the UI.

The selected policy is age >=18, nationality TUR and document issuer TUR using
synthetic ZKPassport developer-mode documents. Both country attributes are
required; residence is not inferred. This profile uses OuterCount7, not the
age-only diagnostic profile described below.

- Deposit: provider tokens are reserved in the vault; native proof acceptance
  and a separate simulated TRY receipt are required before token payout.
- Withdrawal: the first accepted, wallet-authorized proof escrows exact tokens.
  The notary must authorize one fixed simulated TRY payout while eligibility is
  current. Paid-receipt reconciliation and release to the provider may finish
  later without authorizing another payout.
- No cancellation, refund or provider reclaim exists. Expired unresolved
  reservations remain held. Do not send real funds or use real documents.

The localhost validation vault is deployed at
`CDGRHNKXIW4AN7T2UIFW4X33TXD7V7BY63XTNC2RX5JKKJM5ADJZXKR7`.
Its country verifier and executable identity have been independently checked,
and one authenticated deposit reservation is confirmed. Fresh Outer7 proof
acceptance and completed deposits/withdrawals are not yet claimed.

See [the implemented API and recovery model](docs/ANCHOR_GATE_INTEGRATION.md),
[contract rules](docs/GATE_VAULT_DESIGN.md), and
[deployment evidence](docs/TESTNET_GATE_DEPLOYMENT.md). A public hostname needs
its own immutable-domain deployment, not reuse of the localhost vault.

## What works

- A fixed ZKPassport 0.20.0 BB5 `OuterCount5` proof is verified natively in Soroban, including both outer and deferred recursive pairing equations.
- A committed [Testnet verification transaction](https://stellar.expert/explorer/testnet/tx/1565ddf72714fc9dcc37e97030bbc5ac850244a1580266090b978222f9967494) returned `true` at ledger 4766089.
- Authenticated proof diagnostics execute the deployed contract through read-only RPC simulation.
- Default `ANCHOR_MODE=zkpassport` holds legacy orders, bank simulation, queued settlement and treasury payments. The separately configured native gate uses its own constrained path. SEP-12 does not approve identity.
- A fresh browser-origin synthetic phone request completed and its supported proof returned `math_valid` in native Testnet simulation at ledger 4766664.

The committed transaction above uses an official historical synthetic-document fixture from July 2026. The fresh phone result is separate: it used read-only RPC simulation, not a newly committed verification transaction. Neither result proves real identity or payment eligibility, and one successful phone run does not establish compatibility with every app build.

## Trust boundary

The deployed verifier checks mathematics. The `/zkpassport/proofs` API records the RPC result, not a committed verification receipt. It stores proof/public-input hashes and the authenticated SEP-10 subject, not raw proof bytes. The separate loopback browser helper is a compatibility test, not this SEP-10 submission path or an identity decision.

`math_valid` is deliberately separate from authorization. The proof API path is:

```text
Phone proof -> SEP-10 authenticated submission -> native Soroban simulation
                                                -> math result + hashes
                                                -> no KYC approval
                                                -> no payout

Implemented gate path, awaiting full live acceptance:
Order + wallet authorization -> on-chain policy + native verifier
                            -> single-use order authorization
Mock bank receipt + authorized order -> contract-controlled asset transfer
```

The new gate pins trusted document/circuit roots, exact policy commitments,
domain/scope, freshness, network/contract/recipient/amount binding, wallet
authorization and replay protection. Its vault controls reserved settlement
assets. A backend flag cannot constrain someone holding a classic treasury
signing key, which is why legacy treasury payouts stay disabled.

Explicit `ANCHOR_MODE=legacy` restores the upstream simulated-KYC, ungated Testnet flow. It is a separate testing mode, not a ZKPassport bypass that is safe for a gated demo. Do not use real assets or customer documents.

## Local setup

Use Node.js 24 and the existing npm lockfile:

```sh
npm ci
pnpm hooks:install
npm run typecheck
npm test
```

For an offline anchor with live proof-verifier RPC, no treasury secret is needed:

```sh
ANCHOR_MODE=zkpassport STELLAR_MODE=fake RATE_SOURCE=static WORKERS=false npm start
```

Open `http://localhost:8787`. This starts the fork locally, not at the upstream public service. Existing `.env` values are loaded by the server; explicit environment values above take precedence. Use a separate `DB_PATH` for experiments rather than reusing an upstream database.

See [.env.example](.env.example) for other settings and [CONTRIBUTING.md](CONTRIBUTING.md) for ASCII and commit rules. Hooks enforce only a local subset. CI separately checks Node and Rust/Wasm.

## Proof API

1. Authenticate the submitting wallet using SEP-10 at `/auth`.
2. Read `GET /zkpassport/info` for the pinned verifier profile.
3. Send `POST /zkpassport/proofs` with the SEP-10 bearer token and JSON:

```json
{
  "proof": "<9888 bytes encoded as hex>",
  "public_inputs": "<10 canonical 32-byte fields encoded as hex>"
}
```

Optional lowercase `0x` prefixes are accepted. The body limit is 24,576 bytes; extra JSON fields are rejected. Proof material reaches the configured Testnet RPC provider and is not automatically published in a transaction.

Responses distinguish `math_valid` (201), `invalid` (422) and `verifier_unavailable` (503). Every response has `eligibility_status: "unbound"` and `payout_authorized: false`. `GET /zkpassport/proofs/:id` requires the same customer and exact SEP-10 subject, including any memo.

This diagnostic API is not a production public ingress: rate limiting, retention policy and operational hardening remain required before exposure.

## Fresh phone compatibility test

Use the installed ZKPassport app's developer mode and synthetic documents only. Start the browser-origin helper:

```sh
npm run zkpassport:browser -- --dev-mode
```

Open the printed `http://localhost:8792` URL in the computer's browser, not `127.0.0.1` and not the phone's browser. Click **Create synthetic request**. Copy the generated request link to the phone, or use the browser's QR-sharing feature if available; the diagnostic page has no built-in QR renderer. Keep the browser tab and server running. The default session expires ten minutes after server startup, not ten minutes after clicking the button; restart the helper for a new session.

Read the milestones and compatibility summary in the browser, not the terminal. The request asks for age >=18 and a nonce-bound diagnostic digest using `compressed-evm` and a non-salted identifier. The SDK cannot pin the phone's circuit version. Default mode does not save a proof export. Optional `--out /absolute/scratch/proof-export.json` explicitly writes sensitive proof/public inputs to a new owner-only file; never commit or share it. The diagnostic digest is not a payout order.

Do not use direct Node-created SDK sessions for this phone flow. The production relay reported their origin as `nodejs`, which the reviewed mobile origin check rejected for `localhost`, even with developer mode enabled. A genuine browser-origin request fixed the observed pre-Verify failure; origin checks were not weakened or spoofed. See [phone diagnostics](docs/PHONE_DIAGNOSTICS.md) for the diagnosis and successful run.

The fresh run received a 9888-byte proof and 320-byte public inputs. Its summary reported `profile: "supported"`, `math_status: "math_valid"`, and all four request checks true: scopes, commitments, recent timestamp, and non-salted test profile. It still reported `eligibility_status: "not_evaluated"` and `payout_authorized: false`.

Only the exact supported version, key and encoding are sent to the deployed Testnet verifier for simulation. Unsupported output is reported honestly rather than converted into approval. SDK callbacks do not establish proof validity. Local scope/commitment checks are diagnostics, not an on-chain eligibility gate.

## Contract and evidence

Testnet contract:
`CB2R3TF45CASFOJS7KHFDWOYKDVBHOYBRSIQLSPLE4SDXXT75WUOM7JI`

Wasm SHA-256:
`4fa267bfa781adddddd91ee1a89eebbab317f32979e7b00d86ad46da898e2656`

See the [contract README](contracts/zkpassport-verifier/README.md) for the exact proof format, toolchain, local and Wasm tests, resource measurements, live checks and limitations. See [NOTICE](contracts/zkpassport-verifier/NOTICE.md) and [fixture provenance](contracts/zkpassport-verifier/fixtures/PROVENANCE.md) for attribution and source pins.

Original anchor documentation remains available in [upstream at the fork point](https://github.com/kaankacar/tr-mock-anchor/tree/81eef8af29fa8fdc6f6596a4472c8bedb5381668). Its autoapproval and payout instructions apply only to explicit legacy mode.
