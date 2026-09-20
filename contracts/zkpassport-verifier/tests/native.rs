#![cfg(not(any(feature = "count6", feature = "count7", feature = "count8")))]
mod common;

#[test]
fn full_verifier_accepts_fixture_and_rejects_adversarial_inputs() {
    common::fixture_suite(None);
}
