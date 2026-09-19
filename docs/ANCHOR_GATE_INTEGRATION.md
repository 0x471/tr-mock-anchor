# Gated anchor integration plan

Prepared 20 September 2026. Proposed implementation, not completed functionality.
Scope: a fresh synthetic phone proof, age and country predicates, real SEP-10
wallet authentication, native onchain eligibility, simulated TRY receipt, and
Testnet tokens paid from a contract-controlled vault. Deployment destination,
country policy, accepted proof profile, and final Rust argument types remain decisions
for the main implementation. No secrets or live identity material were read.

## Existing behavior and reuse limits

- `src/routes/sep10.ts` already builds a server-signed challenge and checks the
  wallet's signature, including funded-account thresholds. `src/sepauth.ts`
  maps the JWT subject to the customer. Reuse this flow, not a client-supplied
  wallet address or a fabricated JWT.
- `src/routes/sep38.ts` creates customer-owned firm quotes. `src/money.ts` uses
  integer minor units. Reuse pricing and formatting, but snapshot complete asset
  identities: current quote rows retain currency names, not the asset issuer or
  token contract. Reading an old quote under changed asset configuration must
  not silently select a different token.
- `src/routes/sep6.ts::fundSepDeposit` permits amount defaulting and live-rate
  fallback when a quote expires or differs. `src/core/orders.ts::createOnramp`
  debits a TRY balance and `src/workers.ts` pays from the treasury. These are
  legacy behavior and must not handle gated orders.
- `src/anchor-policy.ts` deliberately permits economic actions only in legacy
  mode. Keep that check intact. Add a separate explicit gated-flow capability;
  never make all economic actions available after a proof succeeds.
- `src/zkpassport-browser.ts` is one loopback diagnostic session without wallet
  ownership. Reuse browser SDK bundling and lifecycle handling from
  `web/zkpassport-diagnostic.ts`, not its process-global session model.
- `src/routes/zkpassport.ts` records mathematical diagnostics only. Neither a
  `math_valid` row nor `customer.kyc_status` is an onchain payout permission.

## Small interfaces and ownership

Introduce one deep `GatedOnramp` module in `src/gated-onramp.ts`. Its interface
owns order creation, proof-request terms, funding transitions, transaction
preparation, and reconciliation. HTTP routes and the browser do not assemble
SQL state transitions independently. Inject a `GateVaultGateway` through
`src/context.ts`; its two adapters are the real Testnet gateway and a
deterministic external-chain test adapter. Do not mock internal order helpers.

Suggested HTTP interface, all under SEP-10 authentication and owner checks:

| Operation                                   | Meaning                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `POST /zkpassport/orders`                   | Reserve one owned, unexpired firm quote; create one immutable gated order.                                |
| `GET /zkpassport/orders/:id`                | Return sanitized terms, chain-backed stage, transaction links, and next action.                           |
| `POST /zkpassport/orders/:id/proof-request` | Return server-owned domain, scope, predicates, binding and request expiry.                                |
| `POST /zkpassport/orders/:id/proof`         | Validate bounded encoding/profile and prepare the recipient's exact onchain proof transaction.            |
| `POST /zkpassport/orders/:id/transactions`  | Record an expected transaction hash and reconcile its actual receipt; never trust a browser success flag. |
| `POST /zkpassport/orders/:id/simulate-bank` | Explicit Testnet-only bank simulation for an eligible order and its exact TRY amount.                     |

The gateway interface should expose `registerOrder`, `prepareProofTransaction`,
`recordFiatReceipt`, `settle`, and `readOrder`. The agreed contract methods are
`create_order`, `prove_order`, `record_receipt`, and `settle`; argument types
come from the frozen Rust interface. Gateway results distinguish pending/unknown transport state,
confirmed contract failure, and confirmed success. A simulated `true` result
is never settlement. Node's existing `tx(db, fn)` is synchronous: do not await
RPC while holding a SQLite write transaction.

The agreed sequence is provider-authenticated registration and reservation,
recipient-authenticated proof acceptance, bank-notary receipt, then
permissionless settlement. Bank instructions appear only after native eligibility
is confirmed. Receipt recording is separate and durable even if the transfer
later fails. Contract internals and root checking are defined by the Rust design.

## Immutable order and quote binding

Accept only a plain `G...` recipient equal to the exact SEP-10 subject for the
first gated implementation. Explicitly reject muxed accounts and memo-qualified
subjects; do not collapse custody identities with `subAccount`. Unsupported
wallets get a clear error, not a newly generated custodial key.

Before any phone request, persist and register an immutable order containing:

- Versioned order ID and unique quote ID, authenticated recipient, direction
  `TRY_TO_TOKEN`, and a random challenge.
