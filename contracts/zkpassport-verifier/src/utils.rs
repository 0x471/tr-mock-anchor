//! Strict decoder for one build-pinned ZKPassport 0.20.0 BB5 outer format.
//! Scalars are canonical Fr; ordinary G1 points are canonical raw x||y.
//! Recursive accumulator coordinates use low136/high120 limbs.

use crate::field::Fr;
use crate::hash::hash32;
use crate::types::{
    G1Point, Proof, VerificationKey, BATCHED_RELATION_PARTIAL_LENGTH, CONST_PROOF_SIZE_LOG_N,
    EXTERNAL_PUBLIC_INPUTS, NUMBER_OF_ENTITIES, PAIRING_POINTS_SIZE, PROOF_BYTES,
    PUBLIC_INPUTS_OFFSET, TOTAL_PUBLIC_INPUTS, VK_BYTES,
};
use crate::VkLoadError;
use core::array;
use soroban_sdk::{Bytes, Env};

pub const FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];
pub const FQ_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x97, 0x81, 0x6a, 0x91, 0x68, 0x71, 0xca, 0x8d, 0x3c, 0x20, 0x8c, 0x16, 0xd8, 0x7c, 0xfd, 0x47,
];

const _: () = assert!(
    PAIRING_POINTS_SIZE * 32
        + 8 * 64
        + CONST_PROOF_SIZE_LOG_N * BATCHED_RELATION_PARTIAL_LENGTH * 32
        + NUMBER_OF_ENTITIES * 32
        + (CONST_PROOF_SIZE_LOG_N - 1) * 64
        + CONST_PROOF_SIZE_LOG_N * 32
        + 2 * 64
        == PROOF_BYTES
);

/// Reject aliases before constructors (which reduce scalar values modulo Fr).
pub fn validate_public_inputs(bytes: &Bytes) -> Result<(), &'static str> {
    if bytes.len() as usize != EXTERNAL_PUBLIC_INPUTS * 32 {
        return Err("public input length mismatch");
    }
    let mut raw = [0u8; EXTERNAL_PUBLIC_INPUTS * 32];
    bytes.copy_into_slice(&mut raw);
    for word in raw.chunks_exact(32) {
        let word: &[u8; 32] = word.try_into().map_err(|_| "invalid scalar width")?;
        if *word >= FR_MODULUS {
            return Err("noncanonical public input");
        }
    }
    Ok(())
}

/// Validate every point before any MSM filtering can skip a zero-coefficient point.
/// Infinity is valid for ordinary proof/key commitments (e.g. zero selectors).
fn checked_point(env: &Env, raw: &[u8; 64]) -> Result<G1Point, &'static str> {
    let x: &[u8; 32] = raw[..32].try_into().map_err(|_| "point coordinate width")?;
    let y: &[u8; 32] = raw[32..].try_into().map_err(|_| "point coordinate width")?;
    if *x >= FQ_MODULUS || *y >= FQ_MODULUS {
        return Err("noncanonical point coordinate");
    }
    let point = G1Point::from_bytes(env, raw);
    if !env.crypto().bn254().g1_is_on_curve(point.as_bn254()) {
        return Err("point not on curve");
    }
    Ok(point)
}

fn accumulator_coordinate(lo: &[u8; 32], hi: &[u8; 32]) -> Result<[u8; 32], &'static str> {
    if lo[..15].iter().any(|b| *b != 0) || hi[..17].iter().any(|b| *b != 0) {
        return Err("noncanonical accumulator limb");
    }
    let mut out = [0u8; 32];
    out[..15].copy_from_slice(&hi[17..]);
    out[15..].copy_from_slice(&lo[15..]);
    if out >= FQ_MODULUS {
        return Err("noncanonical accumulator coordinate");
    }
    Ok(out)
}

