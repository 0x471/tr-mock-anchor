//! Keccak Fiat-Shamir transcript for the pinned BB5 ZKPassport outer format.
//!
//! Source: official OuterCount5/6/7/8.sol, d3a75acb8529e82c61be136a402553daec259257.
//! Each digest is reduced modulo Fr BEFORE splitting into two 127-bit challenges.
//! Ordinary points use raw x||y. Only recursive pairing points use scalar limbs.

use crate::{
    field::Fr,
    hash::hash32,
    types::{
        G1Point, Proof, RelationParameters, Transcript, CONST_PROOF_SIZE_LOG_N, NUMBER_OF_ALPHAS,
    },
    utils::validate_public_inputs,
};
use soroban_sdk::{Bytes, Env};

fn push_point(buffer: &mut Bytes, point: &G1Point) {
    buffer.extend_from_slice(&point.to_bytes());
}

fn hash_to_fr(buffer: &Bytes) -> Fr {
    // Bn254Fr construction reduces modulo the scalar modulus in pinned SDK26.
    Fr::from_array(buffer.env(), &hash32(buffer).to_array())
}

/// Split a canonical field value into low127 and high127, not 128-bit halves.
fn split_challenge(challenge: &Fr) -> (Fr, Fr) {
    let input = challenge.to_bytes();
    let env = challenge.0.env();
    let mut low = [0u8; 32];
    low[16..].copy_from_slice(&input[16..]);
    low[16] &= 0x7f;
    let mut top = [0u8; 16];
    top.copy_from_slice(&input[..16]);
    let high_value = (u128::from_be_bytes(top) << 1) | u128::from(input[16] >> 7);
    let mut high = [0u8; 32];
    high[16..].copy_from_slice(&high_value.to_be_bytes());
    (Fr::from_array(env, &low), Fr::from_array(env, &high))
}

fn with_previous(env: &Env, previous: &Fr) -> Bytes {
    Bytes::from_array(env, &previous.to_bytes())
}

/// Hash previous challenge followed by exactly the supplied ordered points.
fn points_challenge(env: &Env, previous: &Fr, points: &[&G1Point]) -> Fr {
    let mut data = with_previous(env, previous);
    for point in points {
        push_point(&mut data, point);
    }
    hash_to_fr(&data)
}

