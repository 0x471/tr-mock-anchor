# ZKPassport BB5 verifier for Soroban

Experimental, **unaudited** native-host-accelerated verifier for compile-time pinned ZKPassport proof profiles. The implementation verifies the complete mathematical proof; it does **not** authorize an anchor payout or establish application eligibility by itself.

## Default profile

- ZKPassport circuit package **0.20.0**, BB5 UltraKeccak non-ZK _outer_ proof, `OuterCount5`.
- Fixed circuit parameters: `log_n = 22`, 18 total public inputs, 10 externally supplied inputs, offset 5.
- Proof: 9,888 bytes. External public inputs: 320 bytes. Embedded verification key: 1,888 bytes.
- Verification-key hash, **Keccak(key bytes) reduced modulo Fr**:
  `0x013d18b35786455360821b6dbcb40174603cac5893781f0fc1601af4eacb01eb`.
- Reference: [official generated Solidity verifier at `d3a75acb8529e82c61be136a402553daec259257`](https://github.com/zkpassport/circuits/blob/d3a75acb8529e82c61be136a402553daec259257/src/solidity/src/ultra-honk-verifiers/OuterCount5.sol).

`PassportVerifier::verify(proof, public_inputs)` uses the embedded key; callers cannot supply a replacement key. It returns `true` only after successful verification, or a contract error. It stores no eligibility, identity, or replay state.

## Extended predicate profiles

Build with exactly one of `--features count6`, `--features count7` or
`--features count8` to select the corresponding official 0.20.0 outer circuit.
Selecting more than one fails compilation.
There is no runtime key or profile selection. `profile()` returns the actual
embedded key hash, external-input count, proof size and round count.

| Build   | Outer circuit | External inputs | Proof bytes | Rounds |
| ------- | ------------- | --------------- | ----------- | ------ |
| Default | OuterCount5   | 10              | 9888        | 22     |
| count6  | OuterCount6   | 11              | 10240       | 23     |
| count7  | OuterCount7   | 12              | 10240       | 23     |
| count8  | OuterCount8   | 13              | 10240       | 23     |

One private country predicate added to age+binding requires count6; nationality
and document-issuer predicates together require count7. Exact keys, commitments,
source pins and binary hashes are recorded in
[the country profile specification](../../docs/COUNTRY_PROOF_PROFILE.md).

Age, binding, nationality inclusion, issuer inclusion and sanctions exclusion
together require Count8. It adds one committed predicate, not a larger
unverified disclosure blob. The Count8 key is independently pinned to the
official generated verifier and published circuit manifest; see
[fixture provenance](fixtures/PROVENANCE.md). Native profile and compiled-Wasm
profile tests check the exact key hash and reject the incompatible historical
age-only proof. These checks are not a positive Count8 proof-verification test.

The country builds pass native arithmetic/decoder tests, compiled-Wasm metadata
checks and rejection of the age-only fixture. Those checks do **not** establish
positive country-proof compatibility. A fresh matching phone proof must pass the
complete native, compiled-Wasm and Testnet paths before claiming that profile
verified end to end. The historical transaction below used the default profile.

The bundled positive fixture is an **official historical synthetic-document proof dated 14 July 2026**. It is a cryptographic compatibility test, not a fresh identity check, current phone-app proof, or production KYC evidence. A non-ZK final outer proof does not imply that its recursively verified inner witnesses are public.

## What is checked

The decoder requires exact lengths and canonical scalar/base-field encodings. It checks every ordinary proof point (31 in the default profile, 32 in an extended profile), all 28 key points, and both reconstructed recursive points before MSM coefficient filtering. Recursive coordinates use low-136/high-120 limbs; default/infinite recursive accumulators are rejected for these deliberately narrow formats.

Verification includes the BB5 transcript, all 29 relations, the selected profile's sumcheck rounds, and Gemini/Shplonk opening reduction. **Both pairing equations must pass:**

1. The outer proof's KZG opening equation.
2. The deferred recursive accumulator equation, whose eight limbs are bound into the same outer proof transcript/public-input calculation.

These are separate mandatory checks; this implementation does not simply ignore the accumulator or treat outer-proof acceptance as sufficient. The official Solidity verifier combines the obligations through randomized aggregation; this implementation checks each equation independently.

## Reproduce locally

Run from this crate's directory. Tested toolchain: `rustc 1.98.0-nightly (f28ac764c 2026-06-23)`, with the `wasm32v1-none` target installed. Soroban SDK is pinned to **26.0.1**. Retain `Cargo.lock`: it pins `ed25519-dalek` to **2.2.0** because resolving 3.0 introduced an incompatible host dependency combination.

```sh
cargo test --locked --features std
cargo build --locked --release --target wasm32v1-none
```

Execute the compiled Wasm in the local Soroban test host:

```sh
PASSPORT_WASM=/Users/peterpan/rd/trionlabs/stellar-anchor-shopier/anchor/contracts/zkpassport-verifier/target/wasm32v1-none/release/zkpassport_verifier.wasm \
cargo test --locked --features wasm-tests
```

If `CARGO_TARGET_DIR` is set, replace `PASSPORT_WASM` with the absolute path to the artifact actually built there. The Wasm test feature requires this variable; it must not silently substitute native Rust execution.

The optional read-only RPC check requires Node.js, Stellar CLI, and an existing public Testnet source account:

```sh
node scripts/check-testnet.mjs \
  --contract CB2R3TF45CASFOJS7KHFDWOYKDVBHOYBRSIQLSPLE4SDXXT75WUOM7JI \
  --source GAZOT6YMKME6R7DYCLPUOI22IEQGCO5LX3ZJ24GOZ3NVPNPDIJQXCKKR
```

These are public testnet identifiers. The script uses `--send no`: it simulates the positive fixture and three mutations without signing or submitting. Negative cases must return explicit `InvalidProof` contract errors; an RPC/network failure does not count as proof rejection.

## Validation recorded on 20 September 2026

- 20 unit tests passed, including an independent recursive-equation check.
- The 35-case fixture/adversarial suite passed against native execution and again against compiled Wasm. Cases include all ten changed public inputs, malformed lengths, noncanonical scalars/coordinates/limbs, off-curve points, on-curve commitment mutations, and accumulator mutations.
- 25 separate checks against the matching official Solidity reference passed in the surrounding validation workspace; that Solidity harness is not bundled in this crate.
- Invocation tests enforce **400 million CPU instructions and 40 MiB memory**; contract-registration setup has a separate unlimited test budget. Positive local Wasm execution measured approximately **116.5 million CPU instructions**. The read-only Protocol-28 Testnet settings snapshot at ledger **4,766,051** reported a **400 million** per-transaction instruction limit. Local measurement versus that snapshot is not a committed-chain benchmark or a guarantee that every complete application transaction fits.

These are finite tests, not a security audit.

## Confirmed Testnet verification

The historical default-profile deployment at commit `6c0bf92` used a 41,114-byte Wasm, SHA-256 `4fa267bfa781adddddd91ee1a89eebbab317f32979e7b00d86ad46da898e2656`. Adding the profile getter changes rebuilt Wasm; this hash does not describe the newer source or country builds.

- Contract: `CB2R3TF45CASFOJS7KHFDWOYKDVBHOYBRSIQLSPLE4SDXXT75WUOM7JI`.
- [Successful verification transaction](https://stellar.expert/explorer/testnet/tx/1565ddf72714fc9dcc37e97030bbc5ac850244a1580266090b978222f9967494), ledger **4,766,089**. Independently fetched receipt: `SUCCESS`, return value `bool: true`.
- Transaction declared **121,323,850** instructions; that is its allocated resource budget, not an exact consumed-instruction measurement. Fee charged: 132,267 stroops (0.0132267 test XLM).
- The same deployed contract rejected changed scope, on-curve negated KZG quotient, and both-negated recursive accumulator through RPC simulation with contract error `InvalidProof (#2)`. Negative transactions were not submitted.

The positive call was explicitly submitted with `--send yes`; it is not merely a simulation result. No mainnet activity or real assets were used. This confirms the pinned historical synthetic proof, not current-app compatibility or anchor eligibility.

## Application integration is still required

Before any anchor authorization, independently enforce trusted registry/document roots, supported circuit/version, age/policy semantics, domain/scope, buyer/order/network/contract binding, proof freshness, expiry, and single-use/replay rules. A mathematically valid historical proof must not become a reusable payout capability. Fiat receipt and asset-transfer conditions belong in the anchor contract's own state machine.

The port changes the upstream proof protocol and therefore does not inherit an upstream audit conclusion. Do not use with real customer funds or claim broad/current ZKPassport SDK compatibility without further fixtures, live-app checks, resource testing, and independent review.

See [NOTICE.md](NOTICE.md), [Nethermind MIT license](LICENSE-NETHERMIND), and [Apache-2.0 license](LICENSE-APACHE) for provenance and attribution.
