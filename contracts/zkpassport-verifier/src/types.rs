//! Fixed ZKPassport 0.20.0 BB5 UltraKeccak outer-verifier types.
//!
//! Layout follows the official OuterCount5/6/7.sol at d3a75acb8529e82c61be136a402553daec259257.
//! This is deliberately not a generic or cross-version UltraHonk decoder.

use crate::field::Fr;
use soroban_sdk::crypto::bn254::Bn254G1Affine;
use soroban_sdk::Env;

pub const PROOF_BYTES: usize = if cfg!(any(feature = "count6", feature = "count7")) {
    10240
} else {
    9888
};
pub const VK_BYTES: usize = 1888;
pub const EXTERNAL_PUBLIC_INPUTS: usize = if cfg!(feature = "count6") {
    11
} else if cfg!(feature = "count7") {
    12
} else {
    10
};
pub const TOTAL_PUBLIC_INPUTS: usize = EXTERNAL_PUBLIC_INPUTS + 8;
pub const PUBLIC_INPUTS_OFFSET: u64 = 5;

pub const CONST_PROOF_SIZE_LOG_N: usize = if cfg!(any(feature = "count6", feature = "count7")) {
    23
} else {
    22
};
pub const NUMBER_OF_SUBRELATIONS: usize = 29;
pub const BATCHED_RELATION_PARTIAL_LENGTH: usize = 8;
pub const NUMBER_OF_ENTITIES: usize = 41;
pub const NUMBER_UNSHIFTED: usize = 36;
pub const NUMBER_TO_BE_SHIFTED: usize = 5;
pub const PAIRING_POINTS_SIZE: usize = 8;
pub const NUMBER_OF_ALPHAS: usize = NUMBER_OF_SUBRELATIONS - 1;

/// Wire indices for the UltraHonk protocol.
///
/// Exact official BB5 key/evaluation order. Indices 0-35 are unshifted;
/// 36-40 are shifted Wl, Wr, Wo, W4, ZPerm. Do not substitute older BB order.
#[derive(Copy, Clone, Debug)]
pub enum Wire {
    Sigma1 = 0,
    Sigma2 = 1,
    Sigma3 = 2,
    Sigma4 = 3,
    Id1 = 4,
    Id2 = 5,
    Id3 = 6,
    Id4 = 7,
    LagrangeFirst = 8,
    LagrangeLast = 9,
    QLookup = 10,
    Table1 = 11,
    Table2 = 12,
    Table3 = 13,
    Table4 = 14,
    Qm = 15,
    Qr = 16,
    Qo = 17,
    Qc = 18,
    Ql = 19,
    Q4 = 20,
    QArith = 21,
    QRange = 22,
    QElliptic = 23,
    QMemory = 24,
    QNnf = 25,
    QPoseidon2External = 26,
    QPoseidon2Internal = 27,
    Wl = 28,
    Wr = 29,
    Wo = 30,
    W4 = 31,
    ZPerm = 32,
    LookupInverses = 33,
    LookupReadCounts = 34,
    LookupReadTags = 35,
    WlShift = 36,
    WrShift = 37,
    WoShift = 38,
    W4Shift = 39,
    ZPermShift = 40,
}

impl Wire {
    pub fn index(&self) -> usize {
        *self as usize
    }
}

/// A BN254 G1 point in affine coordinates.
///
/// Thin wrapper around the Soroban host type `Bn254G1Affine`.
///
/// BB: `curve::BN254::AffineElement`
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct G1Point(pub Bn254G1Affine);

impl G1Point {
    #[inline(always)]
    pub fn as_bn254(&self) -> &Bn254G1Affine {
        &self.0
    }

    pub fn from_xy(env: &Env, x: &[u8; 32], y: &[u8; 32]) -> Self {
        let mut bytes: [u8; 64] = [0u8; 64];
        bytes[..32].copy_from_slice(x);
        bytes[32..].copy_from_slice(y);
        Self::from_bytes(env, &bytes)
    }

    #[inline(always)]
    pub fn from_bytes(env: &Env, bytes: &[u8; 64]) -> Self {
        G1Point(Bn254G1Affine::from_array(env, bytes))
    }

    #[inline(always)]
    pub fn to_bytes(&self) -> [u8; 64] {
        self.0.to_array()
    }

    #[inline(always)]
    pub fn infinity(env: &Env) -> Self {
        G1Point(Bn254G1Affine::from_array(env, &[0u8; 64]))
    }

    pub fn generator(env: &Env) -> Self {
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        x[31] = 1;
        y[31] = 2;
        G1Point::from_xy(env, &x, &y)
    }
}