/// Reconstruct and validate both mandatory recursive pairing points.
/// This pinned passport verifier deliberately rejects default/infinite accumulators;
/// it does not claim support for non-recursive circuits with an empty accumulator.
pub fn decode_pairing_points(
    env: &Env,
    limbs: &[Fr; PAIRING_POINTS_SIZE],
) -> Result<[G1Point; 2], &'static str> {
    let point = |i: usize| -> Result<G1Point, &'static str> {
        let x = accumulator_coordinate(&limbs[i].to_bytes(), &limbs[i + 1].to_bytes())?;
        let y = accumulator_coordinate(&limbs[i + 2].to_bytes(), &limbs[i + 3].to_bytes())?;
        let mut raw = [0u8; 64];
        raw[..32].copy_from_slice(&x);
        raw[32..].copy_from_slice(&y);
        if raw == [0u8; 64] {
            return Err("recursive accumulator infinity");
        }
        checked_point(env, &raw)
    };
    Ok([point(0)?, point(4)?])
}

struct Reader<'a> {
    raw: &'a [u8],
    position: usize,
}
impl<'a> Reader<'a> {
    fn new(raw: &'a [u8]) -> Self {
        Self { raw, position: 0 }
    }
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], &'static str> {
        let end = self.position.checked_add(N).ok_or("reader overflow")?;
        let slice = self.raw.get(self.position..end).ok_or("truncated input")?;
        let mut out = [0u8; N];
        out.copy_from_slice(slice);
        self.position = end;
        Ok(out)
    }
    fn scalar(&mut self, env: &Env) -> Result<Fr, &'static str> {
        let word = self.bytes::<32>()?;
        if word >= FR_MODULUS {
            return Err("noncanonical proof scalar");
        }
        Ok(Fr::from_array(env, &word))
    }
    fn scalars<const N: usize>(&mut self, env: &Env) -> Result<[Fr; N], &'static str> {
        let mut values = Fr::zero_array::<N>(env);
        for value in &mut values {
            *value = self.scalar(env)?;
        }
        Ok(values)
    }
    fn point(&mut self, env: &Env) -> Result<G1Point, &'static str> {
        checked_point(env, &self.bytes::<64>()?)
    }
    fn finish(&self) -> Result<(), &'static str> {
        if self.position == self.raw.len() {
            Ok(())
        } else {
            Err("unconsumed bytes")
        }
    }
}

pub fn load_proof(env: &Env, proof_bytes: &Bytes) -> Result<Proof, &'static str> {
    if proof_bytes.len() as usize != PROOF_BYTES {
        return Err("proof bytes length mismatch");
    }
    // One host copy; subsequent fixed-format reads happen over ordinary memory.
    let mut raw = [0u8; PROOF_BYTES];
    proof_bytes.copy_into_slice(&mut raw);
    let mut reader = Reader::new(&raw);
    let pairing_point_object = reader.scalars::<PAIRING_POINTS_SIZE>(env)?;
    // Validate accumulator points even before the transcript/MSM stage.
    decode_pairing_points(env, &pairing_point_object)?;
    let w1 = reader.point(env)?;
    let w2 = reader.point(env)?;
    let w3 = reader.point(env)?;
    let lookup_read_counts = reader.point(env)?;
    let lookup_read_tags = reader.point(env)?;
    let w4 = reader.point(env)?;
    let lookup_inverses = reader.point(env)?;
    let z_perm = reader.point(env)?;
    let mut sumcheck_univariates =
        array::from_fn(|_| Fr::zero_array::<BATCHED_RELATION_PARTIAL_LENGTH>(env));
    for row in &mut sumcheck_univariates {
        *row = reader.scalars(env)?;
    }
    let sumcheck_evaluations = reader.scalars::<NUMBER_OF_ENTITIES>(env)?;
    let mut gemini_fold_comms = array::from_fn(|_| G1Point::infinity(env));
    for point in &mut gemini_fold_comms {
        *point = reader.point(env)?;
    }
    let gemini_a_evaluations = reader.scalars::<CONST_PROOF_SIZE_LOG_N>(env)?;
    let shplonk_q = reader.point(env)?;
    let kzg_quotient = reader.point(env)?;
    reader.finish()?;
    Ok(Proof {
        pairing_point_object,
        w1,
        w2,
        w3,
        w4,
        lookup_read_counts,
        lookup_read_tags,
        lookup_inverses,
        z_perm,
        sumcheck_univariates,
        sumcheck_evaluations,
        gemini_fold_comms,
        gemini_a_evaluations,
        shplonk_q,
        kzg_quotient,
    })
}