/// Build all challenges. The fixed key's hash authenticates the exact circuit.
/// Public input delta is filled separately by the verifier after this transcript.
pub fn generate_transcript(
    env: &Env,
    proof: &Proof,
    public_inputs: &Bytes,
    vk_hash: &Fr,
) -> Result<Transcript, &'static str> {
    validate_public_inputs(public_inputs)?;

    // eta preamble: VK_HASH, external inputs, 8 accumulator limbs, W1,W2,W3.
    let mut preamble = Bytes::from_array(env, &vk_hash.to_bytes());
    preamble.append(public_inputs);
    for limb in &proof.pairing_point_object {
        preamble.extend_from_slice(&limb.to_bytes());
    }
    for point in [&proof.w1, &proof.w2, &proof.w3] {
        push_point(&mut preamble, point);
    }
    let mut previous = hash_to_fr(&preamble);
    let eta = split_challenge(&previous).0;
    let eta_two = &eta * &eta;
    let eta_three = &eta_two * &eta;

    // beta/gamma share the low/high 127-bit halves of a single reduced digest.
    previous = points_challenge(
        env,
        &previous,
        &[
            &proof.lookup_read_counts,
            &proof.lookup_read_tags,
            &proof.w4,
        ],
    );
    let (beta, gamma) = split_challenge(&previous);
    let rel_params = RelationParameters {
        eta,
        eta_two,
        eta_three,
        beta,
        gamma,
        public_inputs_delta: Fr::zero(env),
    };

    // 29 relations: the first weight is 1; remaining weights are alpha^1..28.
    previous = points_challenge(env, &previous, &[&proof.lookup_inverses, &proof.z_perm]);
    let alpha = split_challenge(&previous).0;
    let mut alphas = Fr::zero_array::<NUMBER_OF_ALPHAS>(env);
    let mut power = alpha.clone();
    for value in &mut alphas {
        *value = power.clone();
        power = &power * &alpha;
    }

    // One transcript challenge, then powers by repeated squaring (not rehashing).
    previous = hash_to_fr(&with_previous(env, &previous));
    let mut gate_challenges = Fr::zero_array::<CONST_PROOF_SIZE_LOG_N>(env);
    let mut gate = split_challenge(&previous).0;
    for value in &mut gate_challenges {
        *value = gate.clone();
        gate = &gate * &gate;
    }

    // Exactly the selected profile's unpadded sumcheck rounds.
    let mut sumcheck_u_challenges = Fr::zero_array::<CONST_PROOF_SIZE_LOG_N>(env);
    for (round, value) in sumcheck_u_challenges.iter_mut().enumerate() {
        let mut data = with_previous(env, &previous);
        for coefficient in &proof.sumcheck_univariates[round] {
            data.extend_from_slice(&coefficient.to_bytes());
        }
        previous = hash_to_fr(&data);
        *value = split_challenge(&previous).0;
    }

    let mut data = with_previous(env, &previous);
    for evaluation in &proof.sumcheck_evaluations {
        data.extend_from_slice(&evaluation.to_bytes());
    }
    previous = hash_to_fr(&data);
    let rho = split_challenge(&previous).0;

    let mut data = with_previous(env, &previous);
    for point in &proof.gemini_fold_comms {
        push_point(&mut data, point);
    }
    previous = hash_to_fr(&data);
    let gemini_r = split_challenge(&previous).0;

    let mut data = with_previous(env, &previous);
    for evaluation in &proof.gemini_a_evaluations {
        data.extend_from_slice(&evaluation.to_bytes());
    }
    previous = hash_to_fr(&data);
    let shplonk_nu = split_challenge(&previous).0;

    previous = points_challenge(env, &previous, &[&proof.shplonk_q]);
    let shplonk_z = split_challenge(&previous).0;

    Ok(Transcript {
        rel_params,
        alphas,
        gate_challenges,
        sumcheck_u_challenges,
        rho,
        gemini_r,
        shplonk_nu,
        shplonk_z,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(any(feature = "count6", feature = "count7", feature = "count8")))]
    use crate::utils::{load_proof, load_vk_from_bytes};
    #[cfg(not(any(feature = "count6", feature = "count7", feature = "count8")))]
    use soroban_sdk::testutils::Ledger;

    fn scalar128(value: u128) -> [u8; 32] {
        let mut bytes = [0u8; 32];
        bytes[16..].copy_from_slice(&value.to_be_bytes());
        bytes
    }

    #[test]
    fn split_is_exactly_127_bits() {
        let env = Env::default();
        let mut bytes = [0u8; 32];
        bytes[16] = 0x80;
        bytes[31] = 7;
        let (lo, hi) = split_challenge(&Fr::from_array(&env, &bytes));
        assert_eq!(lo.to_bytes(), scalar128(7));
        assert_eq!(hi.to_bytes(), scalar128(1));
    }

    #[test]
    #[cfg(not(any(feature = "count6", feature = "count7", feature = "count8")))]
    fn published_fixture_transcript_matches_independent_rust_reference() {
        let env = Env::default();
        env.ledger().set_protocol_version(26);
        env.cost_estimate().budget().reset_unlimited();
        let proof = load_proof(
            &env,
            &Bytes::from_slice(&env, include_bytes!("../fixtures/proof.bin")),
        )
        .unwrap();
        let key = load_vk_from_bytes(
            &env,
            &Bytes::from_slice(&env, include_bytes!("../fixtures/vkey.bin")),
        )
        .unwrap();
        let inputs = Bytes::from_slice(&env, include_bytes!("../fixtures/public_inputs.bin"));
        let transcript = generate_transcript(&env, &proof, &inputs, &key.hash).unwrap();
        assert_eq!(
            transcript.rel_params.eta.to_bytes(),
            scalar128(144356265757035370627622617638029061638)
        );
        assert_eq!(
            transcript.rel_params.beta.to_bytes(),
            scalar128(115347093318500157128361988909294145099)
        );
        assert_eq!(
            transcript.rel_params.gamma.to_bytes(),
            scalar128(126855551437808845776599870759505535560)
        );
        assert_eq!(
            transcript.alphas[0].to_bytes(),
            scalar128(160685605354795342726139988021574865169)
        );
        assert_eq!(
            transcript.gate_challenges[0].to_bytes(),
            scalar128(122873716142685361410820821827549491021)
        );
        assert_eq!(
            transcript.rel_params.eta_two,
            &transcript.rel_params.eta * &transcript.rel_params.eta
        );
        assert_eq!(
            transcript.rel_params.eta_three,
            &transcript.rel_params.eta_two * &transcript.rel_params.eta
        );
        assert_eq!(
            transcript.alphas[1],
            &transcript.alphas[0] * &transcript.alphas[0]
        );
        assert_eq!(
            transcript.gate_challenges[1],
            &transcript.gate_challenges[0] * &transcript.gate_challenges[0]
        );
    }
}
