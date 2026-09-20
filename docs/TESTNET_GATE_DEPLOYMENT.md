# Testnet gate deployment record

Status: fresh synthetic ZKR country proofs and authenticated HTTP deposit and
withdrawal runs completed native onchain acceptance, separate mock-bank receipts
and exact settlements. The full Freighter browser run and public hosting remain
pending. The original TUR reservation remains held.
All amounts are synthetic Testnet assets. None of these contracts are audited.

## Country verifier deployments

| Profile     | Contract                                                   | Wasm SHA-256                                                       |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| OuterCount6 | `CCVASIBO2PILYUMUENSUHVBSQC2KEDH4NTT2HT3L6Y2CL7I2BNUXPOXU` | `1057b03c980bce6f0f747723ccbe087f4bc5864420cd9f6b96e27d4eb611f22f` |
| OuterCount7 | `CAAUATIVLLUMS22T6T26FLTXJ63TF27HWT7FOJ7GTGYMZWQXKADFS35M` | `1075edf65f5b6f1f7b8619a25b6bc0af8a1cad4a7594440f013430e17fc9045f` |

- Count6 [upload](https://stellar.expert/explorer/testnet/tx/7f2b8b95a5debe5dc75494055a584cc4b27e55cc47ec883bf0f55fe9ab84dee7), ledger 4766967; [deploy](https://stellar.expert/explorer/testnet/tx/d50ca49e546863d3eb66d44832bc0632bd6f8294ca62b4d68a56a56923cec5d2), ledger 4766969.
- Count7 [upload](https://stellar.expert/explorer/testnet/tx/6181a94d1f59998c08896837f3388b70170f0bf1f781be566fb93e8d71bc3188), ledger 4766974; [deploy](https://stellar.expert/explorer/testnet/tx/620f28f03298ccad0bfada6ba3009398997b0362af1d7fbdde679964c7218feb), ledger 4766976.

All four transaction receipts were independently fetched from Testnet RPC and
reported SUCCESS. Each contract's profile getter reports the expected immutable
key from [the country specification](COUNTRY_PROOF_PROFILE.md): respectively 11
and 12 external inputs, 10240 proof bytes, and 23 rounds. These deployment-time
metadata checks alone did not establish positive proof acceptance. The later
fresh Count7 acceptance is recorded below. Direct
contract-instance reads at ledgers 4767007 and 4767008 independently matched
the executable Wasm hashes in the table.

The deployed Count7 executable is pinned to the artifact above. Commit
`ffbef27149a2b6afaddeec23574322901455cae0` retains the verifier source used for
that deployment. Later comment-only cleanup in `6dd7068` produced a different
local release artifact hash; it has not replaced the deployed executable.
Use the exact pinned artifact when testing the live gate's Wasm behavior.

## Localhost v2 validation vault

Contract: `CDGRHNKXIW4AN7T2UIFW4X33TXD7V7BY63XTNC2RX5JKKJM5ADJZXKR7`.
Reviewed executable SHA-256:
`51db61488ab32fef8deb61f4dda58903e3295f5baa27d52543b9d6fd641aae97`.

- [Upload](https://stellar.expert/explorer/testnet/tx/8d6a27bbfa49099eeaafb6a9ddbdd0bcbe62af957b183a23fb33cc7bd160205d), SUCCESS, ledger 4767236.
- [Deployment](https://stellar.expert/explorer/testnet/tx/2888a418653b98282500ada0a510eb31e8267202e24dac754eb3ffa2f96799e9), SUCCESS, ledger 4767244.
- Independent instance/config/profile reads confirmed the executable, exact
  provider/notary/token, roots and Count7 verifier. The immutable policy hash is
  `8288c5192d980821f308e7f09803ca6d094f8c3389fbc62483e9a9955f1c1aca`.
- Policy: age >=18, nationality TUR, document issuer TUR; synthetic non-salted
  nullifier type 2 only. Proof and order lifetimes are each at most 3600 seconds.
- Domain `localhost`, scope `tr-mock-anchor-demo-v2`; policy snapshot expires
  2026-09-20T19:15:57Z. A public host requires its own hostname-bound vault.
- Per-order caps: 10 mock USDC and 500 simulated TRY, enforced onchain.
- Both official registry roots were revalidated immediately before deployment.
- At ledger 4767296, enforce-auth read-only simulations rejected missing-order
  prove/settle calls and unauthorized create/receipt/payout-authorization calls.
  No test signature or transaction submission was used for those negatives.

The upload helper initially stopped on its Testnet fee cap, then safely
reconciled the submitted upload after a local hash-formatting error. The single
upload and deployment receipts above were confirmed independently; neither
error was treated as permission to duplicate an uncertain transaction.
These deployment and negative checks do not establish positive proof acceptance.

## Initial TUR authenticated deposit reservation

The dedicated automated recipient completed SEP-10 authentication and reserved
one deposit through the anchor HTTP API:

- Order `d558837fce75f4ee1ff9c1ba7269563bf7b8fd83dbf7c604ba5a130379eaca5a`.
- Quote: 100.00 simulated TRY for 2.0947892 mock USDC.
- [Create transaction](https://stellar.expert/explorer/testnet/tx/64d1cee6ee445dd3f474f01c93e776b59de89773e1c9340df25d988aea9ebf66), SUCCESS, ledger 4767314.
- Provider tokens are reserved, not paid out. No accepted country proof, bank
  receipt or settlement has been recorded for this acceptance run.

The first phone request connected and was rejected before producing a proof.
The tester confirmed that the selected synthetic document did not match the
TUR/TUR/18+ policy. This is not evidence of onchain rejection or acceptance;
the policy has not been weakened to make the test pass.

Live authenticated HTTP negative checks rejected anonymous and foreign-origin
requests, bank simulation before eligibility, settlement before receipt,
withdrawal authorization on a deposit, and invalid proof lengths. The order
remained at the created stage with its original single create action.

## Active localhost ZKR demonstration vault

The tester explicitly approved switching the synthetic demonstration to age
18+, nationality ZKR and document issuer ZKR. Both country predicates remain
mandatory onchain; ZKR is a mock jurisdiction, not Turkish eligibility.

- Contract `CARWNKPAP5YAXFTZZJ7SFXKP4GGMCXRCA365XE75OQDTALQYXEYGJYSM`.
- [Deployment](https://stellar.expert/explorer/testnet/tx/032a8e4b09d82ea55ba840abd50cb60acca9eb4fd027263855cb48a6edb2d7b8), SUCCESS, ledger 4767528.
- Reuses the exact gate Wasm `51db61488ab32fef8deb61f4dda58903e3295f5baa27d52543b9d6fd641aae97`
  and pinned Count7 verifier above; no new verifier or gate-code upload.
- Domain `localhost`, scope `tr-mock-anchor-zkr-demo-v1`.
- Policy hash `3d58790408ded071a7898b253d887ec0e08498e830d6bfda4b9f2cfa3e051114`.
- Policy expires 2026-09-20T19:40:17Z; proof/order lifetimes remain 3600 seconds.
- Independent reads at ledger 4767543 checked the deployment receipt, source
  signature, constructor bytes, executable, policy hash and verifier profile.
  The original TUR vault's executable and policy were independently unchanged.

The fresh authenticated ZKR deposit order is
`0123766e159bd7681dcaf6ae1d46178d8c2852d6ab3515bd4764e32dae5ce0bc`,
100.00 simulated TRY for 2.0947892 mock USDC. Its
[create transaction](https://stellar.expert/explorer/testnet/tx/beeffd4705208862b7c4ffd37b4ed31a1e737d0e9e56e74430e37fa33467ec16)
succeeded at ledger 4767538 and reserved the exact token amount. The subsequent
fresh proof and completed deposit are recorded below.

At ledger 4767608, read-only SAC balance checks found 95.8104216 mock USDC at
the provider, zero at the recipient and 2.0947892 in each of the original TUR
and new ZKR vaults. Six live negative HTTP checks against the ZKR order rejected
unauthenticated/foreign-origin access, premature bank and settlement actions,
the wrong-direction authorization and malformed proof lengths. The order and
its sole create action were unchanged; no eligibility or bank credit was granted.

The old TUR reservation and its local database were preserved. Neither the
new deployment nor the country-policy change refunds its held Testnet tokens.

### Fresh Count7 proof and completed ZKR deposit

The genuine browser-origin phone request produced a fresh ZKPassport 0.20.0
OuterCount7 proof: 10240 proof bytes and 384 external-public-input bytes.
The native and exact deployed `1075edf6...9045f` Wasm runs of the
[capture regression harness](../contracts/zkpassport-verifier/tests/capture.rs)
each passed 18 checks: the unmodified capture and 17 explicit rejections.
The negatives change each of the 12 public inputs, truncate each input buffer,
append a proof byte, append an extra public input, or negate the final KZG point
on-curve. These are fixture-specific verifier checks, not a security audit.

The following distinct transactions were confirmed SUCCESS. The proof receipt
independently checked the recipient signature, one `prove_order` invocation,
the exact order ID, gate executable, and byte equality with the privately tested
capture. Raw proof bytes, public inputs, session links and signed envelopes are
not included here.

| Gate action                         | Confirmed Testnet transaction                                                                                             | Ledger  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| Native proof and order eligibility  | [Proof](https://stellar.expert/explorer/testnet/tx/4a0e7e262c842241d16e81d45f5f969e8179f425ac8e5b9604c6488e26710d4e)      | 4767724 |
| Separate simulated TRY receipt      | [Receipt](https://stellar.expert/explorer/testnet/tx/08c7206344b3577017df488edfebfe8b83006628471493f874b4213eb692ee6f)    | 4767762 |
| Exact token settlement to recipient | [Settlement](https://stellar.expert/explorer/testnet/tx/b298032e175360003245750a06fce003789bfd4decb85d5dce87316a90d9a41e) | 4767765 |

The confirmed order read at ledger 4767766 reported `stage: settled`,
`completed: true`, a receipt ID and `escrowed: false`. The proof transaction
alone had granted eligibility without a bank receipt or settlement. Only the
later receipt and settlement completed the exchange.

Read-only SAC balances before the proof (ledger 4767608) and after settlement
(ledger 4767766) reconcile the exact 100.00 simulated TRY for 2.0947892 mock USDC.
Values below are integer token base units, with 7 decimal places:

| Account             |    Before |     After |    Change |
| ------------------- | --------: | --------: | --------: |
| Dedicated recipient |         0 |  20947892 | +20947892 |
| ZKR vault           |  20947892 |         0 | -20947892 |
| Provider            | 958104216 | 958104216 |         0 |
| Original TUR vault  |  20947892 |  20947892 |         0 |

This was an authenticated HTTP acceptance run with the dedicated automated
Testnet recipient. The synthetic proof was captured in a genuine browser-origin
phone session; the separate operator signed through the dedicated wallet.
It was not a completed Freighter browser click-through. Full Freighter browser
and public-host acceptance remain pending. No real document, TRY transfer,
Circle USDC or mainnet operation is implied.

### Fresh Count7 proof and completed ZKR withdrawal

A separate authenticated withdrawal order,
`2de40a60ece360bef1748c8ee7887e3c0634421d6d37eb52227c6e846ba5c0d5`,
exchanged exactly 1.0000000 mock USDC for 47.26 simulated TRY. Its beneficiary
was the synthetic label `demo:synthetic-zkr-wallet`, not a real bank account.
The create transaction did not debit the recipient or reserve provider tokens.

The second fresh browser-origin Count7 phone capture was separately checked
against both the native verifier and the exact deployed `1075edf6...9045f`
Wasm. Each passed the same 18 capture checks described above, including all
17 explicit rejection cases. The independent proof receipt checked the
recipient signature, the exact private proof/input bytes, and the nested
recipient-authorized transfer of 10000000 token base units into the vault.

All five action receipts were confirmed SUCCESS:

| Gate action                               | Confirmed Testnet transaction                                                                                             | Ledger  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| Create immutable withdrawal               | [Create](https://stellar.expert/explorer/testnet/tx/b32540361d119c5516101f4314437bcb504e845b7c61769d098a74d5fcf269e4)     | 4767774 |
| Native proof, eligibility and user escrow | [Proof](https://stellar.expert/explorer/testnet/tx/c53b5d37fcb830346b514fbd0b164c342e0930819bdca1bdac80e5c152b7b499)      | 4767860 |
| Separate notary payout authorization      | [Authorize](https://stellar.expert/explorer/testnet/tx/12e60e19a40bd549c0e49cb498d14dfc75a2aab1edf8789dfe9c0f1975bc0f98)  | 4767870 |
| Simulated TRY paid receipt                | [Receipt](https://stellar.expert/explorer/testnet/tx/3edc7e13ee419faacbb4664c897afdd4620a86b8c689b30df93db82ff8dffcfc)    | 4767873 |
| Exact escrow settlement to provider       | [Settlement](https://stellar.expert/explorer/testnet/tx/51ffbb7c5f207778949f4ff3c7f0b406f41fc19b7faf0f6a1bde6691b45250b1) | 4767875 |

Independent receipt checks confirmed role signatures, exact quote terms and
beneficiary, authorization before the paid receipt, and one exact vault-to-
provider settlement transfer. A read-only settle replay at ledger 4767896
returned the settled order without another token transfer; no replay transaction
was submitted. These checks are not a global token-issuance or security audit.

Proof acceptance initially returned eligibility and escrow without payout
authorization, a bank receipt or settlement. The later confirmed HTTP order
at ledger 4767877 reported `stage: settled`, `completed: true`, a paid receipt
and `escrowed: false`. Its local mock-bank record credits exactly 47.26
simulated TRY to the fixed synthetic beneficiary; the notary's onchain paid
receipt attests that record, not real bank movement. A separate local database
check confirmed exactly one such credit.

Read-only SAC balance snapshots show the two distinct token movements. Values
are integer base units with 7 decimal places; snapshots were taken after
creation at ledger 4767785, after proof at 4767864, and after settlement at
4767876 (provider) and 4767877 (the other accounts):

| Account             | After creation | After proof | After settlement |
| ------------------- | -------------: | ----------: | ---------------: |
| Dedicated recipient |       20947892 |    10947892 |         10947892 |
| ZKR vault           |              0 |    10000000 |                0 |
| Provider            |      958104216 |   958104216 |        968104216 |
| Original TUR vault  |       20947892 |    20947892 |         20947892 |

This withdrawal used the same dedicated Testnet wallet and authenticated HTTP
seam, with a separate browser-origin phone capture. It does not complete the
Freighter browser or public-host acceptance tests. The original TUR reservation
remained untouched; no refund, real fiat transfer or production approval is
implied.

## Isolated demo accounts and asset

| Role                     | Public address                                             |
| ------------------------ | ---------------------------------------------------------- |
| Deployer                 | `GAZOT6YMKME6R7DYCLPUOI22IEQGCO5LX3ZJ24GOZ3NVPNPDIJQXCKKR` |
| Provider                 | `GC5SATYYPUZK2IDA4FE3M7P4V4SLQSE6L6UADNPUA6PB5UEDNI6YHJMV` |
| Mock-bank notary         | `GDBQZLVRJYSRRYO2CQW6XJHTKS7FCDD3INTPTUKPWJZNFOU4PMGRGHIH` |
| Mock-USDC issuer         | `GDQYN2SNSRQCGBJYB7SQFQIKKKN4YWZCHYZQ5W7UKAB6P36MSIKCVKQN` |
| Automated test recipient | `GAUR4ROFX7IH353X4L54LPDPGET7Q3CRN3N3DFE6FOHVXR4Z5M6SRQZR` |

The last four accounts were generated with Stellar CLI and funded with Friendbot.
Their private keys remain in task-local restricted identity files, not this repo.
The automated recipient is a dedicated agent-controlled Testnet test wallet, not
a claim about custody of the user's personal wallet. The browser flow separately
requires real Freighter wallet signatures.

The asset code is `USDC` with the mock issuer above, not Circle USDC. Its SAC is
`CDC35FLF2CZWYA2EFBMW4GCCL2BBYZZGXRZGLJLEAE5UR4CIDUA44OXE`.

- Provider [trustline](https://stellar.expert/explorer/testnet/tx/ea88a627f11e48b8e64de3e96dda0dd47047af0f60d267b2dc5a82c1bc466860), ledger 4766951.
- Recipient [trustline](https://stellar.expert/explorer/testnet/tx/2380fd3c1ec98c422ff7fceeeef2fb7bb109cb88af3f1b9c3225f2b0270a6e69), ledger 4766952.
- Exactly 100 mock USDC [issued to the provider](https://stellar.expert/explorer/testnet/tx/0a36d66ef717d6d5798b7c075c1e17d119c11d28152248edd138f02625eac807), ledger 4766953.
- [Asset contract deployment](https://stellar.expert/explorer/testnet/tx/26d1c724a6295f5e0ec0723328a100bf9b5cf2fd493706b12565e089d9f03bbe), ledger 4766954.

No real TRY transfer, customer identity, production approval or mainnet activity
is implied. The native gate has no cancellation/refund path; expired unresolved
reservations are intentionally retained and must not be described as refunded.
