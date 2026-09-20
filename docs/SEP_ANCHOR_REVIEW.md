# SEP anchor release review

Prepared 20 September 2026. Original upstream comparison point:
`81eef8af29fa8fdc6f6596a4472c8bedb5381668`.

The standards review inspected `81eef8a...4ba93e7`; the independent requirements
review inspected `81eef8a...61227db`. Remediation was reviewed through
`46e1f69`. The source requirements are
[the interoperability acceptance criteria](SEP_ZKPASSPORT_INTEROPERABILITY.md)
and the approved standard payment-and-memo custody model, not the older custom
wallet-signed escrow interface. These are engineering reviews, not independent
cryptographic audits.

## Standards

The documented vocabulary originally described every proof as order-bound.
That no longer matched the new reusable wallet-and-policy grant. Commit
`61227db` corrected `CONTEXT.md` and separated eligibility, custody payment and
settlement. No hard standards findings remain in the reviewed delta.

One non-blocking heuristic remains: possible Duplicated Code between
`src/sep-quotes.ts` and `src/routes/sep38.ts` in directional conversion, rounding
and fee formatting. A later shared pure calculation could reduce drift risk.
The pre-cap quote behavior passed the SEP-38 suite; the final stricter native
limits require in-profile amounts. No speculative arithmetic refactor was made
during deployment.

Standards summary: 0 remaining hard findings, 1 optional design heuristic.
The largest remaining standards concern is duplicated quote arithmetic.

## Spec

Two concrete defects were found and repaired:

- The provider initially had 100 tokens and a 100-token trustline limit, so a
  standalone withdrawal would fail even while payment instructions were shown.
  Commit `c948f9e` checks live receiver capacity before returning payment-ready
  status. Commit `d94c3c1` separates capacity from minted liquidity and provides
  a separately journaled repair. Independent Testnet readback confirmed a
  1000-token limit, unchanged 100-token balance and one `change_trust` operation.
- Expired eligibility hid the parent section containing an available refund.
  Commit `3f71d46` keeps escrow recovery accessible independently of eligibility,
  removes new-proof prompts after irreversible payout authorization, and labels
  deposit cancellation accurately. Five production-entry browser regressions
  exercise the actual HTML hierarchy and recovery actions.

The remaining acceptance gap is explicit: a fresh positive Count8 phone proof
and completed exchanges in unmodified target wallets have not been demonstrated
against this public deployment. The older Count7 evidence is not a substitute.
API schemas, contract state-machine tests and malformed-proof rejection cannot
establish this positive end-to-end result.

Spec summary: 2 concrete defects resolved, 1 remaining acceptance gap.
The largest remaining requirement is fresh phone-to-settlement acceptance.

## Protocol validation and handoff

The official SEP-1/SEP-10 suite passed all 21 tests against public HTTPS.
The first safe SEP-24/SEP-38 run passed 50 checks and exposed an unknown opaque-ID
lookup returning 400 instead of 404, plus a cookie-less redirect limitation.
Commit `d53d305` fixes opaque lookup semantics while retaining strict native IDs
and owner isolation. Commit `5d70dfb` restores missing/expired browser-session
recovery through the same order's wallet login. API authorization, origin
checks and one-use bootstrap enforcement remain unchanged. At `5d70dfb` the
repeat safe run passed 52 checks: 34 SEP-24, 15 SEP-38 and three discovery/login
dependencies. This is pre-cap evidence: its hard-coded 100-USDC quote is above
the final native policy's 10-token limit and must no longer be accepted.
Six pending-payment/completed transaction cases require genuine phone-backed
fixtures and are not counted as passes.

Commit `c197362` rejects firm quotes above either native token or TRY cap before
persisting them, rejects unavailable or expired native policy and bounds quote
expiry to policy expiry. The same checks apply to public SEP-38 and hosted
quotes. Acceptance retains its independent guards; no contract cap was raised
to satisfy the legacy suite's fixture amounts.

Commit `46e1f69` removes unnecessary native order/configuration polling only for
requests with no accepted terms, no chain state and no recorded actions. An
independent HTTP harness with ten untouched requests and 50 ms external reads
improved from 1104 ms to 57 ms. Pending proof-before-quote actions still reconcile,
and accepted-order native lookup failures still fail closed. All 402 application
tests, both typechecks and the production build pass at this revision.

## Dependency audit boundary

`npm audit --omit=dev` reported zero known vulnerabilities on 20 September 2026.
The full audit reported five high-severity affected packages in the pinned
development-only `@stellar/anchor-tests@0.6.22` dependency tree: the test harness,
its old unscoped `stellar-sdk`, Axios 0.21.1, jsonwebtoken 8.5.1 and TOML parsers.
This is not a clean full-dependency audit. The production image prunes these
development packages, and neither browser entry imports the legacy harness.
An esbuild dependency-graph check found none of those legacy test packages in
either browser bundle.
The unmodified suite was used only against this controlled Testnet anchor with
disposable or agent-owned test accounts. Updating or replacing that legacy
harness needs a separate compatibility check; no blind audit-fix override was
applied to the conformance evidence.

See [deployment evidence and the wake-up checklist](SEP_ANCHOR_DEPLOYMENT.md)
for contract addresses, confirmed transactions, expiry and the exact remaining
manual test. No broad wallet compatibility or production compliance claim is
made by this review.
