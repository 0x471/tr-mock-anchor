# SEP interoperability with native ZKPassport verification

Research date: 2026-09-20. Read-only assessment, not a deployment claim.
Local baseline: `69ac9f378ac1303f9ee68cabd7fd23053060490b`.

## Decision

Use SEP-24 for the first-time phone-proof experience. Restore SEP-6 only when
its declared capabilities really work through the standard API. Native proof
verification can remain mandatory under either transport, but the current
wallet-signed vault call is not a standard SEP payment instruction.

There are three separate acceptance questions:

1. Does an ordinary wallet discover and understand the HTTP flow?
2. Does the contract verify the proof and its exact policy/order binding?
3. Can token movement bypass that contract, including before escrow?

Passing one does not establish the others. A standards facade around the current
custom flow would not restore full interoperability.

## Pinned primary sources

| Source                                                                                                                   | Revision inspected                         | Relevant version                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| [Stellar protocols](https://github.com/stellar/stellar-protocol/tree/265d64edc87627707941a31bd12798b7fdeb47d1/ecosystem) | `265d64edc87627707941a31bd12798b7fdeb47d1` | SEP-6 4.3.0; SEP-12 1.15.0; SEP-24 3.8.0; SEP-38 2.5.0 |
| [SDF demo wallet](https://github.com/stellar/stellar-demo-wallet/tree/bd5c627c7780b02d54070b079d73b41f50550b65)          | `bd5c627c7780b02d54070b079d73b41f50550b65` | Current master, 2026-09-09                             |
| [SDF anchor tests](https://github.com/stellar/stellar-anchor-tests/tree/d39698763db249a6af78d7856fac6c4b2fe0d1f9)        | `d39698763db249a6af78d7856fac6c4b2fe0d1f9` | Current master, 2026-09-03                             |

These revisions were resolved from GitHub's public API. The test repository is
`stellar/stellar-anchor-tests`, not `stellar/anchor-tests`.

## What the protocols actually provide

### SEP-6: API onboarding, not a new popup protocol

SEP-6 explicitly deprecates its interactive components in favor of SEP-24.
Its deprecated `403 non_interactive_customer_info_needed` branch is not a
recommended new integration: return a transaction with
`pending_customer_info_update` and use SEP-12. The deprecated response's field
names must be SEP-9 names. `more_info_url` is informational, not a guaranteed
automatic popup or transaction-signing instruction. HTTPS and cross-origin
response headers are required. Non-equivalent TRY/USDC conversions belong in
the exchange endpoints with SEP-38. Authentication and payment accounts can
differ; the authenticated subject must not be silently substituted for every
payment participant. [SEP-6 specification](https://github.com/stellar/stellar-protocol/blob/265d64edc87627707941a31bd12798b7fdeb47d1/ecosystem/sep-0006.md)

### SEP-12: typed information, not executable actions

The field types are `string`, `binary`, `number`, and `date`. Descriptions can
explain custom fields, but there is no standard `url`, QR, app-request, or
Soroban-signing field type. `VERIFICATION_REQUIRED` describes a field whose
verification value is submitted with a `_verification` suffix; it is not a
general browser-launch mechanism. A client that already understands a custom
proof field could upload it, but the field does not teach an ordinary wallet
how to generate it. `ACCEPTED` is scoped to the customer type requested, and
must reflect actual acceptance, not a successful PUT alone.
[SEP-12 specification](https://github.com/stellar/stellar-protocol/blob/265d64edc87627707941a31bd12798b7fdeb47d1/ecosystem/sep-0012.md)

### SEP-24: the suitable hosted QR boundary

The interactive endpoints return HTTP 200 with
`type: interactive_customer_info_needed`, `url`, and `id`. The anchor-hosted
page can present the QR and consent. Carry authentication into it with a
short-lived, preferably one-use bootstrap token and then a backend session.
Preserve the transaction ID across this lifecycle. Status polling is standard;
optional completion/status callbacks support `postMessage` or signed URL
callbacks. `incomplete` fits unfinished interactive input, and
`pending_anchor` fits verification processing. Keep withdrawal instructions
unavailable until ready. `pending_user_transfer_start` tells the wallet to send
funds. SEP-24 does not itself add arbitrary contract-call signing to a wallet.
[SEP-24 specification](https://github.com/stellar/stellar-protocol/blob/265d64edc87627707941a31bd12798b7fdeb47d1/ecosystem/sep-0024.md)

### SEP-38: binding the economic terms

Version 2.5.0 remains marked Draft in the inspected source. The protocol
supports `context: sep6`, `sep24`, or `sep31`. A firm quote reserves capacity
until its expiration; it is not just an indicative number. Preserve asset
identifiers, amounts, delivery method, fee denomination and quote expiration.
Validate the documented price/fee identities using decimal arithmetic.
[SEP-38 specification](https://github.com/stellar/stellar-protocol/blob/265d64edc87627707941a31bd12798b7fdeb47d1/ecosystem/sep-0038.md)

## What SDF's actual wallet will do

| Situation                                        | Observed client behavior                                                    | Consequence                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| SEP-6 needs customer updates                     | Stops the transfer poller, retrieves SEP-12 fields, renders a customer form | A proof URL in a string field is not a launched phone flow                                               |
| SEP-12 custom field                              | Text/file/date/number input or choices select                               | Uploading an already generated proof is possible only with an agreed extension and manual/client support |
| SEP-6 withdrawal more-info URL                   | Rendered as plain text in the result screen                                 | Do not rely on it for automatic proof onboarding                                                         |
| SEP-24 response                                  | Opens the returned URL in a popup                                           | Suitable place for the hosted ZKPassport step                                                            |
| SEP-24 transaction status changes                | Navigates the existing popup to `more_info_url`                             | That URL must resume the same session without destroying an active proof request                         |
| Withdrawal becomes `pending_user_transfer_start` | Automatically constructs and sends the token payment                        | Do not emit this status merely because a quote exists                                                    |

The SEP-6 customer flow is explicit in the
[withdrawal controller](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-client/src/ducks/sep6Withdraw.ts#L544),
[field renderer](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-client/src/components/KycFieldInput.tsx),
and [result UI](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-client/src/components/Sep6Withdraw.tsx#L655).
Popup behavior comes from
[createPopup](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-shared/methods/sep24/createPopup.ts)
and the [SEP-24 withdrawal poller](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-shared/methods/sep24/pollWithdrawUntilComplete.ts#L50).

The latest wallet supports contract accounts, so saying it cannot perform any
Soroban operation would be wrong. Its classic withdrawal branch constructs
`Operation.payment` plus a memo. Its contract-account branch calls
`SmartWalletService.transfer` for the asset. Neither path accepts an
anchor-provided arbitrary vault ABI/proof invocation. Merely returning a vault
contract address does not make the classic payment branch work.
[Actual payment construction](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-shared/methods/sendWithdrawPayment.ts)

There is also a client-specific amount issue to test: the SEP-6 poller passes
the amount supplied by its controller, whereas the SEP-24 poller passes the
transaction's `amount_in`. Do not assume a changed quote amount will be picked
up identically by both paths.
[SEP-6 poller](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-shared/methods/sep6/pollWithdrawUntilComplete.ts#L69)
[SEP-24 poller](https://github.com/stellar/stellar-demo-wallet/blob/bd5c627c7780b02d54070b079d73b41f50550b65/packages/demo-wallet-shared/methods/sep24/pollWithdrawUntilComplete.ts#L70)

## Current implementation gap

At the local baseline, strict mode advertises legacy SEP-6 economic actions as
disabled; SEP-12 never reports native acceptance. There is no SEP-24 router in
the application. The separate proof gate requires
`order.terms.recipient.require_auth()` inside `prove_order`, verifies the proof,
and debits withdrawal tokens from that recipient in the same invocation.
Consequently, a generic wallet's standard transfer is not a substitute for the
current call. These are implementation facts, not protocol prohibitions.
[SEP-6 routes](../src/routes/sep6.ts), [SEP-12 routes](../src/routes/sep12.ts),
[application](../src/app.ts), [gate contract](../contracts/anchor-gate/src/lib.rs).

## Architecture alternatives

The following are design inferences, not claims that the SEPs specify a ZK gate.

| Alternative                                                                        | Wallet compatibility                                            | Security boundary                                                                                                                                |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current custom signing flow                                                        | Our web UI plus supported signer                                | Native eligibility and wallet-authorized escrow are coupled; not generic SEP withdrawal                                                          |
| SEP-24 QR plus relayed proof, normal payment into an operator treasury             | Standard hosted onboarding and payment                          | Proof may be native, but the operator controls ingress funds; a watcher statement is not onchain proof of the original payment                   |
| SEP-24 QR plus relayed proof, constrained classic-account ingress, contract escrow | Can preserve the normal payment instruction if fully engineered | Must prove ingress cannot be drained or substituted and that only actual received assets are credited; requires a new contract/account lifecycle |
| SEP-6 for already eligible customers                                               | Programmatic clients need no new QR step                        | Only valid while an exact accepted policy grant exists; fresh onboarding still needs a separate supported flow                                   |
| Custom SEP-12 proof/reference upload                                               | Works only for participating clients/users                      | Explicit extension, not universal zero-integration compatibility                                                                                 |

For a standard withdrawal, identify the exact order by immutable ingress
account/memo terms. A relayer can move actually received tokens into contract
escrow, but a shared treasury's transfer proves only that the treasury supplied
tokens. It does not prove the original sender, memo, or transaction hash.
Crediting an order from an operator-signed observation introduces an oracle
trust boundary. A proof of a transaction signature alone also does not prove
that transaction succeeded on Stellar. Do not describe either as trustless
payment verification.

A constrained per-order ingress account may narrow this gap, but requires a
separate reviewed construction: signer/threshold changes, source-account
authorization, fixed destination, sequence/fee handling, duplicate delivery,
under/overpayment, expired quote, refund paths, reserves, and recovery.
This note does not certify such a construction. The contract architecture must
establish its invariant before advertising standard withdrawals as equivalent
to the current wallet-authorized escrow.

For deposits, a relayer may submit an order-bound proof while the vault pays a
fixed recipient, avoiding a second wallet-signing requirement. Removing
`require_auth` is not a mechanical refactor: first prove replay/front-running
cannot change the order, recipient, policy, amount, direction, or destination
commitment. Phone consent, wallet ownership, onchain eligibility, and authority
to debit tokens are distinct concepts.

Off-chain TRY receipt/payout remains a mock-bank attestation. Native ZK
verification cannot force a real bank to pay, or make the issuer's broader
minting/admin authority disappear.

## Acceptance checklist before an interoperability claim

These are project acceptance criteria, not a claim that every item is mandatory
in every SEP implementation.

- Publish stable HTTPS discovery and API URLs with the correct network,
  signing key, actual mock asset issuer and truthful enabled capabilities.
  Localhost-only testing is not hosted interoperability.
- Decide and document the supported account profile: classic, muxed/shared,
  contract accounts and SEP-45. Test the supported cases; do not silently map
  a shared-account subject to its bare public key.
- Implement SEP-24 request/response/history and authenticated resume, not just
  a page redirect. Use one-use bootstrap credentials, bounded sessions,
  origin-checked callbacks, and safe return URLs. No long-lived SEP-10 JWT in
  query strings or logs.
- Keep QR generation idempotent across popup navigation and resume. Do not
  restart a live request because a wallet polls or revisits `more_info_url`.
- Display exact private predicates and snapshot age. Only mark proof accepted
  after confirmed native verification of the pinned profile and policy.
- Surface native grant state honestly in SEP-12, including expiry or policy
  replacement. A submitted proof, HTTP success or phone success is insufficient.
- Reserve each firm quote once. Bind its economics to the order; test expired
  quotes, duplicate requests, retries after unknown outcomes, wrong issuer,
  wrong network and delivery-method mismatch.
- Emit payment-ready status only after all required preceding steps succeed.
  Expose actual confirmed ledger transaction IDs, not pending submissions.
- Test normal Payment/path-payment matching, wrong memo, wrong sender policy,
  partial/extra/duplicate amounts, concurrent orders and refund destinations.
  Decide how standard flexible-amount flows coexist with exact-amount escrow;
  do not silently settle a different quote.
- Prove no legacy route or worker can bypass the same gate. Re-enabling
  `ANCHOR_MODE=legacy` is not restoration of native-gated interoperability.
- Run the pinned anchor suite with saved configuration and results, then
  complete fresh positive and negative flows in the unmodified SDF wallet.
  Repeat with another target wallet before claiming broad compatibility.
- Separately test malicious proof/public-input mutation, stale roots, replay,
  ingress-fund theft, forged receipt, and payout/escrow invariants. API tests do
  not establish these security properties.

## What anchor-tests does and does not establish

The suite checks authentication, request validation and response schemas. SEP-24
creation tests validate the response and retain its transaction ID. Pending and
completed transaction tests also accept configured existing transaction IDs;
they do not complete the phone flow themselves. Its more-info check issues an
HTTP GET and expects `200 text/html`; it does not operate the QR or signer.
[Creation test](https://github.com/stellar/stellar-anchor-tests/blob/d39698763db249a6af78d7856fac6c4b2fe0d1f9/@stellar/anchor-tests/src/tests/sep24/deposit.ts#L229),
[transaction checks](https://github.com/stellar/stellar-anchor-tests/blob/d39698763db249a6af78d7856fac6c4b2fe0d1f9/@stellar/anchor-tests/src/tests/sep24/transaction.ts#L248),
[HTML check](https://github.com/stellar/stellar-anchor-tests/blob/d39698763db249a6af78d7856fac6c4b2fe0d1f9/@stellar/anchor-tests/src/tests/sep24/transaction.ts#L677).

SEP-6 success tests still recognize the deprecated customer-info response
schema. Therefore a passing suite is useful evidence, not proof that the
latest recommended onboarding is implemented or that native gating cannot be
bypassed.
[SEP-6 deposit test](https://github.com/stellar/stellar-anchor-tests/blob/d39698763db249a6af78d7856fac6c4b2fe0d1f9/@stellar/anchor-tests/src/tests/sep6/deposit.ts#L295)

No public deployment, application mutation, phone request, or capture activation
was performed for this research. The separate localhost:8797 diagnostic was not
started by this task.

## Implementation addendum: SEP-6 admission boundary

The implemented Testnet profile deliberately supports programmatic SEP-6
exchanges only for admitted, self-custodial plain G accounts with a current native
eligibility grant. First-time users and users whose grant has expired use the
separately advertised SEP-24 hosted flow. This is a limited integration profile,
not universal SEP-6 onboarding or automatic wallet-popup support.

Both exchange routes read current native eligibility before creating an intent
and again before accepting a firm quote. A missing or expired grant returns
HTTP 403 with `error` and the application code `native_eligibility_required`.
The additional `onboarding_url` and `transfer_server_sep0024` fields, and the
`/sep6/info` profile object, are explanatory extensions. Generic clients are not
assumed to understand or navigate them. A request rejected at the first check
does not consume its quote, create a transfer intent or reserve tokens. Existing
transactions remain available through authenticated transaction lookup and their
hosted resume flow; an expired grant does not erase an order or refund escrow.

SEP-6 4.3.0 deprecates the old `non_interactive_customer_info_needed` error and
requires its field names to come from SEP-9. `zkpassport_proof` is not such a
field, so this implementation does not misuse that response. The specification's
recommended `pending_customer_info_update` transaction flow remains distinct
from this profile's pre-initiation rejection.
[Current SEP-6 shared responses](https://github.com/stellar/stellar-protocol/blob/265d64edc87627707941a31bd12798b7fdeb47d1/ecosystem/sep-0006.md#deposit-and-withdraw-shared-responses)

HTTP tests cover both missing and expired grants, unconsumed quotes after
rejection, and successful deposit/withdrawal initiation with a current native
grant. Their external native-gateway test double does not establish proof
cryptography or completion of a fresh phone-to-Testnet run.
