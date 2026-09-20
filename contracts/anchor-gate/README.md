# Anchor gate and vault

Unaudited Testnet-only native-proof policy gate for simulated TRY deposits and
withdrawals. See [the design and exact ABI](../../docs/GATE_VAULT_DESIGN.md).
Five mutators: `create_order`, `prove_order`, `authorize_payout`, `record_receipt`,
`settle`. Immutable constructor
configuration, typed age/country predicates, real SAC reservations, distinct
provider/recipient/mock-bank authorization, and no administrative drain or
upgrade bypass.

This is not a backend-attested proof gate. `prove_order` invokes the pinned native
verifier contract, checks its Wasm hash and VK/profile, and checks the exact
order-bound commitments and roots. Synthetic document nullifier type 2 is the
only accepted type. The bank notary establishes simulated receipt, not real fiat.

Deposits reserve provider tokens when created. Withdrawals escrow the recipient's
tokens only after an accepted proof and recipient authorization; proof refresh
does not debit again. A current eligible withdrawal needs a separate notary
authorization before simulated bank payout. That immutable authorization records
one specific obligation: its exact payout receipt and token settlement can be
reconciled after proof, policy or order expiry. It does not authorize another
payout. The mock-bank adapter must durably deduplicate that bank action by order.

## Optional private sanctions predicate

New deployments accept `sanctions_root: BytesN<32>` and
`sanctions_strict: bool`. An all-zero root with `false` disables this predicate;
a nonzero canonical BN254 scalar root enables it. Zero with `true` and roots
at or above the field modulus are rejected. These additional fields change
the constructor ABI and policy hash. Existing deployed vaults and their orders
are not upgraded or reinterpreted.

The gate requires the exact SHA-256/31-byte commitment to the 36-byte record
`[9,0,33] || root32 || strict_byte` alongside all existing policy and binding
commitments. Root and strictness are part of the immutable policy hash and
therefore the order challenge. The enabled predicate adds one external input;
age, binding and both country inclusions together need the Count8 verifier's
13 external inputs. The vault still checks the exact verifier Wasm, key and
profile. Omitting the sanctions predicate or using another root or a weaker
mode cannot create eligibility or debit withdrawal tokens.

This proves non-inclusion against a configured snapshot, not freshness of the
source list, direct verification of another chain's registry state, or a full
sanctions clearance. The policy expires within 24 hours, but that does not make
an old dataset current. See [dataset provenance and limitations](../../docs/ZKPASSPORT_SANCTIONS_RESEARCH.md).
The existing wallet-address precheck covers a different identifier and remains
a separate backend control. A fresh positive Count8 phone proof has not been
validated by the gate's policy tests; the fake external verifier is not evidence
of cryptographic sanctions exclusion.

## Local verification

Tested with Rust 1.98.0-nightly (f28ac764c 2026-06-23), SDK 26.0.1 and this lockfile.
The lockfile retains ed25519-dalek 2.2.0 for SDK host compatibility.

```sh
cargo test --locked --features std
cargo build --locked --release --target wasm32v1-none
ANCHOR_GATE_WASM=/absolute/path/to/anchor_gate.wasm cargo test --locked --features std
cargo fmt --all --check
```

Use task-local CARGO_HOME/CARGO_TARGET_DIR when reusing the existing isolated
toolchain cache. The Wasm path is explicit; a missing file fails the test run.
Both native-gate and gate-Wasm runs passed the 31 policy/state tests on
20 September 2026. These tests call a real Stellar Asset Contract but deliberately
use an external fake verifier: they test the gate's handling of its verifier,
not mathematical proof acceptance. Country commitments are independent official
SDK known-answer vectors, and the XDR policy/challenge literals were independently
constructed with the JavaScript Stellar SDK.

Covered behavior includes exact reservation and idempotency; missing role auth;
native-verifier rejection; altered policy, binding, length, timestamp and
nullifier fields; country profile shape; duplicate/foreign receipt rejection;
late-funded reservation retention; exact single settlement; and rollback when
the recipient trustline cannot receive tokens. Withdrawal tests also cover exact
recipient token-transfer authorization, no debit on rejected proof, no double
escrow, current eligibility at payout authorization, immutable authorization time,
late reconciliation, and receipt replay across deposit and withdrawal orders.

Required before claiming a complete onchain anchor demonstration:

- Approved immutable policy, authenticated roots, exact Testnet asset/profile.
- Gate Wasm + actual pinned native verifier Wasm with a fresh matching phone
  proof, including wrong-country/age/order controls.
- Real recipient authorization, transaction inclusion/reconciliation and bounded
  network resource checks; HTTP callbacks/simulations are not confirmations.
- Archival/restore replay tests and explicit maintenance of the verifier and
  SAC vault balance storage.

No deployment, phone proof acceptance, or Testnet settlement is claimed by this
crate's policy/state test results. There is intentionally no cancellation or
refund path in this first version: unresolved/expired orders may strand capped
Testnet reservations, including late-funded deposits and customer escrow that
expires before payout authorization. Do not use real funds.
