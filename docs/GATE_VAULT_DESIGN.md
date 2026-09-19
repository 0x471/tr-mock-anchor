# Native proof-gated Testnet anchor vault

Status: implementation in progress, not a security audit or deployment approval.
This is a mock-bank, synthetic-document Testnet module. It never attests real TRY
receipt or production identity compliance. Country choices must be approved
before deployment. Mathematical verification is native Soroban, not a backend
eligibility signature.

## Interface and lifecycle

The gate is one deep Module. Its Interface includes immutable policy, ordering,
authorization, deadlines and rollback behavior, not just Rust method names.
The external native verifier and pinned Stellar Asset Contract are dependency
Seams. Policy/state tests may use a fake verifier at that Seam; such tests do not
prove the native verifier works. Real verifier Wasm and a fresh matching phone
proof are separate integration gates. The HTTP Adapter never grants eligibility.

Four mutating calls, in order:

1. `create_order(id, terms) -> Order`: immutable provider authorizes the full call
   and the nested exact token transfer into the vault. It reserves the exact
   amount before a proof request is issued. Identical retry returns the original
   order; changed terms under the same ID fail.
2. `prove_order(id, proof, public_inputs) -> Order`: the stored recipient
   authorizes the full call. The native verifier must succeed and every policy
   and order-binding check must pass. Proof refresh cannot extend the original
   deadline. Bank instructions are released only after confirmed eligibility.
3. `record_receipt(id, receipt) -> Order`: the separate immutable mock-bank
   notary authenticates the exact event, quote, TRY amount and receipt time.
   The order must previously have eligibility. A late receipt is still recorded
   permanently, but does not restore stale eligibility or extend a deadline.
4. `settle(id) -> Order`: permissionless, but requires funded state, current
   stored eligibility, current immutable roots, and the original deadline. The
   vault transfers only the exact reservation to the stored recipient. A failed
   SAC transfer rolls back settlement. Retrying a settled order returns its
   terminal state without another transfer.

Read calls: `get_config`, `get_order(id) -> Option<Order>`,
`get_challenge(id) -> BytesN<32>`, `get_policy_hash`, `get_total_reserved`.
Constructor initialization is atomic and cannot be called again. No initializer,
policy setter, upgrade, withdrawal, cancel, refund or reclaim entry point exists.
In particular, an order that looks unfunded onchain may already have received a
bank transfer whose notary submission is delayed. A deadline alone cannot justify
returning its reservation. Version one deliberately strands unresolved or expired
reservations; use capped Testnet inventory and reconcile manually without claiming
a refund mechanism. A later refund design needs an explicit trusted bank outcome.

## Fixed ABI

`Config` fields: `provider`, `bank_notary`, `token`, `verifier` (Address);
`verifier_wasm_hash`, `verifier_vk_hash`, `network_id`, `certificate_root`,
`circuit_root` (BytesN<32>); `domain`, `scope` (String); `min_age` (u32);
`allowed_nationalities`, `allowed_issuers` (Vec<BytesN<3>>);
`proof_bytes`, `external_inputs` (u32); `max_proof_age`, `policy_valid_until`,
`max_order_lifetime` (u64); `max_amount` (i128); `max_try_minor` (u64).

Country lists are inclusion-only, at most ten uppercase ASCII country codes,
strictly sorted with no duplicates. Empty means no predicate for that attribute,
not an empty allowlist. Nationality and issuing country are different predicates.
The SDK request must preserve exactly this list order. The deployment manifest
must explain the approved policy, roots, verifier, asset code/issuer and amounts.

`OrderTerms`: `recipient: Address`, `quote_hash: BytesN<32>`, `try_minor: u64`,
`amount: i128`, `deadline: u64`, `nonce: BytesN<32>`.
`Order`: `terms: OrderTerms`, `created_at: u64`,
`eligibility: EligibilityState`, `receipt: ReceiptState`, `settled: bool`.
The two state enums are `None` or `Some(Eligibility)` / `Some(BankReceipt)`;
JavaScript native XDR conversion produces `["None"]` or `["Some", value]`.
`Eligibility`: `proof_time: u64`, `valid_until: u64`.
`BankReceipt`: `event_id: BytesN<32>`, `quote_hash: BytesN<32>`,
`try_minor: u64`, `received_at: u64`.
Local order IDs and external anchor quote IDs are not interchangeable. The
backend commits an exact quote snapshot into `quote_hash`; the provider's auth
consents to the immutable resulting terms and exact reservation.

## Exact proof intent and policy commitments

The challenge is SHA256 of one ScVal vector serialized by SDK `ToXdr`. Fields
are in this exact order and ScVal types; there is no JSON or implicit coercion:

1. String `stellar-anchor-intent-v1`
2. Bytes network_id (32)
3. Address current gate contract
4. Address recipient
5. Bytes order ID (32)
6. Bytes quote_hash (32)
7. Address token
8. U64 try_minor
9. U128 positive token amount
10. U64 created_at (from ledger timestamp)
11. U64 deadline
12. Bytes nonce (32)
13. Bytes policy_hash (32)