pub fn load_vk_from_bytes(env: &Env, bytes: &Bytes) -> Result<VerificationKey, VkLoadError> {
    if bytes.len() as usize != VK_BYTES {
        return Err(VkLoadError::WrongLength);
    }
    let mut raw = [0u8; VK_BYTES];
    bytes.copy_into_slice(&mut raw);
    let mut reader = Reader::new(&raw);
    let mut header = [0u64; 3];
    for value in &mut header {
        let word = reader
            .bytes::<32>()
            .map_err(|_| VkLoadError::InvalidParameters)?;
        if word[..24].iter().any(|b| *b != 0) {
            return Err(VkLoadError::InvalidParameters);
        }
        let mut low = [0u8; 8];
        low.copy_from_slice(&word[24..]);
        *value = u64::from_be_bytes(low);
    }
    if header
        != [
            CONST_PROOF_SIZE_LOG_N as u64,
            TOTAL_PUBLIC_INPUTS as u64,
            PUBLIC_INPUTS_OFFSET,
        ]
    {
        return Err(VkLoadError::InvalidParameters);
    }
    let mut points: [G1Point; 28] = array::from_fn(|_| G1Point::infinity(env));
    for point in &mut points {
        *point = reader
            .point(env)
            .map_err(|_| VkLoadError::InvalidParameters)?;
    }
    reader
        .finish()
        .map_err(|_| VkLoadError::InvalidParameters)?;
    // Fr's constructor reduces the Keccak digest modulo r, as required by BB5.
    let hash = Fr::from_array(env, &hash32(bytes).to_array());
    Ok(VerificationKey {
        hash,
        circuit_size: 1u64 << CONST_PROOF_SIZE_LOG_N,
        log_circuit_size: header[0],
        public_inputs_size: header[1],
        pub_inputs_offset: header[2],
        s1: points[0].clone(),
        s2: points[1].clone(),
        s3: points[2].clone(),
        s4: points[3].clone(),
        id1: points[4].clone(),
        id2: points[5].clone(),
        id3: points[6].clone(),
        id4: points[7].clone(),
        lagrange_first: points[8].clone(),
        lagrange_last: points[9].clone(),
        q_lookup: points[10].clone(),
        t1: points[11].clone(),
        t2: points[12].clone(),
        t3: points[13].clone(),
        t4: points[14].clone(),
        qm: points[15].clone(),
        qr: points[16].clone(),
        qo: points[17].clone(),
        qc: points[18].clone(),
        ql: points[19].clone(),
        q4: points[20].clone(),
        q_arith: points[21].clone(),
        q_delta_range: points[22].clone(),
        q_elliptic: points[23].clone(),
        q_memory: points[24].clone(),
        q_nnf: points[25].clone(),
        q_poseidon2_external: points[26].clone(),
        q_poseidon2_internal: points[27].clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accumulator_limb_bounds_and_field_bounds_are_strict() {
        let mut lo = [0u8; 32];
        let mut hi = [0u8; 32];
        lo[31] = 1;
        assert_eq!(accumulator_coordinate(&lo, &hi).unwrap()[31], 1);
        lo[0] = 1;
        assert!(accumulator_coordinate(&lo, &hi).is_err());
        lo = [0u8; 32];
        hi[16] = 1;
        assert!(accumulator_coordinate(&lo, &hi).is_err());
        hi = [0u8; 32];
        lo[15..].copy_from_slice(&FQ_MODULUS[15..]);
        hi[17..].copy_from_slice(&FQ_MODULUS[..15]);
        assert!(accumulator_coordinate(&lo, &hi).is_err());
    }
    #[test]
    fn public_inputs_reject_noncanonical_modulus_and_wrong_length() {
        let env = Env::default();
        let mut raw = [0u8; EXTERNAL_PUBLIC_INPUTS * 32];
        assert!(validate_public_inputs(&Bytes::from_slice(&env, &raw)).is_ok());
        raw[..32].copy_from_slice(&FR_MODULUS);
        assert!(validate_public_inputs(&Bytes::from_slice(&env, &raw)).is_err());
        assert!(validate_public_inputs(&Bytes::new(&env)).is_err());
    }
}
