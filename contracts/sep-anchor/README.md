# SEP anchor settlement

This Testnet-only contract combines native ZKPassport eligibility with exact
deposit and withdrawal settlement. It is separate from `anchor-gate`; deploying
it does not migrate, modify, or recover orders held by an older contract.

## Eligibility and supported account profile

`get_subject(account)` hashes the XDR vector containing the string
`sep-anchor-subject-v1` and the canonical G account string. Orders require this
subject and require `refund_to == recipient`. Muxed, pooled memo identities,
contract accounts, and different recipient/refund accounts are not supported.

`get_challenge(subject)` binds the network, this contract, that subject and the
immutable policy hash under `sep-anchor-eligibility-v1`. The native verifier,
verification key, document roots, age, countries and optional sanctions snapshot
are pinned by the policy. Its parser is shared with `anchor-gate` through
`anchor-policy`.

Anyone may relay a valid subject proof. This does not authorize a token debit
and does not independently establish wallet ownership. SEP-10 authentication
remains an offchain admission boundary. The grant is reusable until the earlier
of its original proof time plus `max_proof_age` and policy expiry. Replaying an
older proof cannot extend or replace a newer grant. `get_eligibility` returns
stored timestamps, including expired grants; callers must check `valid_until`.

## Custody and recovery

The provider reserves deposit tokens when creating an order. Withdrawal funds
arrive through an ordinary Stellar payment to the anchor's custody account.
`fund_withdrawal` requires both provider and bank-notary authorization and
atomically transfers the exact amount from that provider into the vault. Its
operation ID is a unique attribution attested by those operators, not an
onchain verification of the original classic payment or its memo.

Deposits need current native eligibility and the exact bank receipt to settle.
Withdrawals need current eligibility and escrow to authorize a bank payout;
their exact receipt and settlement can reconcile later. Authorization cannot
be undone by expiry, refund, or a new proof.

Before payout authorization, both custody roles can refund withdrawal escrow
to the immutable customer account, including after eligibility or policy
expiry. The same roles can cancel a deposit only before a bank receipt, returning
the provider's reservation. Cancellation is not a fiat refund. A deposit with
a bank receipt but an expired immutable policy has no automatic refund path.
The operator must reconcile the simulated bank side; this contract does not
pretend that an unrecorded fiat refund happened.

## Checks

```sh
cargo test --locked --manifest-path contracts/sep-anchor/Cargo.toml --features std
cargo build --locked --manifest-path contracts/sep-anchor/Cargo.toml --target wasm32v1-none --release
```

Set `SEP_ANCHOR_WASM` to the compiled Wasm path and repeat the tests to exercise
that artifact through the same public calls. The tests use the real Stellar
asset contract and real Ed25519 signatures for dual-role authorization checks.
Policy and lifecycle tests explicitly stub the external proof verifier; they
are not evidence of a fresh cryptographic phone proof. Test key seeds are
deterministic fixtures and must never be used as deployment credentials.