`policy_hash = SHA256(ScVal vector[String "stellar-anchor-policy-v1", Config])`;
the Config element is its SDK contracttype ScMap encoding (ASCII field names in
canonical XDR order). An independently generated TypeScript golden vector must
match the actual Rust getter before a phone request can authorize settlement.
The deterministic synthetic unit fixture was independently reconstructed in
TypeScript (including every typed Config field, not by copying Rust's XDR):
policy hash `91fe26e123805a8718dffced06a45df0df71607d2875a3e0f6bbda53b85d9a74`,
challenge `d7244c3764e3b8ce8b2299f1d8f133c8577a7f406d74e5b0933db97fce876285`.
These are regression vectors for that fixture, not deployment policy values.
The phone binds the lowercase 64-character hex challenge without `0x` as
`custom_data`. It does not invent an EVM address or chain for a Stellar wallet.

For ZKPassport 0.20, `H31(x) = 0x00 || SHA256(x)[0..31]`; this drops the final hash
byte, it is not reduction modulo the scalar field. Expected records:

- Age >= min_age: `[1, 0, 2, min_age, 0]`.
- Bind: `[8, 1, 253, 3, 0, 64] || ASCII(hex_challenge) || 442 zero bytes`.
- Nationality inclusion: `[4, 2, 88] || ordered 3-byte country codes || zero
padding to a 600-byte country payload` (603 bytes total).
- Issuing-country inclusion: same record with first byte 6.

The gate compares the exact multiset of all expected commitments, permits no
unknown extra disclosures, and consumes each expected slot only once. Age+bind
requires OuterCount5 (10 public fields, 9888 proof bytes). One extra country
predicate requires OuterCount6 (11 fields, 10240 bytes); two require OuterCount7
(12 fields, 10240 bytes). Richer profiles require separately verified native
builds and fresh compatible phone proofs; configuration alone does not add support.

External fields are 32-byte big-endian values: certificate root, circuit root,
UNIX proof time, H31(domain), H31(scope), N commitments, nullifier type, scoped
nullifier, OPRF key hash. N = 2 + the number of nonempty country lists. Mock-only
type is exactly 2; scoped nullifier must be nonzero, OPRF hash must be zero.
Proof time must be no earlier than order creation, not in the future, and no
older than `max_proof_age`. Saved validity is bounded by proof freshness, order
deadline and immutable root/policy expiry. A historical July proof cannot settle
a September order. The native verifier checks mathematical canonical encoding;
the gate independently checks exact lengths and narrow integer fields.
The mobile compressed-EVM path may use the latest Ethereum block timestamp,
which can briefly lag the just-created Stellar order. Wait for a fresh source
block before requesting, or retry an explicitly stale proof. No hidden skew
allowance weakens the configured time rules.

## Trust, funds and storage

The vault pins Testnet network ID, exact SAC address (7 decimals), verifier
address, its executable hash, its VK hash/profile, domain/scope, authenticated
certificate and circuit root snapshots, and all predicates at construction.
The snapshot curator is trusted to select authenticated roots, not to approve
proofs. Fixed snapshot expiry is at most 24 hours after construction; no claim of
continuous foreign-chain revocation checking is made. A new root/policy requires
a new deployment. Verifier executable identity is checked before proof and payout.

Provider and bank-notary are distinct accounts. Recipients are existing classic
accounts, not muxed/custodial memo identities. Token trustlines/authorization and
fees remain Stellar requirements; failure cannot redirect tokens. `total_reserved`
is checked arithmetic and is never larger than the vault's token balance. Extra
token donations confer no withdrawal authority. Each receipt ID maps permanently
to one order; order IDs and terminal states are never deleted or reused.

All config/order/receipt/aggregate entries use persistent storage. TTL extension
is clamped to `max_ttl()-1`; instance/code TTL is also extended. Missing config
fails closed rather than recreating it. Protocol 23+ restoration of archived
persistent entries happens before invocation, not as a new empty record. TTL is
not an order deadline. Operations must maintain/restore vault SAC balance and
native verifier code/instance separately; the gate does not promise it can extend
another contract's storage. Archive/replay, resource ceilings and fresh real-Wasm
integration are explicit release tests, not inferred from native unit success.

Raw proof, public inputs and nullifiers are not published in events, but the
transaction invocation itself is public. Wallet, amount, order and policy remain
public. The mock-bank notary can lie about simulated receipt; it cannot bypass
native proof checks or change the recipient/amount.
The asset issuer's native authorization/clawback powers are a separate asset
trust assumption; pinning a SAC does not disable those issuer powers.

## Verified API/source references

- [SDK 26.0.1 ToXdr ScVal encoding](https://github.com/stellar/rs-soroban-sdk/blob/f52b6aad85f18c5e312ff3f60e57cb613274e6bb/soroban-sdk/src/xdr.rs)
- [SDK authorization and executable introspection](https://github.com/stellar/rs-soroban-sdk/blob/f52b6aad85f18c5e312ff3f60e57cb613274e6bb/soroban-sdk/src/address.rs)
- [SDK token transfer uses MuxedAddress](https://github.com/stellar/rs-soroban-sdk/blob/f52b6aad85f18c5e312ff3f60e57cb613274e6bb/soroban-sdk/src/token.rs)
- [SDK persistent/instance TTL](https://github.com/stellar/rs-soroban-sdk/blob/f52b6aad85f18c5e312ff3f60e57cb613274e6bb/soroban-sdk/src/storage.rs)
- [Protocol 23 automatic restoration](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0066.md)
- [Pinned ZKPassport public-input layout](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/bin/main/outer/count_5/src/main.nr)
- [Pinned bind record](https://github.com/zkpassport/zkpassport-packages/blob/01bab06eb5fd48a82ec7f91d992823026e5675b2/packages/zkpassport-utils/src/circuits/bind.ts)
- [Pinned country inclusion commitment](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/lib/inclusion-check/country/src/lib.nr)
