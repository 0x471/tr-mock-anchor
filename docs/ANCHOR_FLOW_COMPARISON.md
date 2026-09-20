# What this anchor actually implements

Reviewed 2026-09-20 against the upstream guide supplied by the user, the current
routes and the local Testnet configuration. This is a proof-gated mock anchor,
not a drop-in SEP-6 anchor integration.

## Upstream steps and our flow

| Upstream demo                       | Proof-gated demo                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEP-1 discovery                     | Browser reads `stellar.toml` and checks the Testnet passphrase, auth endpoint and signing key. Gate policy and asset are loaded separately from `/anchor-gate/info`. |
| Generate a throwaway wallet         | User connects Freighter. Testnet XLM funding is automatic when needed; the user approves the mock asset trustline. The app does not take the wallet's secret key.    |
| SEP-10 login                        | Reused: challenge, wallet signature, server verification and JWT. This is login, not a payment.                                                                      |
| SEP-6 capabilities                  | Legacy `/sep6/info` reports deposit and withdrawal disabled in ZKPassport mode. Gate capabilities are custom.                                                        |
| SEP-38 quote                        | Reused: authenticated firm quote with fixed amounts, fees and expiry. Our reservation requires a quote.                                                              |
| SEP-6 deposit                       | Replaced by authenticated `POST /anchor-gate/orders` and a provider-authorized onchain reservation.                                                                  |
| Simulate bank receipt               | Custom authenticated simulation and a separately authorized notary receipt on the vault. No real IBAN or bank API.                                                   |
| Poll transaction                    | Browser automatically reconciles the owned order and known transactions; only confirmed settlement is complete.                                                      |
| SEP-6 withdrawal to treasury + memo | Replaced by exact, wallet-authorized vault escrow, proof verification, payout authorization, a simulated bank credit and settlement to the provider.                 |
| SEP-12 auto-approval                | Disabled. Empty forms cannot confer eligibility. Document predicates are enforced per order by the vault.                                                            |

Sources in this repo: `web/anchor-gate-flow.ts`, `web/anchor-wallet-setup.ts`,
`src/routes/anchor-gate.ts`, `src/routes/sep6.ts`, `src/routes/sep12.ts`,
`src/routes/sep38.ts`, `src/anchor-gate.ts`, and
`contracts/anchor-gate/src/lib.rs`.

## Deposit

1. Connect the wallet, fund Testnet XLM if necessary, sign SEP-10 login and
   approve an exact-issuer trustline if missing.
2. Review a firm TRY-to-token quote. Reserve it once. The provider authorizes
   moving the exact quoted tokens into the vault for this order.
3. Scan the synthetic ZKPassport request and generate the proof. The phone's
   success message alone grants nothing.
4. Sign `prove_order`. The vault checks the pinned native verifier, proof
   profile, roots, timestamps, document predicates and order binding.
5. Simulate receipt of the exact quoted TRY. The mock-bank notary records the
   amount, quote, order reference and unique receipt onchain.
6. Settle. The vault transfers the reserved tokens to the fixed recipient only
   with current eligibility and a valid receipt. Repeated settlement does not
   pay again.

## Withdrawal

1. Log in and choose the exact token amount plus a made-up `demo:` destination.
2. Reserve the firm token-to-TRY quote. The destination commitment cannot be
   changed afterwards.
3. Generate and sign the order-bound proof. In the same atomic invocation,
   successful first verification escrows exactly the quoted tokens from the
   user's wallet. Refreshing a proof cannot debit again.
4. The notary authorizes the exact simulated payout while eligibility and the
   order are current. This is a durable obligation, not evidence of payment.
5. Record the simulated bank credit and its unique onchain notary receipt.
6. Settle escrow to the provider. A previously authorized withdrawal can finish
   after proof expiry; it cannot redirect the beneficiary or create a new
   payout obligation using an expired proof.

There is no automatic refund path. Expiry does not release held tokens. This
is a material demo limitation, not a production recovery mechanism.

## Where trust remains

- The anchor backend serves discovery, authenticates sessions, quotes amounts,
  persists orders, simulates bank operations and submits provider/notary calls.
- The native verifier checks cryptography. The vault checks application policy
  and controls its reserved assets. Calling the vault directly does not remove
  its proof, signature, receipt or exact-order constraints.
- Proof binding includes network, vault, wallet, order, quote, asset, direction,
  beneficiary commitment, both amounts, timestamps, nonce and immutable policy.
- The bank notary is trusted about the simulated bank event. A ZK proof cannot
  establish that real fiat moved. The operator still controls admission and
  liquidity, and the separate mock asset issuer retains its asset privileges.
- Official SDN digital-address screening is a backend reservation precheck,
  not an onchain passport predicate. The optional ZKPassport sanctions
  extension is a separate pinned-list document predicate. Neither alone
  establishes complete sanctions compliance.
- Current live tokens use the demo issuer from `/anchor-gate/info`, not the
  upstream guide's Circle Testnet issuer. Asset code `USDC` is not identity.

## What we must not claim

The fork's custom exchange does not work in an arbitrary SEP-6 wallet merely
by changing the home domain. It has no standard SEP-6 proof adapter, no
claimable-balance fallback, no memo-based withdrawal watcher, no real TRY
banking and no production identity/compliance approval. Upstream protocol
conformance results do not establish conformance of this new flow.

A future standard adapter must preserve the same vault enforcement while
mapping SEP transaction states, proof interaction, wallet authorization,
history and recovery into a documented wallet-compatible protocol. Re-enabling
the old payout path is not such an adapter.

## Verification in this review

Read-only local requests returned disabled legacy deposits and withdrawals at
`/sep6/info` and an enabled custom Testnet gate at `/anchor-gate/info`.
Legacy-route tests cover attempts to create deposits/withdrawals, simulate
bank receipt, gain SEP-12 approval or settle through the old workers. The
source review found no legacy asset-transfer bypass in those paths; this is
not a security audit. Notification workers are separate from asset-transfer
workers; `ANCHOR_MODE` alone does not disable every background notification.

The historical deposit proof and settlement remain independently inspectable:

- [Native proof transaction](https://stellar.expert/explorer/testnet/tx/6d672ca27815a0ae13eb91801aa73ecba2a8eb6d36b1065d65e369a37276ea89).
- [Token settlement](https://stellar.expert/explorer/testnet/tx/9f9f064a0bbc9613be7be7a25c638a38f7a640eb97e2de98313d84cd235bd1ed).

Those transactions used the original age/country policy, not the new sanctions
extension. They are not evidence that a sanctions proof has passed.
