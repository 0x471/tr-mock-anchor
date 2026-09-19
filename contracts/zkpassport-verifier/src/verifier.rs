//! Top-level UltraHonk verifier orchestration.
//!
//! Implements the verifier flow that BB splits across `ultra_verifier.cpp`,
//! `oink_verifier.cpp`, and `decider_verifier.cpp`.  The Rust code inlines the
//! Oink and Decider steps into a single `verify` method.
//!
//! ZKPassport 0.20.0 BB5 reference:
//!   - `ultra_honk/ultra_verifier.cpp::UltraVerifier_::verify_proof`
//!   - `ultra_honk/oink_verifier.cpp::OinkVerifier::verify`
//!   - `ultra_honk/decider_verifier.cpp::DeciderVerifier_::verify`

use crate::{
    ec::pairing_check,
    field::Fr,
    shplemini::verify_shplemini,
    sumcheck::verify_sumcheck,
    transcript::generate_transcript,
    types::PAIRING_POINTS_SIZE,
    utils::{decode_pairing_points, load_proof, load_vk_from_bytes, validate_public_inputs},
};
use soroban_sdk::{Bytes, Env};

/// Error type describing why a verification key could not be loaded from bytes.
///
/// Intentionally minimal: the VK is public data, so callers do not need a
/// fine-grained oracle. The two variants separate deployer mistakes (wrong
/// byte count) from invalid structural parameters that could indicate
/// corruption or an adversarially crafted VK.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum VkLoadError {
    /// Byte slice length does not match the exact expected VK size (1888 bytes).
    WrongLength,
    /// Header parsed successfully but contains out-of-range values.
    InvalidParameters,
}

/// Error type describing the specific reason verification failed.
#[derive(Debug)]
pub enum VerifyError {
    InvalidInput,
    SumcheckFailed,
    ShplonkFailed,
    RecursiveFailed,
}

pub struct UltraHonkVerifier {
    env: Env,
    vk: crate::types::VerificationKey,
}

impl UltraHonkVerifier {
    pub fn new_with_vk(env: &Env, vk: crate::types::VerificationKey) -> Self {
        Self {
            env: env.clone(),
            vk,
        }
    }

    pub fn new(env: &Env, vk_bytes: &Bytes) -> Result<Self, VkLoadError> {
        load_vk_from_bytes(env, vk_bytes).map(|vk| Self::new_with_vk(env, vk))
    }

    /// Expose a reference to the parsed VK for debugging/inspection.
    pub fn get_vk(&self) -> &crate::types::VerificationKey {
        &self.vk
    }

    /// Verify an UltraHonk proof against the loaded VK.
    ///
    /// Steps (matching BB verifier flow):
    /// 1. Parse proof bytes.
    /// 2. Validate public-input length against VK metadata.
    /// 3. Generate Fiat-Shamir challenges (Oink rounds).
    /// 4. Compute `public_inputs_delta` (grand-product permutation argument).
    /// 5. Run sumcheck verification.
    /// 6. Run Shplemini batch-opening (Gemini + Shplonk + KZG pairing check).
    /// 7. Complete the recursive accumulator pairing. Neither pairing may be skipped.
    ///
    /// BB: `ultra_verifier.cpp::UltraVerifier_::verify_proof`
    pub fn verify(
        &self,
        env: &Env,
        proof_bytes: &Bytes,
        public_inputs_bytes: &Bytes,
    ) -> Result<(), VerifyError> {
        // 1) parse proof
        let proof = load_proof(env, proof_bytes).map_err(|_| VerifyError::InvalidInput)?;

        // 2) sanity on public inputs (length and VK metadata if present)
        validate_public_inputs(public_inputs_bytes).map_err(|_| VerifyError::InvalidInput)?;
        let provided = (public_inputs_bytes.len() / 32) as u64;
        let expected = self
            .vk
            .public_inputs_size
            .checked_sub(PAIRING_POINTS_SIZE as u64)
            .ok_or(VerifyError::InvalidInput)?;
        if expected != provided {
            return Err(VerifyError::InvalidInput);
        }

        // 3) Fiat-Shamir transcript
        let pub_inputs_offset = self.vk.pub_inputs_offset;
        let mut t = generate_transcript(&self.env, &proof, public_inputs_bytes, &self.vk.hash)
            .map_err(|_| VerifyError::InvalidInput)?;

        // 4) Public delta
        t.rel_params.public_inputs_delta = Self::compute_public_input_delta(
            env,
            public_inputs_bytes,
            &proof.pairing_point_object,
            &t.rel_params.beta,
            &t.rel_params.gamma,
            pub_inputs_offset,
        )
        .map_err(|_| VerifyError::InvalidInput)?;

        // 5) Sum-check
        verify_sumcheck(env, &proof, &t, &self.vk).map_err(|_| VerifyError::SumcheckFailed)?;

        // 6) Shplonk
        verify_shplemini(&self.env, &proof, &self.vk, &t)
            .map_err(|_| VerifyError::ShplonkFailed)?;

        // The circuit's recursive verifier defers this equation to its caller.
        // Checking just the outer proof would leave passport recursion incomplete.
        // The exact same eight limbs are bound by the transcript/public-input delta.
        complete_recursive_accumulator(env, &proof.pairing_point_object)?;

        Ok(())
    }

