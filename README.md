# ZKPassport mock anchor

Experimental fork of [Kaan's TR Mock Anchor](https://github.com/kaankacar/tr-mock-anchor), based on commit `81eef8af29fa8fdc6f6596a4472c8bedb5381668`. Work lives on `feat/zkpassport-anchor` in [0x471/tr-mock-anchor](https://github.com/0x471/tr-mock-anchor/tree/feat/zkpassport-anchor).

This is a Testnet-only development project. It is not an audited verifier, a production anchor, or a completed proof-gated payout system. Upstream hosted URLs do not run this fork.

## What works

- A fixed ZKPassport 0.20.0 BB5 `OuterCount5` proof is verified natively in Soroban, including both outer and deferred recursive pairing equations.
- A committed [Testnet verification transaction](https://stellar.expert/explorer/testnet/tx/1565ddf72714fc9dcc37e97030bbc5ac850244a1580266090b978222f9967494) returned `true` at ledger 4766089.
- Authenticated proof diagnostics execute the deployed contract through read-only RPC simulation.
- Default `ANCHOR_MODE=zkpassport` holds new orders, bank simulation, queued settlement and gateway payments. SEP-12 does not approve identity.
- An opt-in SDK diagnostic requests a fresh synthetic phone proof for compatibility testing.

The positive fixture is an official historical synthetic-document proof from July 2026. It is not proof of the current user's identity, age or payment eligibility. Current phone-app compatibility still requires a fresh proof.

## Trust boundary

The deployed verifier checks mathematics. The backend diagnostic records the RPC result, not a committed verification receipt. It stores proof/public-input hashes and the authenticated SEP-10 subject, not raw proof bytes.

`math_valid` is deliberately separate from authorization:

```text
Phone proof -> SEP-10 authenticated submission -> native Soroban simulation
                                                -> math result + hashes
                                                -> no KYC approval
                                                -> no payout

Future required path:
Order + wallet authorization -> on-chain policy + native verifier
                            -> single-use order authorization
Mock bank receipt + authorized order -> contract-controlled asset transfer
```

A proper on-chain gate still needs trusted document/circuit roots, exact policy commitments, domain/scope, freshness, network/contract/recipient/amount binding, wallet authorization and replay protection. Its vault must control settlement assets. A backend flag cannot constrain someone holding a classic treasury signing key.

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

Use the installed ZKPassport app's developer mode and synthetic documents only:

```sh
npx --no-install tsx scripts/request-zkpassport.ts --help
npx --no-install tsx scripts/request-zkpassport.ts \
  --domain localhost --dev-mode --timeout-seconds 600
```

The command prints a request URL. Open it on the phone within ten minutes. It requests age >=18 and a nonce-bound diagnostic digest using `compressed-evm` and a non-salted identifier. The SDK cannot pin the phone's circuit version.

By default only a compatibility summary is retained in terminal output. `--out /absolute/scratch/proof-export.json` explicitly saves the captured proof and public inputs to a new, owner-only file; never commit it. Use `--recipient G...` to include a public Stellar account in the diagnostic digest. This digest is not a payout order.

Only the exact supported version, key and encoding are sent to the deployed Testnet verifier for simulation. Unsupported output is reported honestly rather than converted into approval. SDK callbacks do not establish proof validity. Local scope/commitment checks are diagnostics, not an on-chain eligibility gate.

## Contract and evidence

Testnet contract:
`CB2R3TF45CASFOJS7KHFDWOYKDVBHOYBRSIQLSPLE4SDXXT75WUOM7JI`

Wasm SHA-256:
`4fa267bfa781adddddd91ee1a89eebbab317f32979e7b00d86ad46da898e2656`

See the [contract README](contracts/zkpassport-verifier/README.md) for the exact proof format, toolchain, local and Wasm tests, resource measurements, live checks and limitations. See [NOTICE](contracts/zkpassport-verifier/NOTICE.md) and [fixture provenance](contracts/zkpassport-verifier/fixtures/PROVENANCE.md) for attribution and source pins.

Original anchor documentation remains available in [upstream at the fork point](https://github.com/kaankacar/tr-mock-anchor/tree/81eef8af29fa8fdc6f6596a4472c8bedb5381668). Its autoapproval and payout instructions apply only to explicit legacy mode.
