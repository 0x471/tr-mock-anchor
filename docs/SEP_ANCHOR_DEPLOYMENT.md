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

Hosted HTTP acceptance passed without accepting a quote, reserving funds or
requesting a phone proof. A successful container build or API check does not
establish a completed exchange.

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

- Public HTTPS discovery reports Testnet, the exact issuer, SEP-6 and SEP-24.
  SEP-10 challenges were validated before signing with an agent-owned test key.
- Public deposit and withdrawal initiation, transaction history, firm quote
  creation/read, owner isolation, one-use bootstrap sessions, secure cookies
  and CSRF rejection passed. No quote was accepted by this HTTP smoke test.
- SEP-12 correctly reports `NEEDS_INFO` without a native eligibility grant.
  Legacy economic routes remain blocked. This is not an unmodified-wallet
  conformance-suite pass or completed phone-proof acceptance.
- 21 native and 21 compiled-Wasm SEP contract tests, including real signed
  dual-role authorization, recipient/refund binding and lifecycle races.
- 31 native and 31 compiled-Wasm old-vault regression tests.
- Protocol 28 address-V2 authorization is covered by gateway regressions.
- The provider received exactly 100 mock USDC in a
  [one-time liquidity payment](https://stellar.expert/explorer/testnet/tx/116ebe83a363b210766c020a64657fa909bbf1a2738b0d5025806cc88365ce59).
- A [0.1 mock-USDC reservation](https://stellar.expert/explorer/testnet/tx/c71a7b56457798231c6967a447e2eb85df9b1077c6365d77e20a352452609e46)
  succeeded at ledger 4769966. A malformed proof and settlement without proof
  or bank receipt were rejected in native simulation.
- [Cancellation](https://stellar.expert/explorer/testnet/tx/614814055a49b10ca2476dec7ecb815f47051b2a998cf0f81a8c7bad94e3babf)
  succeeded at ledger 4769968. The reservation returned to zero and the provider
  balance was restored exactly. This was not a completed deposit.

State-machine tests stub the external mathematical verifier. They are not
evidence of a fresh positive Count8 proof. The older Count7 phone acceptance
transactions belong to a different policy and contract.

## Wake-up acceptance checklist

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

Phone proof, positive public deposit and positive public withdrawal acceptance
remain unchecked until those steps actually finish. If proof generation fails,
retain the order and refresh eligibility; do not change its quote or payment.

## Operator safety

Deployment uses `scripts/deploy-sep-anchor.mjs`; liquidity uses
`scripts/setup-sep-liquidity.mjs`. Both default to read-only checks and require
explicit `--execute`. Keep the same private journal permanently. Signed
envelopes are saved with mode 0600 before sending; retries reconcile the same
hash. A failed or expired unknown envelope is not silently replaced.

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
