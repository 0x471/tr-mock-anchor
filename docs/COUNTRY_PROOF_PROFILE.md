# Country proof profiles: ZKPassport 0.20.0

Checked 20 September 2026, Europe/Istanbul. This is a source and public-artifact investigation, not a claim that an Outer6 or Outer7 phone proof has passed Soroban. No phone request, proof generation, relay session, or chain transaction was made for this investigation.

## Decision

For the existing private age predicate plus order binding, adding one private country inclusion/exclusion predicate selects `outer_evm_count_6`. Adding separate nationality and issuing-country predicates selects `outer_evm_count_7`. Both require a different pinned verification key and `LOG_N=23`; the working Outer5 profile uses `LOG_N=22`. A correct fixed-profile extension must change the decoder, transcript dimensions, input counts, and key together, not just admit extra public inputs.

The initial policy selected on 20 September was age 18+ with inclusion lists
`["TUR"]` for both nationality and document issuer. The tester subsequently
approved a separate `["ZKR"]`/`["ZKR"]`/18+ synthetic demo because the stock
mock documents use the fictional Zero Knowledge Republic. The original TUR
deployment remains unchanged. Both policies use Outer7; the new policy does not
demonstrate Turkish eligibility. See [fixture setup](SYNTHETIC_DOCUMENT_SETUP.md).
Nationality and document-issuing country are different document
fields; neither is residence, location, bank jurisdiction, or a complete
regulatory eligibility policy. [Mobile circuit selection][mobile-matcher],
[document-field constants][constants]

The pinned age circuit also calls `check_expiry` before the age comparison. Its
expiry library checks that the proof's current date precedes the parsed MRZ
expiry date, using its documented short-year interpretation. Thus no extra
expiry predicate is required to prove the document was unexpired at the proof
date. This does not disclose the expiry date or prove validity at every later
settlement time; the gate separately limits proof age.
[Age circuit](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/bin/compare/age/evm/src/main.nr),
[expiry check](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/lib/data-check/expiry/src/lib.nr)

## Source and version pins

- Mobile source: `zkpassport/mobile-app@c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e`.
- Matching official circuits and generated Solidity: `zkpassport/circuits@d3a75acb8529e82c61be136a402553daec259257`.
- Installed request SDK: `@zkpassport/sdk@0.17.1`; installed helper package: `@zkpassport/utils@0.38.0`. Helper source was read from the installed package's `dist/cjs/index.cjs.map`, including `src/circuit-matcher.ts` and `src/circuits/country.ts`.
- Published artifacts checked below identify Barretenberg `5.0.0` and Noir `1.0.0-beta.22+c57152f91260ecdb9faad4efc20abb14b6d2ece7`.

The SDK package version is not the circuit version. The phone selects circuits from its manifest. An actual response must be checked against the exact allowed circuit name, verification-key hash, lengths, and public-input interpretation. A manifest's version label alone is not a key pin. [SDK package][sdk-package], [utils package][utils-package], [mobile outer service][mobile-outer]

## Query-to-profile mapping

Assumptions: compressed-EVM proof mode, one age comparison, one `bind` request, no additional expiry, birthdate, sanctions, or face-match proof. These are source-derived selections, not newly generated fixtures.

| Requested predicates                                           | Disclosure subproofs | Selected outer |
| -------------------------------------------------------------- | -------------------: | -------------- |
| Age + bind                                                     |                    2 | Outer5         |
| Age + bind + nationality `.in` or `.out`                       |                    3 | Outer6         |
| Age + bind + issuing-country `.in` or `.out`                   |                    3 | Outer6         |
| Age + bind + nationality predicate + issuing-country predicate |                    4 | Outer7         |
| Age + bind + country `.eq` or `.disclose`                      |                    3 | Outer6         |
| Age + bind + both country fields using `.eq`/`.disclose` only  |                    3 | Outer6         |