/// Verification key for UltraHonk circuits.
///
/// Header: three canonical words pinned by the selected build profile,
/// then 28 raw G1 commitments in Wire order. Hash is Keccak(raw VK) mod Fr.
#[derive(Clone, Debug)]
pub struct VerificationKey {
    pub hash: Fr,
    pub circuit_size: u64,
    pub log_circuit_size: u64,
    pub public_inputs_size: u64,
    pub pub_inputs_offset: u64,
    // Selectors and wire commitments:
    pub qm: G1Point,
    pub qc: G1Point,
    pub ql: G1Point,
    pub qr: G1Point,
    pub qo: G1Point,
    pub q4: G1Point,
    pub q_lookup: G1Point,
    pub q_arith: G1Point,
    pub q_delta_range: G1Point,
    pub q_elliptic: G1Point,
    pub q_memory: G1Point,
    pub q_nnf: G1Point,
    pub q_poseidon2_external: G1Point,
    pub q_poseidon2_internal: G1Point,
    // Copy constraints:
    pub s1: G1Point,
    pub s2: G1Point,
    pub s3: G1Point,
    pub s4: G1Point,
    pub id1: G1Point,
    pub id2: G1Point,
    pub id3: G1Point,
    pub id4: G1Point,
    // Lookup table commitments:
    pub t1: G1Point,
    pub t2: G1Point,
    pub t3: G1Point,
    pub t4: G1Point,
    // Fixed first/last
    pub lagrange_first: G1Point,
    pub lagrange_last: G1Point,
}

/// UltraHonk proof structure.
///
/// Fixed-size layout (`PROOF_BYTES`), with L = `CONST_PROOF_SIZE_LOG_N`:
/// - 8 Fr limbs (two recursive pairing points, low136/high120 coordinates)
/// - 8 G1 commitments (wire + lookup)
/// - L * 8 Fr elements (sumcheck univariates)
/// - 41 Fr elements (sumcheck evaluations)
/// - (L - 1) G1 commitments (Gemini fold)
/// - L Fr elements (Gemini fold evaluations)
/// - 2 G1 commitments (Shplonk Q + KZG quotient)
/// All ordinary G1 points are raw 64-byte x||y, not split limbs.
#[derive(Clone, Debug)]
pub struct Proof {
    // Pairing point object (8 Fr limbs)
    pub pairing_point_object: [Fr; PAIRING_POINTS_SIZE],
    // Wire commitments
    pub w1: G1Point,
    pub w2: G1Point,
    pub w3: G1Point,
    pub w4: G1Point,
    // Lookup helpers
    pub lookup_read_counts: G1Point,
    pub lookup_read_tags: G1Point,
    pub lookup_inverses: G1Point,
    pub z_perm: G1Point,
    // Sumcheck polynomials
    pub sumcheck_univariates: [[Fr; BATCHED_RELATION_PARTIAL_LENGTH]; CONST_PROOF_SIZE_LOG_N],
    pub sumcheck_evaluations: [Fr; NUMBER_OF_ENTITIES],
    // Gemini fold commitments
    pub gemini_fold_comms: [G1Point; CONST_PROOF_SIZE_LOG_N - 1],
    pub gemini_a_evaluations: [Fr; CONST_PROOF_SIZE_LOG_N],
    // Shplonk
    pub shplonk_q: G1Point,
    pub kzg_quotient: G1Point,
}

/// Relation parameters used by all subrelation accumulators.
///
/// BB: `relations/relation_parameters.hpp::RelationParameters`
#[derive(Clone, Debug)]
pub struct RelationParameters {
    pub eta: Fr,
    pub eta_two: Fr,
    pub eta_three: Fr,
    pub beta: Fr,
    pub gamma: Fr,
    pub public_inputs_delta: Fr,
}

/// Container for all Fiat-Shamir challenges derived by the transcript.
///
/// BB: Fields are scattered across `DeciderVerificationKey_` and the
///      transcript itself in the C++ codebase.
#[derive(Clone, Debug)]
pub struct Transcript {
    pub rel_params: RelationParameters,
    pub alphas: [Fr; NUMBER_OF_ALPHAS],
    pub gate_challenges: [Fr; CONST_PROOF_SIZE_LOG_N],
    pub sumcheck_u_challenges: [Fr; CONST_PROOF_SIZE_LOG_N],
    pub rho: Fr,
    pub gemini_r: Fr,
    pub shplonk_nu: Fr,
    pub shplonk_z: Fr,
}