- Source asset `iso4217:TRY`, positive TRY minor-unit amount, exact destination
  asset code/issuer and Testnet token-contract address, positive token amount,
  and token decimals. Use 7 decimals only for the pinned Stellar asset; reject
  any token whose configured decimals differ.
- Quote amounts, fee amount/currency, source-rate metadata, quote expiry,
  order expiry, and proof freshness requirements. The payout amount is the
  quote's frozen destination amount, not a later recomputation from its rate.
- Network ID, vault/gate contract address, policy fingerprint/version, exact
  domain and scope, and accepted verifier profile/key identifier.

One canonical encoding must be agreed with Rust before implementation. Prefer
a fixed-order, versioned XDR/byte layout with integer values and decoded address
bytes, not unordered JSON or locale-formatted decimals. The contract recomputes
the same binding; it never trusts a digest supplied by the browser. The phone's
`custom_data` carries the agreed digest encoding. Maintain independently checked
TypeScript/Rust known-answer vectors for both order binding and query
commitments. Age and country commitments are part of the exact approved policy,
not claims inferred from a callback's display result.

Inside one SQLite transaction, verify quote ownership, direction, full asset
pair, amounts, expiry, and unused status; conditionally set `consumed_by` and
insert the order. A lost race returns conflict. Do not release a consumed quote
while registration is uncertain. Expired or mismatched quotes require a new
quote and new proof challenge; never reprice an existing proof-bound order.

## Authentication and browser flow

1. Publish/validate the Testnet asset, gate, vault, policy and SEP-10 discovery
   configuration. Keep the existing diagnostics available separately.
2. Connect the user's wallet through the browser wallet adapter (initially
   Freighter). Check Testnet, fetch the SEP-10
   challenge, validate its anchor/network/home-domain terms, request the wallet
   signature, and exchange it for the bearer token. Signing this challenge
   does not authorize a token transfer. Keep tokens out of URLs and logs.
3. Obtain a firm quote, display exact TRY and token amounts, then create the
   owned gated order using an idempotency key. The provider registers the order
   onchain with its own authorization and reserves vault liquidity. Do not
   request a proof until that registration is confirmed.
4. Load a per-order proof request into the browser SDK, using the real browser
   origin. Request the selected age/country predicates and exact order binding.
   Show a QR/deep link only for that session. Cancel, expiry, wallet changes and
   replacement requests invalidate late callbacks. Do not reuse the diagnostic
   age-only profile as the age-plus-country profile.
5. Upload a bounded proof container only to the authenticated order route.
   The browser result is untrusted. Validate encoding/profile and prepare the
   onchain invocation. For the minimal wallet path, the recipient is transaction
   source and signs the prepared transaction; the contract requires recipient
   authorization for the exact order and proof invocation. A SEP-10 JWT is not
   a substitute for this authorization. Do not introduce a fee sponsor or
   detached authorization flow without separate tests.
6. Confirm native proof acceptance from the actual transaction and contract
   state. The stored eligibility must be short-lived and bound to immutable
   order terms and policy, not a reusable account-wide approval. It represents
   consent to this exact future payout. Permissionless settlement therefore
   needs no second recipient signature but cannot change the recipient, asset,
   amount or order deadline.
7. Display simulated bank instructions only now. The explicit bank action
   records one receipt for the exact order and TRY amount. A separate notary
   identity authorizes the receipt onchain; user proof never proves fiat arrival.
   Development simulation must not accept arbitrary recipient/token/amount
   fields or an unauthenticated public legacy-bank call.
8. Settle from the vault only when eligibility and trusted-root validity remain
   current, the original order deadline has not passed, the mock-bank receipt is
   confirmed, the order is unconsumed, and the exact reserved transfer succeeds atomically.
   Missing trustline, insufficient balance or contract failure is not completion.
   Do not fall back to classic treasury payment or claimable balance.
9. Reconcile and display the confirmed ledger, transaction hash, recipient and
   token amount. Label synthetic identity, simulated TRY and Testnet tokens
   explicitly; never call the flow real-bank settlement.

Use a new `web/gated-onramp.ts` and matching HTML with order-scoped state. The
wallet adapter and phone-proof adapter belong in the browser; signer secrets
never belong in frontend configuration. Protect authenticated mutations with
same-origin checks, appropriate CORS, request-size limits and `no-store`.

## Persistence, status and recovery

Add a separate `gated_orders` table, not an entry in legacy `onramps`. Store
owner subject/customer ID, immutable terms/terms hash, unique quote/order IDs,
creation idempotency key plus request hash, expected transaction hashes, chain
stage, confirmed ledger, eligibility expiry and receipt reference. Add narrowly
scoped `gated_receipts` and transaction-attempt records for recovery. Persistent
idempotency constraints must survive restarts; process-local flags are not enough.
Raw phone proofs need no long-term storage for authorization. If a short-lived
upload is retained for transaction preparation, isolate it from logs and public
order responses, enforce owner access and deletion/expiry.