The last row works because the mobile matcher groups non-age equality/disclosure fields into one `disclose_bytes_evm` circuit. This is a different policy representation: selected MRZ bytes and their mask are committed, not a private set-membership predicate. Age stays in `compare_age_evm`; bind remains separate. There is no established privacy-preserving way to fit age, a country-membership predicate, and binding into the existing two disclosure slots. Disclosing date of birth to save a slot is not an equivalent privacy-preserving substitute and is not recommended here. [Mobile matcher, `getDisclosureCircuits` and `getOuterCircuit`][mobile-matcher]

Combining `.in` and `.out` for one attribute creates separate circuits; combining equality with membership can also add another circuit. Do not determine the profile merely by counting field names. The outer count includes three base proofs plus the actual disclosure-proof count. The mobile service selects the outer only after those disclosure proofs exist. [Disclosure service][mobile-disclosure], [outer service][mobile-outer]

## Exact binary and public-input layout

| Property                                 |    Outer5 |    Outer6 |    Outer7 |
| ---------------------------------------- | --------: | --------: | --------: |
| Circuit size                             | 4,194,304 | 8,388,608 | 8,388,608 |
| `LOG_N`                                  |        22 |        23 |        23 |
| Binary VK header: log, total PIs, offset |   22,18,5 |   23,19,5 |   23,20,5 |
| External public-input fields             |        10 |        11 |        12 |
| External public-input bytes              |       320 |       352 |       384 |
| Proof-only bytes                         |     9,888 |    10,240 |    10,240 |
| SDK combined PI-prefix + proof bytes     |    10,208 |    10,592 |    10,624 |
| Binary verification-key bytes            |     1,888 |     1,888 |     1,888 |

All three use 29 subrelations, 8 coefficients per sumcheck univariate, 41 entity evaluations, 36 unshifted entities, 5 shifted entities, and 8 deferred-pairing accumulator limbs. The 8 accumulator limbs are at the beginning of the proof payload, not additional externally supplied PIs. The native binary VK is three 32-byte big-endian header words followed by 28 affine G1 points. It is not the 115-field recursive Noir verification-key representation. [Outer5 Solidity][sol5], [Outer6 Solidity][sol6], [Outer7 Solidity][sol7]

Proof-only layout, in order:

1. Eight 32-byte deferred-pairing limbs.
2. Eight 64-byte witness commitments.
3. `LOG_N * 8` 32-byte sumcheck coefficients.
4. Forty-one 32-byte entity evaluations.
5. `LOG_N - 1` 64-byte Gemini fold commitments.
6. `LOG_N` 32-byte Gemini evaluations.
7. Two 64-byte points: Shplonk Q and KZG quotient.

Therefore `proof_bytes = (8 + 16 + LOG_N*8 + 41 + (LOG_N-1)*2 + LOG_N + 4)*32`. Keep the SDK's external-PI prefix separate; padding an Outer5 proof is not an Outer6 proof. The official verifier checks exact lengths and binds the selected VK hash, external PIs, and accumulator into the transcript. [Outer6 verifier, input-length checks and challenge generation][sol6]

External PI indexes are:

| Index             | Outer6                               | Outer7                           |
| ----------------- | ------------------------------------ | -------------------------------- |
| 0                 | Certificate registry root            | Certificate registry root        |
| 1                 | Circuit registry root                | Circuit registry root            |
| 2                 | Current date, Unix timestamp (`u64`) | Same                             |
| 3                 | Service scope                        | Same                             |
| 4                 | Service subscope                     | Same                             |
| 5 onward          | Three parameter commitments: 5..7    | Four parameter commitments: 5..8 |
| After commitments | 8: nullifier type                    | 9: nullifier type                |
| Next              | 9: scoped nullifier                  | 10: scoped nullifier             |
| Last              | 10: OPRF public-key hash             | 11: OPRF public-key hash         |

Commitment positions follow the generated disclosure-proof order; the count alone does not mean "the country is always at index 6." Require exactly the intended typed commitments, with a deliberate order or an exact one-to-one multiset match that rejects missing/duplicate predicates. Do not trust unverified result metadata to declare which policy was proved. [Outer6 Noir main][noir6], [Outer7 Noir main][noir7], [mobile matcher][mobile-matcher]

## Country commitment encoding

