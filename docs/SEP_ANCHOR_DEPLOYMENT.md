# Native SEP anchor deployment

Prepared 20 September 2026. Testnet only, simulated TRY, synthetic documents,
self-issued mock USDC. No mainnet funds or user wallet secret is used.

## Public service

Live service: https://tr-anchor-zkpassport.up.railway.app/anchor

Railway project `904332b6-0279-406e-98c7-3e73f19b5a29`, service
`c4842570-b8f1-4088-b544-f7c4cd57662e`, environment
`2e8967cd-ed9b-47b5-a1f8-9caafe8cb695`. The feature branch is
`feat/zkpassport-anchor`, not upstream main. SQLite uses `/data/anchor.db`
on the attached persistent volume, with one replica and legacy workers off.
The separate SEP reconciliation loop remains active.
Railway waits for GitHub CI and checks `/health` before completing deployment.
That endpoint is a process liveness check, not a positive proof or settlement test.

The initial automated hosted HTTP checks passed without accepting a quote,
reserving funds or requesting a phone proof. A later user-driven public Count8
phone proof and deposit completed at source revision `91fb27b`; the distinct
transaction evidence is recorded below. A successful container build or API
check alone does not establish a completed exchange.

## Immutable Testnet contracts

| Component                              | Address / hash                                                     |
| -------------------------------------- | ------------------------------------------------------------------ |
| SEP anchor                             | `CA4SZYDLN5Q2QUG6ZPVWCECSSFJPTRCQTL64VNTXOVTZNTVCCQIK2VRM`         |
| Anchor Wasm SHA-256                    | `e6ff58f1115fbdf71488caf2599f74e12e72dc21ddea1c231b013cdce6a88828` |
| Count8 verifier                        | `CAXZT4KA4KDP4A2ERRMYEUBQE53XZ67NHXICO4AXNTAKJCXDKGFGCJ4H`         |
| Verifier Wasm SHA-256                  | `64f5462bc11869ce9ac145d89bec64084ab200be88e9a4ec38c6c8150e73546f` |
| Verification key hash                  | `03dbb84b656cdf3b9f93d809c530b4c3901fe5be6f56c424a04ae827ebe45a08` |
| Policy hash                            | `e963fa9b882ead82cfcd1a87ef5895e2bf0c1128581307fa2baebb34c46898be` |
| Provider / classic payment destination | `GDAHV4MVSXLCR4ELY4JK3F6WNEQCONAZTLTKBGDJZARXBRGWMTTIMK22`         |
| Mock-bank notary                       | `GCCDVX4UKCL36M3566XGK6HGTFINNSBKMG3DVCLKP2G3JCPIJL6IWUD2`         |
| Mock USDC issuer                       | `GDQYN2SNSRQCGBJYB7SQFQIKKKN4YWZCHYZQ5W7UKAB6P36MSIKCVKQN`         |
| Asset contract                         | `CDC35FLF2CZWYA2EFBMW4GCCL2BBYZZGXRZGLJLEAE5UR4CIDUA44OXE`         |

