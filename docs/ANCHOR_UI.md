# Anchor UI

## Scope

Keep the original Turkish mock anchor recognizable as a two-way exchange:
simulated TRY deposits to mock USDC, and mock USDC withdrawals to simulated
TRY. Add ZKPassport as an eligibility step inside that exchange, not a
standalone identity product. Use Inkognito's visual language for the redesign.

The current demo policy is synthetic documents only, age 18+, nationality ZKR
and document issuer ZKR. The Turkish anchor name describes the mock TRY rail,
not a Turkish eligibility predicate. Always render policy values from the
configured vault. Do not change policy or contract authorization for the UI.

## Acceptance

- Keep Deposit and Withdraw visible with their direction and asset labels.
- Guide users through Wallet, Amount, Verify and Finish, with accessible
  navigation and one focused workflow panel at a time.
- Use one centered exchange card and show only stage-relevant actions.
  Keep setup instructions, recovery and technical evidence in disclosures.
- Show exact amounts and document requirements before accepting a quote.
  Keep locked order amounts visible during verification and settlement.
  Make full policy, wallet, order and transaction evidence available in a
  collapsed exchange summary on desktop and mobile.
- Keep errors, expiry, pending outcomes and recovery warnings visible even
  when routine status text is hidden. Show exact escrow consent before signing.
- A phone proof is not eligibility, a bank receipt is not settlement, and a
  timeout is not failure. Show completion only from confirmed settled state.
- Preserve SEP-10 login, exact quote acceptance, native proof signing,
  withdrawal escrow consent, simulated receipts and payout authorization.
- Keep a timed-out reservation's exact terms and idempotency key. Permit
  same-request recovery, not a replacement quote. Expired fresh quotes and
  expired phone requests must not look actionable.
- Keep resume input and transaction-link focus stable during timer refreshes.
- Keep mainnet, real money, real documents, personal bank data and production
  identity/compliance claims outside this demo.
- Use local fonts, visible focus, readable contrast, responsive layout and
  reduced-motion support without weakening the content security policy.

## Validation on 2026-09-20

- Typecheck, production build and the full Vitest suite passed.
- Browser checks covered the live policy, direction selection, missing-wallet
  feedback, locked unauthenticated actions, recovery input and keyboard focus.
- Layout checks covered 1280px desktop and 390px/320px mobile widths. Inert,
  clearly labelled visual fixtures covered quote, QR and settled layouts;
  those fixtures did not call the anchor or submit transactions.
- Regression tests cover exact reservation recovery, expiry, phone-session
  cleanup, order switching, pending proof signing and honest pending labels.
- Real Freighter signing and a fresh phone-to-settlement run were not repeated
  for this visual pass. The earlier Testnet settlement evidence remains
  separate. Contracts, policy and settlement authorization were not changed.

The earlier UI standards/spec review used `389ed8c`, the pre-redesign
checkpoint, not the original upstream baseline used by the broader project
review. Its pending-status wording and duplicate-test-helper findings were
resolved before delivery.

## Simplification pass

The follow-up pass uses `275aee8` as its checkpoint. It replaces the wide
overview and sidebar with one compact card. Routine status text is hidden;
setup, recovery, evidence and background explanations remain available on
demand. Quote review replaces amount entry instead of repeating it. Withdrawal
references stay editable until reservation, and settlement controls appear in
their confirmed order rather than as a row of disabled buttons.

Browser-flow tests cover progressive controls, exact policy and escrow
consent, sequential withdrawal actions, combined proof/order expiry and focus
recovery when an action hides its own control.
A persistent screen-reader status announces important updates even when the
visual status card is hidden. Mobile checks found no horizontal overflow at
390px and 320px; an inert fixture checks quote and QR layouts without creating
orders or sending transactions.

## Design reference

Inkognito: <https://github.com/trionlabs/inkognito>

Reviewed commit: `a830d28535b45ac4a5751a8aa49c1ed4a3c374ce`.

Adapted visual ideas include the near-black monochrome palette, Playfair
Display headings, IBM Plex text, square outlined controls, compact uppercase
labels and structured exchange details. Anchor business logic,
copy and state handling remain specific to this repository. Font provenance
and OFL licenses are recorded in `web/fonts/`.

## Inkognito license

MIT License

Copyright (c) 2026 Trion Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
