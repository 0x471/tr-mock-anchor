# Public synthetic compatibility fixture

These are public test artifacts, not the user's passport or secrets.

- ZKPassport circuit package: 0.20.0, BB5, OuterCount5, log N 22.
- Proof date: 2026-07-14T06:22:08Z. It must not be accepted as a fresh September eligibility proof.
- [Published proof source](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/solidity/test/fixtures/valid_proof.hex).
- [Published external public inputs](https://github.com/zkpassport/circuits/blob/9acc1e0400ddb3f226c83ed8c73f4a041af3ccb2/src/solidity/test/fixtures/valid_public_inputs.json).
- Matching generated verifier: [revision d3a75ac](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount5.sol), not the later changed key in repository HEAD.
- [Published 0.20.0 circuit manifest](https://circuits2.zkpassport.id/mainnet/by-version/0.20.0/manifest.json).

| Binary            | Bytes | SHA-256                                                          |
| ----------------- | ----: | ---------------------------------------------------------------- |
| proof.bin         |  9888 | d8823ce4ccf47aa2821d0916c2edf055ab8e0c339c606ef81f2299f3e9dfbb4b |
| public_inputs.bin |   320 | f1fcd5c90e774849f1e42597499ffc024a715da07558f89a1b77def7f9b9c0b9 |
| vkey.bin          |  1888 | 73ff42e97f58d55be8b62648fdca101e3e71c587e96d8c1304e0f6fe8404a232 |

The key is serialized as three 32-byte header words (22,18,5) and 28 raw G1 commitments in BB5 entity order. Its reduced Keccak hash is `0x013d18b35786455360821b6dbcb40174603cac5893781f0fc1601af4eacb01eb`, matching the official verifier. Proof scalars and public inputs are canonical big-endian 32-byte words; ordinary proof commitments are raw x||y.

## OuterCount8 key

`vkey-0.20.0-outer-count-8.bin` is the 1,888-byte key extracted from
[the matching generated OuterCount8 verifier](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount8.sol).
It has header words `(23,21,5)`, followed by the same 28-point BB5 entity order
used by the Count5/6/7 keys. Its SHA-256 is
`ea404004fe0079926ca2e40afbaf5479aff18ed1b18700eda5fa6060bedd26d0`.
Its reduced Keccak hash is
`0x03dbb84b656cdf3b9f93d809c530b4c3901fe5be6f56c424a04ae827ebe45a08`,
also independently present in the published 0.20.0 manifest. The extraction
procedure reproduced both existing Count6 and Count7 key files byte for byte
before extracting Count8.

The Count7 and Count8 reference Solidity source is identical after removing
`loadVk()` and the `VK_HASH`, `NUMBER_PUBLIC_INPUTS` and
`REAL_NUMBER_PUBLIC_INPUTS` declarations. Both use 23 sumcheck rounds and
10,240-byte proofs. This is evidence for format compatibility, not a positive
Count8 proof test. No positive Count8 proof is bundled. A fresh synthetic phone
capture must still pass native, compiled-Wasm and Testnet verification before
the new profile can be claimed to work end to end.
