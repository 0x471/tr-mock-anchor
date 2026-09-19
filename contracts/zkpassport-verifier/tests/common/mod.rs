use soroban_sdk::{
    testutils::{EnvTestConfig, Ledger},
    Bytes, Env,
};
use zkpassport_verifier::{PassportVerifier, PassportVerifierClient};

pub const PROOF: &[u8] = include_bytes!("../../fixtures/proof.bin");
pub const PUBLIC_INPUTS: &[u8] = include_bytes!("../../fixtures/public_inputs.bin");
const FQ: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];
const FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn check(wasm: Option<&[u8]>, name: &str, proof: &[u8], pi: &[u8], expected: bool) {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    let id = match wasm {
        Some(bytes) => env.register(bytes, ()),
        None => env.register(PassportVerifier, ()),
    };
    let client = PassportVerifierClient::new(&env, &id);
    let proof = Bytes::from_slice(&env, proof);
    let pi = Bytes::from_slice(&env, pi);
    // Current testnet compute configuration, read at ledger 4766051 (protocol28).
    // Registration above is test setup; enforce the cap for the invocation itself.
    env.cost_estimate()
        .budget()
        .reset_limits(400_000_000, 41_943_040);
    let result = client.try_verify(&proof, &pi);
    let accepted = matches!(result, Ok(Ok(true)));
    println!(
        "{name}: accepted={accepted}, CPU={}, memory={}, result={result:?}",
        env.cost_estimate().budget().cpu_instruction_cost(),
        env.cost_estimate().budget().memory_bytes_cost()
    );
    assert_eq!(accepted, expected, "{name}: {result:?}");
    if !expected {
        assert!(
            matches!(result, Err(Ok(_))),
            "unexpected host trap: {name}: {result:?}"
        );
    }
}

fn negate_y(y: &mut [u8]) {
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let value = FQ[i] as i16 - y[i] as i16 - borrow;
        y[i] = value.rem_euclid(256) as u8;
        borrow = i16::from(value < 0);
    }
}

pub fn fixture_suite(wasm: Option<&[u8]>) {
    check(
        wasm,
        "valid complete passport proof",
        PROOF,
        PUBLIC_INPUTS,
        true,
    );
    for word in 0..10 {
        let mut pi = PUBLIC_INPUTS.to_vec();
        pi[word * 32 + 31] ^= 1;
        check(
            wasm,
            &format!("changed public input {word}"),
            PROOF,
            &pi,
            false,
        );
    }
    check(
        wasm,
        "truncated public input",
        PROOF,
        &PUBLIC_INPUTS[..319],
        false,
    );
    let mut pi = PUBLIC_INPUTS.to_vec();
    pi.extend_from_slice(&[0; 32]);
    check(wasm, "extra public input", PROOF, &pi, false);
    pi = PUBLIC_INPUTS.to_vec();
    pi[..32].copy_from_slice(&FR);
    check(wasm, "public input equal to Fr modulus", PROOF, &pi, false);

    check(
        wasm,
        "truncated proof",
        &PROOF[..PROOF.len() - 1],
        PUBLIC_INPUTS,
        false,
    );
    let mut proof = PROOF.to_vec();
    proof.push(0);
    check(wasm, "trailing proof byte", &proof, PUBLIC_INPUTS, false);
    for offset in [768, 6368, 6400, 7680, 9056, 9728] {
        proof = PROOF.to_vec();
        proof[offset + 31] ^= 1;
        check(
            wasm,
            &format!("changed scalar at {offset}"),
            &proof,
            PUBLIC_INPUTS,
            false,
        );
    }
    proof = PROOF.to_vec();
    proof[768..800].copy_from_slice(&FR);
    check(
        wasm,
        "noncanonical sumcheck scalar",
        &proof,
        PUBLIC_INPUTS,
        false,
    );

    // Negating Y preserves curve membership; the final KZG point is not absorbed
    // into Fiat-Shamir, so its mutation specifically tests the opening equation.
    for offset in [256, 7712, 8992, 9760, 9824] {
        proof = PROOF.to_vec();
        negate_y(&mut proof[offset + 32..offset + 64]);
        check(
            wasm,
            &format!("on-curve negated commitment at {offset}"),
            &proof,
            PUBLIC_INPUTS,
            false,
        );
    }

    proof = PROOF.to_vec();
    proof[256..320].fill(0);
    proof[287] = 1;
    proof[319] = 1;
    check(
        wasm,
        "off-curve commitment (1,1)",
        &proof,
        PUBLIC_INPUTS,
        false,
    );
    proof[256..288].copy_from_slice(&FQ);
    check(
        wasm,
        "commitment coordinate equal to Fq",
        &proof,
        PUBLIC_INPUTS,
        false,
    );

    proof = PROOF.to_vec();
    proof[0] = 1;
    check(
        wasm,
        "oversized recursive low limb",
        &proof,
        PUBLIC_INPUTS,
        false,
    );
    proof = PROOF.to_vec();
    proof[32] = 1;
    check(
        wasm,
        "oversized recursive high limb",
        &proof,
        PUBLIC_INPUTS,
        false,
    );
    proof = PROOF.to_vec();
    proof[..256].fill(0);
    check(
        wasm,
        "zero recursive accumulator",
        &proof,
        PUBLIC_INPUTS,
        false,
    );

    // Negating both accumulator points preserves their pairing equation, but
    // must fail the outer proof because its public inputs bind the original limbs.
    proof = PROOF.to_vec();
    for offset in [0, 128] {
        let mut y = [0; 32];
        y[..15].copy_from_slice(&proof[offset + 113..offset + 128]);
        y[15..].copy_from_slice(&proof[offset + 79..offset + 96]);
        negate_y(&mut y);
        proof[offset + 79..offset + 96].copy_from_slice(&y[15..]);
        proof[offset + 113..offset + 128].copy_from_slice(&y[..15]);
        check(
            wasm,
            &format!("negated accumulator through point {offset}"),
            &proof,
            PUBLIC_INPUTS,
            false,
        );
    }
}
