#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod debug;
pub mod ec;
pub mod field;
pub mod hash;
pub mod relations;
pub mod shplemini;
pub mod sumcheck;
pub mod transcript;
pub mod types;
pub mod utils;
pub mod verifier;

pub use verifier::{UltraHonkVerifier, VkLoadError};
pub const PROOF_BYTES: usize = types::PROOF_BYTES;

use soroban_sdk::{contract, contracterror, contractimpl, Bytes, Env};

/// Mathematical proof verification only. This does not authorize an anchor payout.
#[contract]
pub struct PassportVerifier;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VerificationError {
    InvalidKey = 1,
    InvalidProof = 2,
}

#[contractimpl]
impl PassportVerifier {
    /// Pinned official ZKPassport 0.20.0 OuterCount5 key; no caller-supplied key.
    pub fn verify(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<bool, VerificationError> {
        let key = Bytes::from_slice(&env, include_bytes!("../fixtures/vkey.bin"));
        let verifier =
            UltraHonkVerifier::new(&env, &key).map_err(|_| VerificationError::InvalidKey)?;
        verifier
            .verify(&env, &proof, &public_inputs)
            .map_err(|_| VerificationError::InvalidProof)?;
        Ok(true)
    }
}