For the compressed-EVM inclusion/exclusion circuits:

```text
country_payload = ordered 3-byte country codes, right-padded with zeros to 600 bytes
record = type:u8 || 0x02 || 0x58 || country_payload
commitment = first 31 bytes of SHA256(record), interpreted big-endian
external field encoding = 0x00 || commitment
```

Types are 4 nationality inclusion, 5 nationality exclusion, 6 issuing-country inclusion, and 7 issuing-country exclusion. The record is exactly 603 bytes and commits to 200 padded slots, not merely the number of nonempty countries. Inclusion preserves query-list order. Exclusion sorts by the three-byte big-endian integer and the circuit enforces strictly increasing nonzero entries before trailing zeros. For uppercase ASCII three-letter codes this is ordinary bytewise lexicographic order. A nonempty, deduplicated, bounded list with validated three-byte codes should be fixed by policy and shared identically by request builder and gate. Do not substitute alpha-2 codes or silently reorder inclusion inputs after proof generation. [Constants][constants], [inclusion commitment/checks][inclusion], [exclusion commitment/checks][exclusion], [utils 0.38.0][utils-package]

With a multi-country inclusion list the credential's actual country need not be revealed, though the accepted list is public policy. A singleton list necessarily implies that country. Equality/disclosure uses type 0 with a 90-byte MRZ mask and 90-byte masked MRZ payload; it must not be interpreted as type 4 or 6. [Disclosure helper][utils-package], [mobile matcher][mobile-matcher]

An executed, local-only cross-check compared the installed utils commitment function against an independently constructed SHA256 record. All four matched. These are test vectors, not proposed policy countries:

| Type | Effective country order | 32-byte field                                                      |
| ---- | ----------------------- | ------------------------------------------------------------------ |
| 4    | `USA,GBR`               | `005ba3ccc58463c8bbfd459670db590ae3832a818c4f948309e7964b5c22c064` |
| 5    | `GBR,USA`               | `00423f5523a5e7b3326ae90f5fe9674512191df11b57bf119b090312418a5c9b` |
| 6    | `USA,GBR`               | `00af42808bb564bc9ea7d7e699ce1be5605d08941f3b748a5fc74a769402a6a4` |
| 7    | `GBR,USA`               | `003af395f068fa1f3f8dce608c8079e3db182c550fc60435d447c2a5caaacb76` |

## Published keys and reproducible checks

At `2026-09-19T22:39:16Z`, the official [versioned 0.20.0 manifest][manifest] returned HTTP 200 after redirect to [the published manifest artifact][manifest-artifact]. Its declared root was `0x1bcacb8abb52ef2834e4862b264e1209368ac8e006aa8512f6d62116e8657a46`; SHA256 of the decompressed JSON response was `79bf2cf7f45aa2cf70c6ac764520006d28789b81ac45b80d74d4b582c911289e`.

Use the manifest's exact `outer_evm_count_N` hash to retrieve its by-hash artifact, base64-decode the artifact's `vkey`, check its header/length, and compute `Keccak256(binary_vk) mod Fr`. Do not substitute a current branch's generated key or a stale fixture configuration's advertised hash. These versioned keys match the historical Solidity pin; that comparison, not a shared `0.20.0` label, establishes their identity.

| Profile | Published VK hash / Keccak mod Fr                                  | Binary SHA256                                                      |
| ------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| 5       | `013d18b35786455360821b6dbcb40174603cac5893781f0fc1601af4eacb01eb` | `73ff42e97f58d55be8b62648fdca101e3e71c587e96d8c1304e0f6fe8404a232` |
| 6       | `25de0e8ba3d6b6346c1ef7530adfb51a653f91a330a177ce734b1ec5121074a6` | `67f21bc614c980a80c3852a86cf9a6429fa0bfc0d657335242123bf8f4df8548` |
| 7       | `00fe2b15b91a3c7c3ede7f84a0751e29373bfbf2da0ab7392e2cfa564eab8ab7` | `504bef3a42f703e0e2a5f24752bf8e4af72b7db04c267ca1f0ba0fb38a264e82` |

