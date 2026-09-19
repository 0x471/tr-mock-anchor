#![cfg(feature = "std")]

use soroban_sdk::{
    testutils::{EnvTestConfig, Ledger},
    Bytes, BytesN, Env,
};
use std::io::Read;
use zkpassport_verifier::{PassportVerifier, PassportVerifierClient, VerificationError};

const CPU_LIMIT: u64 = 400_000_000;
const MEMORY_LIMIT: u64 = 40 * 1024 * 1024;
const FQ: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];
const FR: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

fn selected_profile() -> (&'static str, usize, usize, u32) {
    if cfg!(feature = "count6") {
        (
            "25de0e8ba3d6b6346c1ef7530adfb51a653f91a330a177ce734b1ec5121074a6",
            10240,
            11,
            23,
        )
    } else if cfg!(feature = "count7") {
        (
            "00fe2b15b91a3c7c3ede7f84a0751e29373bfbf2da0ab7392e2cfa564eab8ab7",
            10240,
            12,
            23,
        )
    } else {
        (
            "013d18b35786455360821b6dbcb40174603cac5893781f0fc1601af4eacb01eb",
            9888,
            10,
            22,
        )
    }
}

fn bounded_file(variable: &str, limit: usize) -> Vec<u8> {
    let path = std::env::var(variable).expect("explicit binary input path required");
    let file = std::fs::File::open(path).expect("cannot open explicitly selected binary input");
    let mut value = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut value)
        .expect("cannot read selected binary input");
    assert!(
        value.len() <= limit,
        "selected binary input exceeds size limit"
    );
    value
}

fn check(wasm: Option<&[u8]>, proof: &[u8], inputs: &[u8], positive: bool, case: &str) {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    let id = match wasm {
        Some(wasm) => env.register(wasm, ()),
        None => env.register(PassportVerifier, ()),
    };
    let client = PassportVerifierClient::new(&env, &id);
    let (vk, proof_bytes, input_count, log_n) = selected_profile();
    let mut hash = [0; 32];
    for (i, byte) in hash.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&vk[i * 2..i * 2 + 2], 16).unwrap();
    }
    let profile = client.try_profile();
    assert!(matches!(profile, Ok(Ok(_))), "profile invocation failed");
    let profile = profile.unwrap().unwrap();
    assert!(
        profile.vk_hash == BytesN::from_array(&env, &hash)
            && profile.proof_bytes == proof_bytes as u32
            && profile.external_inputs == input_count as u32
            && profile.log_n == log_n,
        "selected native/Wasm profile mismatch"
    );
    let proof = Bytes::from_slice(&env, proof);
    let inputs = Bytes::from_slice(&env, inputs);
    // Setup/profile work is not the invocation under test. Each call gets a fresh cap.
    env.cost_estimate()
        .budget()
        .reset_limits(CPU_LIMIT, MEMORY_LIMIT);
    let result = client.try_verify(&proof, &inputs);
    if positive {
        assert!(
            matches!(result, Ok(Ok(true))),
            "positive capture rejected: {case}"
        );
    } else {
        assert!(
            matches!(result, Err(Ok(VerificationError::InvalidProof))),
            "negative case did not return explicit InvalidProof: {case}"
        );
    }
    assert!(env.cost_estimate().budget().cpu_instruction_cost() <= CPU_LIMIT);
    assert!(env.cost_estimate().budget().memory_bytes_cost() <= MEMORY_LIMIT);
}

// Opt in with explicit binary inputs; this never searches for phone exports.
// cargo test --locked --features std[,count6|count7] --test capture -- --ignored
// PASSPORT_WASM is optional and must be the matching compiled profile.
// No raw proof, public inputs, document metadata, or snapshots are emitted.
#[test]
#[ignore = "requires explicit PASSPORT_PROOF and PASSPORT_INPUTS binary paths"]
fn selected_capture_accepts_and_rejects_mutations() {
    let (_, proof_bytes, input_count, _) = selected_profile();
    let proof = bounded_file("PASSPORT_PROOF", proof_bytes);
    let inputs = bounded_file("PASSPORT_INPUTS", input_count * 32);
    assert!(
        proof.len() == proof_bytes && inputs.len() == input_count * 32,
        "capture lengths do not match selected profile"
    );
    let wasm =
        std::env::var_os("PASSPORT_WASM").map(|_| bounded_file("PASSPORT_WASM", 2 * 1024 * 1024));
    check(wasm.as_deref(), &proof, &inputs, true, "unmodified capture");
    for index in 0..input_count {
        let mut changed = inputs.clone();
        let field = &mut changed[index * 32..(index + 1) * 32];
        assert!(
            &*field < FR.as_slice(),
            "capture contains a noncanonical public input"
        );
        for byte in field.iter_mut().rev() {
            let (incremented, carry) = byte.overflowing_add(1);
            *byte = incremented;
            if !carry {
                break;
            }
        }
        if field == FR {
            field.fill(0);
        }
        check(
            wasm.as_deref(),
            &proof,
            &changed,
            false,
            "changed public input",
        );
    }
    check(
        wasm.as_deref(),
        &proof[..proof.len() - 1],
        &inputs,
        false,
        "truncated proof",
    );
    check(
        wasm.as_deref(),
        &proof,
        &inputs[..inputs.len() - 1],
        false,
        "truncated inputs",
    );
    let mut extra = proof.clone();
    extra.push(0);
    check(
        wasm.as_deref(),
        &extra,
        &inputs,
        false,
        "trailing proof byte",
    );
    let mut extra = inputs.clone();
    extra.extend_from_slice(&[0; 32]);
    check(wasm.as_deref(), &proof, &extra, false, "extra public input");

    // Final KZG Y negation preserves curve membership and tests the opening equation.
    let mut negated = proof.clone();
    let start = negated.len() - 32;
    let y = &mut negated[start..];
    assert!(
        y.iter().any(|b| *b != 0) && &*y < FQ.as_slice(),
        "capture cannot exercise canonical nonzero KZG negation"
    );
    let mut borrow = 0i16;
    for index in (0..32).rev() {
        let difference = FQ[index] as i16 - y[index] as i16 - borrow;
        y[index] = difference.rem_euclid(256) as u8;
        borrow = i16::from(difference < 0);
    }
    check(
        wasm.as_deref(),
        &negated,
        &inputs,
        false,
        "on-curve KZG negation",
    );
}
