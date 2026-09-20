#[cfg(any(feature = "count6", feature = "count7", feature = "count8"))]
use soroban_sdk::Bytes;
use soroban_sdk::{testutils::Ledger, Address, BytesN, Env};
#[cfg(not(feature = "wasm-tests"))]
use zkpassport_verifier::PassportVerifier;
use zkpassport_verifier::PassportVerifierClient;
#[cfg(any(feature = "count6", feature = "count7", feature = "count8"))]
use zkpassport_verifier::VerificationError;

fn register(env: &Env) -> Address {
    #[cfg(feature = "wasm-tests")]
    {
        let path = std::env::var("PASSPORT_WASM").expect("set PASSPORT_WASM to the selected build");
        let wasm = std::fs::read(path).expect("read selected release Wasm");
        env.register(wasm.as_slice(), ())
    }
    #[cfg(not(feature = "wasm-tests"))]
    env.register(PassportVerifier, ())
}

#[test]
fn deployed_interface_reports_the_immutable_key_profile() {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    let id = register(&env);
    let client = PassportVerifierClient::new(&env, &id);
    let profile = client.profile();
    let (hash, inputs, proof_bytes, log_n) = if cfg!(feature = "count6") {
        (
            "25de0e8ba3d6b6346c1ef7530adfb51a653f91a330a177ce734b1ec5121074a6",
            11,
            10240,
            23,
        )
    } else if cfg!(feature = "count7") {
        (
            "00fe2b15b91a3c7c3ede7f84a0751e29373bfbf2da0ab7392e2cfa564eab8ab7",
            12,
            10240,
            23,
        )
    } else if cfg!(feature = "count8") {
        (
            "03dbb84b656cdf3b9f93d809c530b4c3901fe5be6f56c424a04ae827ebe45a08",
            13,
            10240,
            23,
        )
    } else {
        (
            "013d18b35786455360821b6dbcb40174603cac5893781f0fc1601af4eacb01eb",
            10,
            9888,
            22,
        )
    };
    let mut expected = [0; 32];
    for (i, byte) in expected.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hash[i * 2..i * 2 + 2], 16).unwrap();
    }
    assert_eq!(profile.vk_hash, BytesN::from_array(&env, &expected));
    assert_eq!(profile.external_inputs, inputs);
    assert_eq!(profile.proof_bytes, proof_bytes);
    assert_eq!(profile.log_n, log_n);
}

#[cfg(any(feature = "count6", feature = "count7", feature = "count8"))]
#[test]
fn an_extended_profile_rejects_the_valid_age_only_fixture() {
    let env = Env::default();
    env.ledger().set_protocol_version(26);
    env.cost_estimate().budget().reset_unlimited();
    let id = register(&env);
    let client = PassportVerifierClient::new(&env, &id);
    let proof = Bytes::from_slice(&env, include_bytes!("../fixtures/proof.bin"));
    let inputs = Bytes::from_slice(&env, include_bytes!("../fixtures/public_inputs.bin"));
    assert_eq!(
        client.try_verify(&proof, &inputs),
        Err(Ok(VerificationError::InvalidProof))
    );
}
