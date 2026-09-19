# Anchor gate and vault

Unaudited Testnet-only native-proof policy gate for simulated TRY deposits.
See [the design and exact ABI](../../docs/GATE_VAULT_DESIGN.md). Four mutators:
`create_order`, `prove_order`, `record_receipt`, `settle`. Immutable constructor
configuration, typed age/country predicates, real SAC reservations, distinct
provider/recipient/mock-bank authorization, and no withdrawal/upgrade bypass.

This is not a backend-attested proof gate. `prove_order` invokes the pinned native
verifier contract, checks its Wasm hash and VK/profile, and checks the exact
order-bound commitments and roots. Synthetic document nullifier type 2 is the
only accepted type. The bank notary establishes simulated receipt, not real fiat.

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
Both native-gate and gate-Wasm runs passed the 17 policy/state tests on
20 September 2026. These tests call a real Stellar Asset Contract but deliberately
use an external fake verifier: they test the gate's handling of its verifier,
not mathematical proof acceptance. Country commitments are independent official
SDK known-answer vectors, and the XDR policy/challenge literals were independently
constructed with the JavaScript Stellar SDK.

Covered behavior includes exact reservation and idempotency; missing role auth;
native-verifier rejection; altered policy, binding, length, timestamp and
nullifier fields; country profile shape; duplicate/foreign receipt rejection;
late-funded reservation retention; exact single settlement; and rollback when
the recipient trustline cannot receive tokens.

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
Testnet reservations, including a late-funded order. Do not use real funds.
