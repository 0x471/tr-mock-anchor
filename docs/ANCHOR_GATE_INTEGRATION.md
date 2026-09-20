# Native proof-gated anchor integration

Updated 20 September 2026. This describes implemented v2 interfaces and local
tests. Fresh synthetic phone proofs and authenticated HTTP deposit and
withdrawal runs have also completed native Testnet acceptance and settlement.
The full Freighter browser run and public hosting remain pending. See the
[deployment record](TESTNET_GATE_DEPLOYMENT.md) for the current evidence.

The configured policy is immutable onchain. The selected demo requires age
18+, ZKR nationality and ZKR issuing country, synthetic ZKPassport developer
documents, a matching Outer7 verifier, simulated TRY and Testnet tokens.
ZKR is a mock jurisdiction, not Turkish eligibility. The original TUR-policy
vault is a separate, unchanged deployment with its initial reservation held.
A browser callback alone grants no eligibility or payout permission.

The approved age, bind, nationality and issuer predicates require Outer7:
10240 proof bytes plus 12 separate 32-byte public inputs (384 bytes).
The SDK's combined prefix-and-proof form is 10624 bytes; the API receives the
two components separately. Padding an Outer5/6 proof is not compatible.

## Modules and authority

- `src/anchor-gate.ts` owns exact quotes, authenticated orders, proof handoff,
  mock-bank transitions and reconciliation. HTTP handlers do not grant
  eligibility or assemble financial SQL independently.
- `src/anchor-gate-rpc.ts` maps the fixed Soroban ABI using Stellar SDK 17,
  checks the RPC network, signs provider/notary calls and prepares unsigned
  recipient proof calls. `src/anchor-gate-types.ts` is that external-chain seam.
- `src/routes/anchor-gate.ts` applies SEP-10 JWT signature, issuer, timing and
  header checks, plain-G-account ownership, demo admission and request limits.
- `contracts/anchor-gate` controls reservations and escrow. Its native verifier
  checks proof mathematics; its policy checks roots, predicates, freshness and
  exact wallet/order/direction/beneficiary binding.
- `web/anchor-gate-flow.ts`, `web/anchor-gate.ts` and matching HTML implement
  wallet and phone state. `src/anchor-gate-browser.ts` serves the prebuilt bundle
  on the anchor's origin. The loopback diagnostic remains separate.

Existing SEP-10 challenge signing and SEP-38 pricing are reused. The legacy
SEP-6 handlers, treasury `sendUsdc`, customer TRY balances and workers are not
the gated settlement path. Their strict-mode policy hold remains intact.
The custom proof-and-wallet flow is not a claim of full SEP-6 conformance.

## Public and authenticated API

Public: `GET /anchor-gate`, `GET /anchor-gate/bundle.js` and
`GET /anchor-gate/info`. Info exposes enabled status, Testnet passphrase,
full deposit asset identifiers, fee cap and public immutable configuration.
It never includes signer secrets. Disabled configuration fails closed.

Use `GET /auth?account=G...`, sign the actual SEP-10 challenge with the wallet,
then `POST /auth {transaction}` to obtain a bearer token. Firm quotes use the
existing authenticated `POST /sep38/quote`. Deposit sells `iso4217:TRY` and
buys the exact `stellar:USDC:<issuer>`; withdrawal reverses that pair.

Every route below requires the admitted owner wallet's SEP-10 token:

| Route under /anchor-gate          | Input and effect                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET /orders/access                | Authenticated wallet admission and optional OFAC listed-address precheck; does not reserve an order.                  |
| POST /orders                      | `{quote_id,direction,bank_destination?}` plus `Idempotency-Key`; direction is deposit or withdrawal, default deposit. |
| GET /orders/:id                   | Reconcile known transactions and return confirmed contract state and fixed terms.                                     |
| GET /orders/:id/proof-request     | Domain, scope, exact policy, custom_data digest, created_at, expiry and binary profile.                               |
| POST /orders/:id/prepare-proof    | `{proof,public_inputs}` as lowercase hex without 0x; prepare an unsigned recipient-source transaction.                |
| POST /orders/:id/submit           | `{action_id,signed_transaction}`; submit only the expected proof transaction.                                         |
| POST /orders/:id/authorize-payout | Withdrawal only; the backend notary authorizes the fixed payout onchain.                                              |
| POST /orders/:id/simulate-bank    | Deposit receipt or authorized withdrawal's simulated bank credit and paid receipt. No amount or destination override. |
| POST /orders/:id/settle           | Permissionless contract settlement submitted by the configured fee payer.                                             |

A withdrawal requires a synthetic destination matching
`^demo:[A-Za-z0-9_-]{1,64}$`, for example `demo:my-account`. Real IBANs,
names and bank account details are not accepted. Deposits must omit this field.
Its hash is SHA256 of JSON
`["anchor-mock-beneficiary-v1", authenticated_subject, destination]`.
The contract binds the resulting 32 bytes in its v2 XDR challenge.

