#![cfg(feature = "wasm-tests")]
mod common;

#[test]
fn compiled_wasm_accepts_fixture_and_rejects_adversarial_inputs() {
    let path = std::env::var("PASSPORT_WASM").expect("set PASSPORT_WASM to the release Wasm");
    let wasm = std::fs::read(path).expect("read release Wasm");
    common::fixture_suite(Some(&wasm));
}
