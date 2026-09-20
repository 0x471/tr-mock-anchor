#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

#[cfg(any(
    all(feature = "count6", feature = "count7"),
    all(feature = "count6", feature = "count8"),
    all(feature = "count7", feature = "count8")
))]
compile_error!("Select exactly one immutable outer proof profile per contract build.");

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

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, Bytes, BytesN, Env};

#[cfg(feature = "count6")]
const PINNED_KEY: &[u8] = include_bytes!("../fixtures/vkey-0.20.0-outer-count-6.bin");
#[cfg(feature = "count7")]
const PINNED_KEY: &[u8] = include_bytes!("../fixtures/vkey-0.20.0-outer-count-7.bin");
#[cfg(feature = "count8")]
const PINNED_KEY: &[u8] = include_bytes!("../fixtures/vkey-0.20.0-outer-count-8.bin");
#[cfg(not(any(feature = "count6", feature = "count7", feature = "count8")))]
const PINNED_KEY: &[u8] = include_bytes!("../fixtures/vkey.bin");

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationProfile {
    pub vk_hash: BytesN<32>,
    pub external_inputs: u32,
    pub proof_bytes: u32,
    pub log_n: u32,
}

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
    pub fn profile(env: Env) -> Result<VerificationProfile, VerificationError> {
        let key = Bytes::from_slice(&env, PINNED_KEY);
        let verifier =
            UltraHonkVerifier::new(&env, &key).map_err(|_| VerificationError::InvalidKey)?;
        Ok(VerificationProfile {
            vk_hash: BytesN::from_array(&env, &verifier.get_vk().hash.to_bytes()),
            external_inputs: types::EXTERNAL_PUBLIC_INPUTS as u32,
            proof_bytes: types::PROOF_BYTES as u32,
            log_n: types::CONST_PROOF_SIZE_LOG_N as u32,
        })
    }

    /// One pinned official ZKPassport 0.20.0 key per build; no caller-supplied key.
    pub fn verify(env: Env, proof: Bytes, public_inputs: Bytes) -> Result<bool, VerificationError> {
        let key = Bytes::from_slice(&env, PINNED_KEY);
        let verifier =
            UltraHonkVerifier::new(&env, &key).map_err(|_| VerificationError::InvalidKey)?;
        verifier
            .verify(&env, &proof, &public_inputs)
            .map_err(|_| VerificationError::InvalidProof)?;
        Ok(true)
    }
}