The [Outer6 artifact][artifact6] and [Outer7 artifact][artifact7] were fetched again at `22:42:07Z`, HTTP 200, and their decoded public keys saved without changing the existing `vkey.bin`:

- `contracts/zkpassport-verifier/fixtures/vkey-0.20.0-outer-count-6.bin`
- `contracts/zkpassport-verifier/fixtures/vkey-0.20.0-outer-count-7.bin`

Independent executed comparison checked all 56 coordinate words of each binary against the pinned Solidity's corresponding key constants, plus the Keccak-mod-Fr hash. Both matched. This validates key identity, not proof acceptance. The successful fresh phone test already recorded elsewhere used Outer5; it does not validate Outer6/7.

A publicly downloadable manifest/root is not automatically an authorized current registry state. The gate must separately pin or authenticate acceptable certificate and circuit roots and apply its explicit mock-versus-real/nullifier policy. A native proof verifies mathematical consistency with its public roots; it does not choose which roots the anchor should trust. [Outer Noir registry checks][noir6]

## Extension and independent validation gates

Bounded separate compile profiles are appropriate: preserve default Outer5 and its positive regression fixture, and build Outer6/7 with their exact fixed keys and constants. Reject cross-profile proof/PI lengths, wrong keys, noncanonical fields, malformed points, and invalid recursive accumulator checks. No omitted relation or pairing check is justified by the added country predicate.

For each new supported profile, obtain an actual matching proof through an authorized test flow. First verify that same proof and external PIs using its exact pinned official Solidity verifier in a local EVM harness. Then require native Rust, compiled Wasm, and Testnet simulation to agree. Include wrong country commitment, attribute type, age bound, binding, root, timestamp, nullifier mode, truncated bytes, wrong key, and single-byte proof mutations. A fabricated or padded Outer5 payload can test rejection, never positive compatibility. Gate tests must reject mathematically valid proofs whose committed policy differs from the order's policy.

Runtime remains unmeasured for Outer6/7. Static analysis shows one additional sumcheck/Gemini round and larger PI/transcript work; the pairing-check structure and relation count remain the same. Doubling circuit capacity mainly concerns proving and does not establish a twofold native verification cost. Measure native/Wasm resources and a full gate-plus-verifier invocation before claiming the transaction fits Testnet limits. Outer6 and Outer7 have the same proof length and round count but different keys and one different PI count. [Outer6 Solidity][sol6], [Outer7 Solidity][sol7]

[mobile-matcher]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/lib/circuit-matcher.ts
[mobile-outer]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/services/ProofService/OuterProofService.ts
[mobile-disclosure]: https://github.com/zkpassport/mobile-app/blob/c52f5ef1c4c29ce3fd7e46c6dd25d172a1f1cb0e/src/services/ProofService/DisclosureProofService.ts
[constants]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/lib/utils/src/constants.nr
[inclusion]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/lib/inclusion-check/country/src/lib.nr
[exclusion]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/lib/exclusion-check/country/src/lib.nr
[noir6]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/bin/main/outer/count_6/src/main.nr
[noir7]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/noir/bin/main/outer/count_7/src/main.nr
[sol5]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount5.sol
[sol6]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount6.sol
[sol7]: https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount7.sol
[sdk-package]: https://www.npmjs.com/package/@zkpassport/sdk/v/0.17.1
[utils-package]: https://www.npmjs.com/package/@zkpassport/utils/v/0.38.0
[manifest]: https://circuits2.zkpassport.id/mainnet/by-version/0.20.0/manifest.json
[manifest-artifact]: https://circuits2.zkpassport.id/artifacts/manifests/manifest_1bcacb8abb52ef28.json
[artifact6]: https://circuits2.zkpassport.id/mainnet/by-hash/0x25de0e8ba3d6b6346c1ef7530adfb51a653f91a330a177ce734b1ec5121074a6.json
[artifact7]: https://circuits2.zkpassport.id/mainnet/by-hash/0x00fe2b15b91a3c7c3ede7f84a0751e29373bfbf2da0ab7392e2cfa564eab8ab7.json
