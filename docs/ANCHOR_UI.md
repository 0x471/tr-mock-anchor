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
- Guide users through Wallet, Quote, Verify and Settle, with accessible
  navigation and one focused workflow panel at a time.
- Show exact amounts, policy, wallet, order and transaction evidence in a
  persistent exchange summary. Keep that information available on mobile.
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

## Design reference

Inkognito: <https://github.com/trionlabs/inkognito>

Reviewed commit: `a830d28535b45ac4a5751a8aa49c1ed4a3c374ce`.

Adapted visual ideas include the near-black monochrome palette, Playfair
Display headings, IBM Plex text, square outlined controls, compact uppercase
labels and a workflow beside a structured blueprint. Anchor business logic,
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