Order responses include `direction`, wallet `recipient`, exact
`amount_try` and `amount_token`, `source_asset`, token/vault addresses,
`deadline`, `created_at`, `confirmed_ledger`, eligibility expiry,
`escrowed`, `payout_authorized_at`, receipt ID and action hashes/statuses.
`bank_destination` is the synthetic label. `mock_bank_credit` is null or
`{destination,amount_try,credited_at}`, with an ISO timestamp; it is explicitly
local simulated-bank evidence, not an onchain receipt or real fiat transfer.

## Immutable quotes, configuration and proof intent

SEP-38 creation snapshots complete sell/buy asset identifiers in `quote_assets`.
The gate rejects unsnapshotted legacy quotes and issuer/token mismatches.
One SQLite transaction checks ownership, direction, exact asset pair, positive
integer amounts, limits, unused status and current quote expiry, then reserves
the quote and stores the order. It never awaits RPC inside that SQL transaction.

The quoted TRY and token amounts are frozen without later repricing. The order
deadline is the lesser of policy expiry and the current confirmed ledger time
(or local time, if earlier) plus the contract's maximum order lifetime.
Quote validity is required at reservation, not extended by repricing. The
original quote expiry is still included in the quote hash.

The versioned quote hash commits to direction, beneficiary hash, Testnet,
vault/token, asset code and issuer, wallet, quote ID, exact amounts, rate metadata
and original quote expiry. Random order ID and nonce are 32 bytes. A deposit's
beneficiary hash is zero; a withdrawal's is nonzero.

The native v2 challenge additionally binds these terms, the confirmed order
creation time and the immutable policy hash in the exact ordered XDR layout
documented in `GATE_VAULT_DESIGN.md`. The phone binds its lowercase 64-character
hex digest as `custom_data`; no Ethereum wallet or transaction is involved.
The browser waits for the confirmed creation timestamp before requesting a
fresh proof. A short additional wait accommodates the phone's Ethereum-block
proof timestamp; the contract still requires proof time >= order creation.

Every later order reconciliation checks that the active gateway's immutable
contract, token and policy match the stored configuration. A deployment change
fails closed instead of recreating an old reservation in a replacement vault.
The changing RPC ledger timestamp is excluded from that identity comparison.

## Deposit and withdrawal state machines

Deposit:

1. Provider-authorized `create_order` transfers the exact token amount into
   the vault before a phone request is issued.
2. Recipient-authorized `prove_order` performs native proof and policy checks.
   Only confirmed eligibility releases simulated deposit instructions.
3. The owner requests the mock-bank action. The server freezes one exact
   receipt, then the separate notary records it onchain.
4. `settle` rechecks current eligibility, original deadline, roots and verifier
   identity, then transfers only the reservation to the stored recipient.
   Its settled state and successful transfer are atomic.

Stages: registering, created, eligible, funded, settled. Expired funded
deposits remain held. A delayed bank receipt does not renew eligibility.

Withdrawal:

1. Provider-authorized `create_order` stores the fixed quote and beneficiary;
   it does not debit the user or reserve provider inventory.
2. The first successful recipient-authorized `prove_order` verifies the
   native proof and atomically transfers the exact user tokens into escrow.
   A proof refresh cannot debit again.
3. Notary-authorized `authorize_payout` requires current proof, roots,
   deadline and escrow. It creates an irreversible obligation to pay only
   that fixed synthetic destination and TRY amount.
4. The explicit mock-bank action writes one durable local credit and freezes
   its receipt in the same SQL transaction. Only then does the notary submit
   the matching paid receipt. A response timeout cannot cause a second credit.
5. After the paid receipt is confirmed, `settle` releases the exact escrow
   to the provider. A later proof/root/deadline expiry cannot undo the
   previously authorized bank obligation or block its reconciliation.

Stages: registering, created, eligible, payout_authorized, paid, settled.
Receipt time must be at least payout authorization time. There is no reproving
after authorization. Both directions set `escrowed=false` at settlement.
There is no cancel, automatic refund, provider reclaim or deadline extension.

## Signatures, admission and startup

Required runtime configuration is explicit: `ANCHOR_GATE_CONTRACT`,
`ANCHOR_GATE_PROVIDER_SECRET` and `ANCHOR_GATE_BANK_NOTARY_SECRET`.
Secrets are server-only environment values; no UI accepts them. The identities
must match the distinct immutable contract roles. `PUBLIC_URL` hostname must
match the contract's proof domain, and RPC/network must be Testnet.

`ANCHOR_GATE_MAX_FEE_STROOPS` bounds the complete simulated transaction fee
(default 1000000 stroops). No fee sponsorship or mainnet route is added.
The recipient signs the exact prepared transaction: full Testnet hash,
source, operation, contract, order, fee and time bounds cannot be changed.
This scoped wallet path requires a valid recipient master-key signature;
delegated-only wallets are unsupported. Stellar still enforces the actual
account threshold, so one signature is not claimed sufficient for every account.