[Verifier deployment](https://stellar.expert/explorer/testnet/tx/ab65b77a3549530aa5d4f3f22b33a108d667acff86bea2d4a677890760db617b)
and [anchor deployment](https://stellar.expert/explorer/testnet/tx/ad462dccee56b4e5fef91415b73129ab20fcd757472d882f6a08c5ec190d907b)
were confirmed. RPC code bytes, constructor config and verifier profile were
read back and matched their pins. The verifier expects 10,240 proof bytes and
13 external 32-byte inputs, with log N 23.

The policy binds the public hostname, scope `tr-anchor-sep-synthetic-v1`,
age 18+, nationality ZKR and issuer ZKR. The certificate and circuit roots are
recorded by the deployment journal. The strict sanctions root is
`2dfcc0ca426d9d8e751bb00fc9ab502bfb081ba8d2ce3f5f94a8f1712b3afca8`.
Its CDN last-modified date was 25 January 2026. Registry validity or a matching
CDN root is not evidence of current-list freshness. Root changes fail closed.

The immutable policy expires at `2026-09-20T22:54:22Z`, which is
21 September at 01:54:22 in Europe/Istanbul. A grant lasts at most one hour
from its proof timestamp and never past policy expiry. New orders need a new
reviewed deployment after policy expiry; restarting the server does not renew it.

## Confirmed checks

- All 384 application tests, server/browser typechecks and the production build
  passed at `5d70dfb`. [CI run 35486412041](https://github.com/0x471/tr-mock-anchor/actions/runs/35486412041)
  also passed native verifier profiles, the old vault and the new SEP contract
  in native and compiled-Wasm execution. Railway deployed that revision and
  passed its startup health check.
- The quote-limit and polling corrections at `46e1f69` passed all 402
  application tests, both typechecks and the production build locally.
  [CI run 35486976343](https://github.com/0x471/tr-mock-anchor/actions/runs/35486976343)
  is the follow-up run for that revision; inspect its result separately from
  the earlier confirmed deployment.
- Public HTTPS discovery reports Testnet, the exact issuer, SEP-6 and SEP-24.
  SEP-10 challenges were validated before signing with an agent-owned test key.
- The unmodified `@stellar/anchor-tests@0.6.22` SEP-1 and SEP-10 suite passed
  all 21 tests against the public host, including signer/threshold cases on
  disposable Friendbot-funded accounts. User and operator keys were not used.
- Public deposit and withdrawal initiation, transaction history, firm quote
  creation/read, owner isolation, one-use bootstrap sessions, secure cookies
  and CSRF rejection passed. No quote was accepted by this HTTP smoke test.
- The safe unmodified SEP-24/SEP-38 suite passed 52 checks at `5d70dfb`, with
  six genuine pending/completed fixtures excluded. Its 100-USDC quote fixture
  predates the quote-cap correction and is outside the final policy. Native
  caps are enforced before quote issuance, not raised to fit that fixture.
- SEP-12 correctly reports `NEEDS_INFO` without a native eligibility grant.
  Legacy economic routes remain blocked. Those API checks alone do not
  establish unmodified-wallet completed exchanges or positive phone-proof
  acceptance; the later public phone-backed deposit is recorded separately.
- 21 native and 21 compiled-Wasm SEP contract tests, including real signed
  dual-role authorization, recipient/refund binding and lifecycle races.
- 31 native and 31 compiled-Wasm old-vault regression tests.
- Protocol 28 address-V2 authorization is covered by gateway regressions.
- The provider received exactly 100 mock USDC in a
  [one-time liquidity payment](https://stellar.expert/explorer/testnet/tx/116ebe83a363b210766c020a64657fa909bbf1a2738b0d5025806cc88365ce59).
- A separate [trustline-capacity repair](https://stellar.expert/explorer/testnet/tx/85ef19ddaf63a862560dc0dd6fef6c01a807b33da66109de8df28c155d7ac07a)
  increased the provider's limit to 1000 mock USDC at ledger 4770125.
  Balance remained 100, leaving 900 receiving capacity with no buying
  liabilities. It contained one `change_trust`, no mint or payment, and charged
  100 stroops. Withdrawal readiness also checks live receiver capacity.
- A [0.1 mock-USDC reservation](https://stellar.expert/explorer/testnet/tx/c71a7b56457798231c6967a447e2eb85df9b1077c6365d77e20a352452609e46)
  succeeded at ledger 4769966. A malformed proof and settlement without proof
  or bank receipt were rejected in native simulation.
- [Cancellation](https://stellar.expert/explorer/testnet/tx/614814055a49b10ca2476dec7ecb815f47051b2a998cf0f81a8c7bad94e3babf)
  succeeded at ledger 4769968. The reservation returned to zero and the provider
  balance was restored exactly. This was not a completed deposit.

State-machine tests stub the external mathematical verifier. They are not
evidence of a fresh positive Count8 proof. The positive Count8 evidence below
comes from committed native transactions, not these stubs. The older Count7
phone acceptance transactions belong to a different policy and contract.

## Fresh public Count8 deposit acceptance

On 20 September 2026, the user completed a synthetic ZKPassport phone request
and deposit through the public hosted interface at source revision `91fb27b`.
This is a separate acceptance run against the SEP anchor and Count8 verifier
pinned above, not reuse of the older Count7 custom-vault evidence.

Order: `a22d62e716f476d52a7757ea39e567dab025a1362641d0cb82637b60dc8a3bb0`.
Recipient: `GALG2DAWDUDXDSIQYZ33C3QWJJWIOD674FD6DTKQ3KIL5FEVXX7DVHP4`.
Exact exchange: **100.00 simulated TRY for 2.0947892 mock USDC**.

| Native action        | Confirmed transaction                                                                                                                  | Ledger  | Time (UTC) |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| `submit_eligibility` | [Fresh Count8 proof](https://stellar.expert/explorer/testnet/tx/08c7c414b6782886f55443c7179a2077f069561e0f5690519d8e22403a1e816e)      | 4772528 | 06:37:07   |
| `create_order`       | [Exact token reservation](https://stellar.expert/explorer/testnet/tx/7146c9fbdde671fc1ce775ee237875cfc7170c913ff3c51fed945a2547ef65ec) | 4772529 | 06:37:12   |
| `record_receipt`     | [Simulated TRY receipt](https://stellar.expert/explorer/testnet/tx/868b4decb806a5e208cbcdae0c0999a3b55d43bc42415f108784938d157081dd)   | 4772532 | 06:37:27   |
| `settle`             | [Mock USDC settlement](https://stellar.expert/explorer/testnet/tx/14d7463f6cf8b176ca3f9d6d2ccd10c51e2c4fc8ecd58472fce96d2f4c2553f1)    | 4772533 | 06:37:32   |

Independent Testnet RPC readback confirmed all four transactions succeeded
against the expected SEP anchor, with the eligibility subject bound to the
recipient. The native policy and verifier profile matched the pinned Count8
configuration: 10,240 proof bytes, 13 external inputs, log N 23, age 18+,
ZKR nationality, ZKR issuer and the strict pinned sanctions predicate.
The proof timestamp was `2026-09-20T06:35:47Z`; that grant's recorded expiry
was `2026-09-20T07:35:47Z` (10:35:47 in Europe/Istanbul).

The native order recorded `try_minor=10000`, `amount=20947892`, the exact
recipient and a bank receipt matching its immutable terms. Asset-contract
events confirmed 2.0947892 mock USDC moved from the provider into the anchor,
then from the anchor to the recipient. The user's issuer-specific Horizon
balance increased from 2.0947892 at 06:33:20 UTC to 4.1895784 at 06:40:43 UTC,
an exact 2.0947892 increase. The order was settled with no remaining escrow.

This establishes a fresh public phone-to-deposit result, not a completed
public withdrawal or end-to-end acceptance through an unmodified target
wallet's own SEP interface. It does not establish real identity, current
sanctions compliance or real fiat movement. No raw proof or signing key is
included in this evidence.

## Acceptance checklist

The native order limit is 10 mock USDC and 500 simulated TRY. Quotes must fit
both caps and expire no later than the immutable policy. The 100-TRY deposit
and 1-token withdrawal below are deliberately smaller than those limits.

1. Open the public `/anchor` page. Select Stellar Testnet in Freighter and use
   the admitted wallet. Friendbot setup is automatic when needed; a trustline
   still requires the owner's explicit wallet signature.
2. Choose deposit, enter 100 simulated TRY, review and accept the exact quote.
3. Create the QR only when ready. Use ZKPassport developer mode and the bundled
   adult synthetic John Smith document (ZKR/ZKR, birth date 1995-11-12).
   Do not use a real Turkish ID or send real money.
4. Wait for the native proof transaction to confirm, not merely an SDK success
   callback. Record simulated TRY receipt, then wait for completed settlement.
   Open the transaction evidence links and confirm the exact token balance.
5. Choose withdrawal for 1 mock USDC and a made-up `demo:` destination.
   Reuse current native eligibility or make a fresh proof if expired. Send the
   exact ordinary Stellar payment with the provided hash memo only once.
6. Wait for escrow confirmation, explicitly simulate the bank payout, then
   confirm settlement. Never replace a pending payment with another one.

The fresh phone proof and public deposit in steps 1-4 passed in the run above.
Public withdrawal acceptance in steps 5-6 and completed exchanges through
unmodified target-wallet SEP interfaces remain unchecked. If proof generation
fails, retain the order and refresh eligibility; do not change its quote or
payment.

## Operator safety

Deployment uses `scripts/deploy-sep-anchor.mjs`; liquidity uses
`scripts/setup-sep-liquidity.mjs`. Both default to read-only checks and require
explicit `--execute`. Keep the same private journal permanently. Signed
envelopes are saved with mode 0600 before sending; retries reconcile the same
hash. A failed or expired unknown envelope is not silently replaced.

The one-time receiver-capacity repair uses `scripts/repair-sep-headroom.mjs`
and its own private journal. Never replay the mint to adjust a trustline.
New liquidity journals create a 1000-token limit but still mint only 100.
Original version-1 journals preserve their already-signed 100-token limit.

The deployment uploader caps uploads at 20 Testnet XLM per transaction and
contract creation at 1 Testnet XLM. Ordinary hosted actions use the separately
configured 0.1 Testnet XLM cap. These are faucet-funded test units, not fees
paid from the user's wallet or mainnet funds.

Do not upload `.env`, journals, raw phone proofs or signing keys to GitHub.
Only the new demo provider/notary keys are stored in this Railway service's
private variables. The same provider is also the read-only legacy gateway
identity; legacy economics are disabled by `ANCHOR_MODE=zkpassport`.

Policy expiry does not refund money. An authorized withdrawal must reconcile
its existing bank obligation. A deposit with a bank receipt after immutable
policy expiry remains held and needs operator recovery; a deposit cancellation
is allowed only before the bank receipt and is not a fiat refund. Mismatched,
extra or late classic payments are retained for recovery, never repriced.
