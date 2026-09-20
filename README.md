# ZKPassport mock anchor

Experimental fork of [Kaan's TR Mock Anchor](https://github.com/kaankacar/tr-mock-anchor), based on commit `81eef8af29fa8fdc6f6596a4472c8bedb5381668`. Work lives on `feat/zkpassport-anchor` in [0x471/tr-mock-anchor](https://github.com/0x471/tr-mock-anchor/tree/feat/zkpassport-anchor).

This is a Testnet-only development project, not an audited verifier or a production anchor. Upstream hosted URLs do not run this fork. The public SEP deployment now has its own fresh Count8 phone-proof and deposit evidence, distinct from the older Count7 custom-vault runs.

## Standard-wallet anchor demo

Open the [public Testnet demo](https://tr-anchor-zkpassport.up.railway.app/anchor).
Use synthetic documents and mock funds only.

The new `/anchor` interface uses SEP-1 discovery, SEP-10 login, SEP-38 firm
quotes, SEP-24 hosted onboarding and exchange-only SEP-6 transfers. First-time
users prove eligibility in the hosted ZKPassport interaction. Supported accounts
are admitted, self-custodial classic G accounts; muxed, omnibus and contract
wallets are explicitly outside this demo profile. This is not a claim that all
optional SEP features or every wallet are supported.

- Deposit: accept an exact TRY-to-mock-USDC quote, prove eligibility, then
  record simulated TRY receipt. The vault releases the reserved tokens only
  with current native eligibility and the exact receipt.
- Withdraw: prove eligibility, then send an ordinary Stellar payment with the
  provided memo. The anchor observes it and moves the exact tokens into the
  vault. A separate explicit mock-bank action authorizes and records payout.
- Native eligibility is wallet-, domain-, contract-, network- and policy-bound.
  It can be reused until its original proof timestamp plus one hour, bounded by
  the immutable policy expiry. Old proofs cannot extend the grant.
- Withdrawal escrow can be refunded to its fixed owner before payout
  authorization, including after eligibility expiry. An unknown outcome must
  reconcile against the original hash, not create a replacement payment.

The public profile requires age >=18, synthetic nationality ZKR, synthetic
issuer ZKR and strict private sanctions-list non-membership. It uses the pinned
ZKPassport 0.20.0 OuterCount8 verifier. The private list snapshot is from January
2026, is an exact normalized match, and is **not** current production sanctions
compliance. A separate official OFAC digital-currency-address precheck runs on
the backend. Neither check establishes real identity, residence or bank ownership.

Native contract, compiled-Wasm and HTTP tests pass. At public source revision
`91fb27b`, a fresh synthetic Count8 phone proof was
[accepted onchain](https://stellar.expert/explorer/testnet/tx/08c7c414b6782886f55443c7179a2077f069561e0f5690519d8e22403a1e816e),
and a 100.00 simulated TRY deposit
[settled](https://stellar.expert/explorer/testnet/tx/14d7463f6cf8b176ca3f9d6d2ccd10c51e2c4fc8ecd58472fce96d2f4c2553f1)
for exactly 2.0947892 mock USDC to the user's wallet. The token events and
balance increase were independently checked. **Public withdrawal acceptance
and completed exchanges through unmodified target-wallet SEP interfaces remain
pending.** See [deployment evidence and the acceptance checklist](docs/SEP_ANCHOR_DEPLOYMENT.md).
The [release review](docs/SEP_ANCHOR_REVIEW.md) records resolved findings,
remaining acceptance work and the dependency-audit boundary.

Standard custody is a deliberate trust boundary: the provider controls tokens
before they enter the vault, and the watcher/notary attests which classic
payment funded an order. Soroban constrains vault release; it does not inspect
historical Horizon payments or cryptographically prove real fiat movement.
Keep one server replica with a persistent database and preserve all journals.

See [the interoperability profile](docs/SEP_ZKPASSPORT_INTEROPERABILITY.md) and
[the SEP contract](contracts/sep-anchor/README.md). The older contracts and their
orders are not migrated or modified by this deployment.

## Earlier custom-vault demo and evidence

The `/anchor-gate` browser interface implements real SEP-10 wallet authentication,
exact SEP-38 quotes and wallet-signed native proof calls. It requires Freighter
on Testnet and a trustline to the configured mock asset. A configured hosted
demo admits specific public wallets; never paste a wallet secret into the UI.

The selected synthetic demo policy is age >=18, nationality ZKR and document issuer ZKR using
synthetic ZKPassport developer-mode documents. Both country attributes are
required; residence is not inferred. This profile uses OuterCount7, not the
age-only diagnostic profile described below.

Use the bundled adult mock John Smith, synthetic date of birth 1995-11-12.
ZKR is the fictional Zero Knowledge Republic, not Turkish eligibility. The
initial TUR request was rejected with a nonmatching stock document. The tester
approved a separate ZKR deployment; the original TUR vault remains unchanged.
See [the fixture compatibility findings](docs/SYNTHETIC_DOCUMENT_SETUP.md).

- Deposit: provider tokens are reserved in the vault; native proof acceptance
  and a separate simulated TRY receipt are required before token payout.
- Withdrawal: the first accepted, wallet-authorized proof escrows exact tokens.
  The notary must authorize one fixed simulated TRY payout while eligibility is
  current. Paid-receipt reconciliation and release to the provider may finish
  later without authorizing another payout.
- No cancellation, refund or provider reclaim exists. Expired unresolved
  reservations remain held. Do not send real funds or use real documents.

The active localhost ZKR demo vault is deployed at
`CARWNKPAP5YAXFTZZJ7SFXKP4GGMCXRCA365XE75OQDTALQYXEYGJYSM`.
Its country verifier and executable identity have been independently checked.
A fresh browser-origin OuterCount7 phone proof was accepted in a committed
recipient-signed gate transaction. A separate mock-bank receipt and settlement
then completed exactly 100.00 simulated TRY for 2.0947892 mock USDC.
The recipient balance increased by that exact amount and the ZKR vault's
reservation was released; the original TUR vault remained unchanged.

A separate fresh withdrawal proof then escrowed exactly 1.0000000 mock USDC.
The notary authorized a fixed 47.26 simulated TRY payout, its paid receipt was
confirmed, and settlement released that escrow to the provider. The synthetic
bank credit is a local mock-bank record, not a real fiat transfer.

These older acceptance runs used a dedicated automated Testnet recipient through
the authenticated HTTP API, not an end-to-end Freighter browser run. Their phone
proofs came from a separate browser-origin capture harness. The separate public
Count8 deposit acceptance is recorded above; it does not migrate these orders
or establish public withdrawal acceptance.

See [the implemented API and recovery model](docs/ANCHOR_GATE_INTEGRATION.md),
[contract rules](docs/GATE_VAULT_DESIGN.md), and
[deployment evidence](docs/TESTNET_GATE_DEPLOYMENT.md). A public hostname needs
its own immutable-domain deployment, not reuse of the localhost vault.

## What works

- A fixed ZKPassport 0.20.0 BB5 `OuterCount5` proof is verified natively in Soroban, including both outer and deferred recursive pairing equations.
- A committed [Testnet verification transaction](https://stellar.expert/explorer/testnet/tx/1565ddf72714fc9dcc37e97030bbc5ac850244a1580266090b978222f9967494) returned `true` at ledger 4766089.
- Authenticated proof diagnostics execute the deployed contract through read-only RPC simulation.
- Default `ANCHOR_MODE=zkpassport` holds legacy orders, bank simulation, queued settlement and treasury payments. The separately configured native gate uses its own constrained path. SEP-12 does not approve identity.
- An earlier age-only browser-origin synthetic phone request completed and its supported proof returned `math_valid` in native Testnet simulation at ledger 4766664.
- A fresh ZKPassport 0.20.0 `OuterCount7` phone proof satisfied the order-bound age >=18, ZKR nationality and ZKR issuer policy in a [committed gate transaction](https://stellar.expert/explorer/testnet/tx/4a0e7e262c842241d16e81d45f5f969e8179f425ac8e5b9604c6488e26710d4e), ledger 4767724. The deposit [settled](https://stellar.expert/explorer/testnet/tx/b298032e175360003245750a06fce003789bfd4decb85d5dce87316a90d9a41e) at ledger 4767765 after a separate simulated-bank receipt.
- A separate fresh Count7 withdrawal [proof transaction](https://stellar.expert/explorer/testnet/tx/c53b5d37fcb830346b514fbd0b164c342e0930819bdca1bdac80e5c152b7b499), ledger 4767860, atomically escrowed 1.0000000 mock USDC. After notary payout authorization and a simulated-bank paid receipt, its [settlement](https://stellar.expert/explorer/testnet/tx/51ffbb7c5f207778949f4ff3c7f0b406f41fc19b7faf0f6a1bde6691b45250b1) succeeded at ledger 4767875.

The earlier OuterCount5 committed verification uses an official historical synthetic-document fixture from July 2026. The age-only phone diagnostic used read-only RPC simulation, not a committed transaction. The later OuterCount7 ZKR deposit and withdrawal are separate committed policy-and-settlement acceptance runs. None proves real identity or real fiat movement, and successful phone runs do not establish compatibility with every app build.

## Trust boundary

The deployed verifier checks mathematics. The `/zkpassport/proofs` API records the RPC result, not a committed verification receipt. It stores proof/public-input hashes and the authenticated SEP-10 subject, not raw proof bytes. The separate loopback browser helper is a compatibility test, not this SEP-10 submission path or an identity decision.

`math_valid` is deliberately separate from authorization. The proof API path is:

```text
Phone proof -> SEP-10 authenticated submission -> native Soroban simulation
                                                -> math result + hashes
                                                -> no KYC approval
                                                -> no payout

Gate deposit path (committed ZKR acceptance; withdrawal recorded above):
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
