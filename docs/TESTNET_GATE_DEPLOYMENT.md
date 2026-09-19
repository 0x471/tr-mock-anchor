# Testnet gate deployment record

Status: verifier profiles and mock asset deployed; gate policy and fresh phone
proof are pending. No completed anchor deposit is claimed by this record.
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
and 12 external inputs, 10240 proof bytes, and 23 rounds. These are read-only
metadata checks, not positive country-proof verification transactions. Direct
contract-instance reads at ledgers 4767007 and 4767008 independently matched
the executable Wasm hashes in the table.

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