| Stage                     | Required evidence and recovery                                                          |
| ------------------------- | --------------------------------------------------------------------------------------- |
| Registering               | Quote reserved locally; query expected transaction/order before resubmission.           |
| Awaiting proof            | Order and vault reservation confirmed; no bank instructions or payout.                  |
| Eligible                  | Recipient-authenticated native acceptance confirmed for these terms; show grant expiry. |
| Fiat pending confirmation | Mock receipt recorded locally; preserve exact receipt and reconcile notary transaction. |
| Funded                    | Receipt confirmed; retain reservation if transfer fails.                                |
| Settling                  | Submitted transaction is pending/unknown; reconcile before producing another attempt.   |
| Completed                 | Confirmed contract state and transfer receipt; immutable terminal result.               |
| Expired/refund required   | No new payout or provider reclaim; preserve reservation pending explicit recovery.      |

The same creation idempotency key with the same body returns the same order;
different bodies return conflict. Repeated bank receipt identifiers cannot fund
another order. Contract replay protection enforces one settlement even if HTTP
requests race or the backend crashes after success. Persist the signed transaction
hash before submission; after an unknown result, query hash and order state.
Never treat a timeout as failure, refund, or permission to pay again.

Omit provider reclaim from the first version: absence of an onchain receipt does
not prove that the mock bank never received funds, because its attestation may
be delayed. Expiry alone never releases reserved tokens. Future refund/reclaim
support needs explicit, unique bank-refund evidence and corresponding contract
rules. Proof refresh is allowed only before the original order deadline and
with unchanged terms; no re-quote, amount edit or deadline extension. Expired
funded orders remain held, with no false refund-success label.

## Files and SEP compatibility

- `src/gated-onramp.ts`, `src/gate-vault.ts`, `src/routes/gated-onramp.ts`: new
  order module, Testnet gateway adapter and thin authenticated routes.
- `src/db.ts`, `src/context.ts`, `src/server.ts`, `src/app.ts`: additive tables,
  dependency injection, startup configuration and route mounting.
- `src/sepauth.ts`/`src/jwt.ts`: ensure the gated interface validates expected
  token issuer and timing/header semantics as well as signature; retain genuine
  SEP-10 challenge tests. Existing `verifyJwt` only validates signature, expiry
  and nonempty subject, so this should be deliberate before expanding authority.
- `src/routes/sep38.ts`: snapshot full asset identity and consume quote once.
- `src/core/sepstatus.ts`, `src/routes/sep6.ts`: optional dedicated gated-order
  projection/adapter after the new flow passes. Do not remove the existing
  policy hold globally or publish SEP-6 deposit support while its handler remains
  disabled. Custom proof/contract-signing steps are not automatically standard
  SEP-6 conformance. Continue to block withdrawals and direct legacy settlement.
- `src/anchor-policy.ts`, `src/stellar.ts`, `src/workers.ts`: retain legacy guards;
  gated settlement uses the vault gateway, never `sendUsdc`.

## Approved test seams and vertical slices

The user approved HTTP, gate/vault and fresh-phone end-to-end seams. Implement
one failing behavior test, its minimum implementation, then the next slice:

1. HTTP: obtain tokens through real challenge signing, create/read an owned
   order, reject another wallet and unsupported subject forms. Use real in-memory
   SQLite and fixed clock/rates; fake only the external chain adapter.
2. HTTP: exact quote binding, wrong issuer/token, excess precision, zero amount,
   expiry, duplicate request/conflicting idempotency key, and concurrent quote
   use. Assert through responses/status, not private helper calls.
3. Compiled gate/vault: required provider/recipient/notary authorization, actual
   matching native age/country proof acceptance, wrong roots/policy/binding,
   expired eligibility, missing fiat, replay, insufficient liquidity and failed
   transfer rollback. Prove successful math alone cannot move tokens.
4. HTTP recovery: interruption before/after each chain submission; confirmed
   success with lost HTTP response; delayed/failed receipts; restart reconciliation.
   Balances and order state show exactly one transfer and no false refund.
5. Browser: no secret-key entry; wallet/network switch invalidation; stale phone
   callbacks; malformed/unsupported proof; denied signature; safe retry; CSP and
   same-origin behavior. Keep synthetic fixtures clearly distinguished from live
   phone-generated proof evidence.
6. Testnet end to end: fresh phone age/country proof, actual SEP-10 wallet login,
   recipient-authorized onchain proof, simulated bank attestation, vault transfer,
   receipt/balance confirmation, then replay rejection. Preserve transaction
   references and sanitized evidence, not raw identity material or session URLs.

Do not deploy or fund the proposed vault until the destination and bounded
Testnet operations are authorized. This plan changes no running integration.