`ANCHOR_GATE_ALLOWED_WALLETS` is a comma/whitespace-separated list of public
G accounts. A configured non-loopback deployment refuses startup without a
nonempty valid list. Loopback is exactly localhost, 127.0.0.1 or [::1].
The list restricts authenticated gate-order access to capped-demo participants;
it is not identity evidence and never bypasses native eligibility checks.
Public UI, info and discovery remain readable. Bank simulation is a separate
trusted notary role, not something the passport proof proves.

Requests carrying an Origin must match the anchor origin. Bearer tokens and
proof sessions stay out of URLs/logs. Body limits and no-store apply to the API.
The node process serializes its gate mutations; the deployment uses one
persistent SQLite-backed instance. Concurrent unrelated transactions from one
operator account can still encounter sequence contention and require
reconciliation; the adapter never guesses a higher sequence to bypass ambiguity.

## Persistence and recovery

`anchor_gate_orders` stores ownership, immutable terms/configuration, creation
idempotency, frozen amounts, chain projection, synthetic destination and receipt.
`anchor_gate_actions_v2` stores expected hashes, kind, status, ledger and exact
envelope time bounds. Existing v1 action rows are copied without deleting the
old table; new optional columns are additive migrations.
`anchor_gate_bank_credits` has one order and event per simulated payout.

Expected transaction hashes are persisted before submission. Operator envelopes
may be retained for exact retry; proof envelopes and raw proof bytes are not
stored by the backend. The client must retain its prepared/signed proof until
reconciliation. The eventual onchain invocation itself is public, including
its proof and public inputs; this is not private transaction transport.

A timeout, send admission error or NOT_FOUND is not failure evidence by itself.
Only a terminal transaction response, or expiry with RPC history covering the
actual signed [minTime,maxTime] interval, proves a locally known attempt can
be replaced. Rows lacking a known minTime remain pending until terminal
evidence; no timestamp is inferred from later DB insertion time.

Reconciliation reloads action status before deciding whether an old signature
window matters. A transaction that already succeeded stays successful after
its signing window expires. Confirmed immutable contract settled state is
authoritative even if an external permissionless caller settled it; known
local transaction receipts are displayed separately, not prerequisites to
recognize that completion.

Before freezing any mock credit/receipt, the server requires its clock to be
at least the confirmed creation or withdrawal-authorization timestamp.
Otherwise it returns bank_clock_pending without crediting or storing receipt
data. The adapter also waits boundedly for the ledger to reach a frozen
received_at before simulating its notary call. Neither retry rewrites the
receipt time, amount, destination or event ID.

## Wallet setup and address precheck

The browser checks wallet admission through authenticated
`GET /anchor-gate/orders/access` before offering quotes. An explicit first
admission rejection is not an unknown reservation. A rejection after a lost
earlier response still retains the original terms and idempotency key.

Wallet setup uses only Stellar Testnet Horizon and Friendbot. It requests free
XLM when the account is absent or has less than 10 spendable XLM after classic
reserve and selling-liability accounting. Requests are coalesced with a
60-second retry cooldown. A failed optional top-up does not block an existing
funded wallet; creating a trustline still requires 0.501 spendable Testnet XLM
for its reserve and fee. No mainnet faucet or paid funding path exists.

The user signs one exact `changeTrust` for the configured mock asset, with a
1,000,000-token limit, 0.001-XLM fee cap and 180-second validity. The client
checks wallet, network, asset contract and the signed transaction hash before
submission. It re-reads the account before allowing a new reservation. The
trustline is not Circle USDC unless that exact issuer was configured. Deposit
capacity and withdrawal spendable balance are checked before new reservations.
Missing setup does not block loading an existing owned order.

Uncertain trustline submissions retain their hash and are reconciled without
a new signature. This client-only pending state lasts for the page lifetime;
a reload first reads current account state, but does not restore an earlier
pending hash. It must not be presented as durable payment recovery.

Set `ANCHOR_GATE_OFAC_ENABLED=true` to enable the server's official SDN
digital-currency-address precheck. The access response includes its result
and source metadata. A match or unavailable feed blocks new reservations
before the quote/key is consumed. Existing owned-order reads and same-key
reservation recovery remain available. This is a new-reservation precheck,
not ongoing screening, identity clearance or an onchain sanctions proof.
The native ZKPassport age and country constraints are unchanged. See
`OFAC_PRECHECK_RESEARCH.md` for source coverage and freshness limits.

## Verification boundaries

HTTP tests use real in-memory SQLite and actual SEP-10 challenge signatures,
faking only the external gate seam. RPC-boundary tests use actual SDK XDR,
fee assembly and cryptographic signatures against a deterministic RPC adapter.
They cover owner isolation, quote issuer drift, transaction substitution,
pending/late receipt recovery, irreversible withdrawal payout, admission and
beneficiary locking. These are not fresh native proof acceptance claims.

The separate Rust native/compiled-Wasm tests cover contract authorization,
policy, escrow and rollback. Release still requires the chosen immutable
deployment, a fresh matching synthetic phone proof, actual recipient signature,
both Testnet directions, exact balance/receipt confirmation, and hosted checks.
Historical or differently sized proof fixtures are not substitutes for that
fresh full-flow evidence.