    /// Compute the public-input delta factor for the permutation grand-product argument.
    ///
    /// Formula (matching BB):
    ///   numerator   = product_i (gamma + x_i + beta*(2^28 + i + offset))
    ///   denominator = product_i (gamma + x_i - beta*(1 + i + offset))
    ///   delta       = numerator * denominator^-1
    ///
    /// The pairing-point object values are appended after the user-supplied public inputs.
    ///
    /// BB: `honk/library/grand_product_delta.hpp::compute_public_input_delta`
    fn compute_public_input_delta(
        env: &Env,
        public_inputs: &Bytes,
        pairing_point_object: &[Fr],
        beta: &Fr,
        gamma: &Fr,
        offset: u64,
    ) -> Result<Fr, &'static str> {
        let mut numerator = Fr::one(env);
        let mut denominator = Fr::one(env);

        // BB5 permutation IDs use the fixed 2^28 domain, not the circuit row count.
        let beta_n = beta * &Fr::from_u64(env, (1u64 << 28) + offset);
        let beta_off = beta * &Fr::from_u64(env, offset + 1);
        let mut numerator_acc = gamma + beta_n;
        let mut denominator_acc = gamma - &beta_off;

        let mut idx = 0u32;
        while idx < public_inputs.len() {
            let mut arr = [0u8; 32];
            public_inputs.slice(idx..idx + 32).copy_into_slice(&mut arr);
            let public_input = Fr::from_array(env, &arr);
            numerator = numerator * (&numerator_acc + &public_input);
            denominator = denominator * (&denominator_acc + &public_input);
            numerator_acc = &numerator_acc + beta;
            denominator_acc = &denominator_acc - beta;
            idx += 32;
        }
        for public_input in pairing_point_object {
            numerator = &numerator * &(&numerator_acc + public_input);
            denominator = &denominator * &(&denominator_acc + public_input);
            numerator_acc = &numerator_acc + beta;
            denominator_acc = &denominator_acc - beta;
        }
        if denominator.is_zero() {
            return Err("denominator is zero in public_input_delta");
        }
        let denominator_inv = denominator.inverse();
        Ok(numerator * denominator_inv)
    }
}

fn complete_recursive_accumulator(
    env: &Env,
    limbs: &[Fr; PAIRING_POINTS_SIZE],
) -> Result<(), VerifyError> {
    let recursive = decode_pairing_points(env, limbs).map_err(|_| VerifyError::InvalidInput)?;
    if !pairing_check(env, &recursive[0].0, &recursive[1].0) {
        return Err(VerifyError::RecursiveFailed);
    }
    Ok(())
}

#[cfg(all(test, not(any(feature = "count6", feature = "count7"))))]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Ledger;

    #[test]
    fn recursive_equation_and_outer_binding_are_distinct_requirements() {
        let env = Env::default();
        env.ledger().set_protocol_version(26);
        env.cost_estimate().budget().reset_unlimited();
        let bytes = Bytes::from_slice(&env, include_bytes!("../fixtures/proof.bin"));
        let proof = load_proof(&env, &bytes).unwrap();
        let mut limbs = proof.pairing_point_object;
        assert!(complete_recursive_accumulator(&env, &limbs).is_ok());
        for point in [0, 1] {
            let points = decode_pairing_points(&env, &limbs).unwrap();
            let negated = (-&points[point].0).to_array();
            let mut lo = [0u8; 32];
            let mut hi = [0u8; 32];
            lo[15..].copy_from_slice(&negated[47..]);
            hi[17..].copy_from_slice(&negated[32..47]);
            limbs[4 * point + 2] = Fr::from_array(&env, &lo);
            limbs[4 * point + 3] = Fr::from_array(&env, &hi);
            if point == 0 {
                assert!(matches!(
                    complete_recursive_accumulator(&env, &limbs),
                    Err(VerifyError::RecursiveFailed)
                ));
            } else {
                // Negating both preserves the pairing. Integration tests ensure
                // the full outer verifier still rejects these altered limbs.
                assert!(complete_recursive_accumulator(&env, &limbs).is_ok());
            }
        }
    }
}
