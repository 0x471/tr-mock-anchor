//! Relation accumulation for the pinned ZKPassport 0.20 BB5 outer verifier.
//!
//! Reference: the matching official `FixtureOuterCount5.sol` at circuits commit
//! d3a75acb8529e82c61be136a402553daec259257, plus the BB5 relation equations in
//! co-snarks cd3db67c775b7bf40beab9248c6437dd316eb667. This is not the legacy
//! BB 0.82 relation set. The 29 subrelations are ordered permutation, lookup,
//! arithmetic, delta range, elliptic, memory, non-native field, Poseidon external,
//! Poseidon internal. Only lookup's global log-derivative identity omits the
//! gate-separator multiplier. The caller supplies alpha powers in that order.

use crate::field::Fr;
use crate::types::{RelationParameters, Wire, NUMBER_OF_SUBRELATIONS};
use core::ops::Index;
use soroban_sdk::{bytesn, crypto::bn254::Bn254Fr, Env};

impl Index<Wire> for [Fr] {
    type Output = Fr;

    #[inline(always)]
    fn index(&self, wire: Wire) -> &Self::Output {
        &self[wire.index()]
    }
}

/// Accumulate the two arithmetic subrelations (indices 6 and 7).
///
/// BB: `relations/ultra_arithmetic_relation.hpp::UltraArithmeticRelation::accumulate`
fn accumulate_arithmetic_relation(env: &Env, p: &[Fr], evals: &mut [Fr], domain_sep: &Fr) {
    let one = Fr::one(env);
    let two = Fr::from_u64(env, 2);
    let three = Fr::from_u64(env, 3);
    let neg_half = Fr::neg_half(env);

    let q_arith = &p[Wire::QArith];
    let qm = &p[Wire::Qm];
    let wr = &p[Wire::Wr];
    let wl = &p[Wire::Wl];
    let ql = &p[Wire::Ql];
    let qr = &p[Wire::Qr];
    let qo = &p[Wire::Qo];
    let q4 = &p[Wire::Q4];
    let w4 = &p[Wire::W4];
    let qc = &p[Wire::Qc];
    let w4_shift = &p[Wire::W4Shift];
    let wl_shift = &p[Wire::WlShift];
    let wo = &p[Wire::Wo];
    // Arithmetic relation 0
    {
        let mut accum = (q_arith - &three) * qm * wr * wl * &neg_half;
        accum = accum + ql * wl + qr * wr + qo * wo + q4 * w4 + qc;
        accum = (accum + (q_arith - &one) * w4_shift) * q_arith * domain_sep;
        evals[6] = accum;
    }
    // Arithmetic relation 1
    {
        let mut accum = wl + w4 - wl_shift + qm;
        accum = accum * (q_arith - &two) * (q_arith - &one) * q_arith * domain_sep;
        evals[7] = accum;
    }
}

/// Accumulate the three permutation subrelations (indices 0..2).
///
/// BB: `relations/permutation_relation.hpp::UltraPermutationRelation::accumulate`
fn accumulate_permutation_relation(
    p: &[Fr],
    rp: &RelationParameters,
    evals: &mut [Fr],
    domain_sep: &Fr,
) {
    let wl = &p[Wire::Wl];
    let wr = &p[Wire::Wr];
    let wo = &p[Wire::Wo];
    let w4 = &p[Wire::W4];
    let z_perm = &p[Wire::ZPerm];
    let lagrange_first = &p[Wire::LagrangeFirst];
    let z_perm_shift = &p[Wire::ZPermShift];
    let lagrange_last = &p[Wire::LagrangeLast];

    let grand_product_numerator = {
        let mut num = wl + &p[Wire::Id1] * &rp.beta + &rp.gamma;
        num = num
            * (wr + &p[Wire::Id2] * &rp.beta + &rp.gamma)
            * (wo + &p[Wire::Id3] * &rp.beta + &rp.gamma)
            * (w4 + &p[Wire::Id4] * &rp.beta + &rp.gamma);
        num
    };

    let grand_product_denominator = {
        let mut den = wl + &p[Wire::Sigma1] * &rp.beta + &rp.gamma;
        den = den
            * (wr + &p[Wire::Sigma2] * &rp.beta + &rp.gamma)
            * (wo + &p[Wire::Sigma3] * &rp.beta + &rp.gamma)
            * (w4 + &p[Wire::Sigma4] * &rp.beta + &rp.gamma);
        den
    };

    // Grand-product recurrence.
    {
        evals[0] = ((z_perm + lagrange_first) * grand_product_numerator
            - (z_perm_shift + lagrange_last * &rp.public_inputs_delta) * grand_product_denominator)
            * domain_sep;
    }

    // Both boundary conditions are required in BB5.
    {
        evals[1] = lagrange_last * z_perm_shift * domain_sep;
        evals[2] = lagrange_first * z_perm * domain_sep;
    }
}

/// Accumulate the three lookup log-derivative subrelations (indices 3..5).
///
/// BB: `relations/logderiv_lookup_relation.hpp::LogDerivLookupRelation::accumulate`
fn accumulate_log_derivative_lookup_relation(
    p: &[Fr],
    rp: &RelationParameters,
    evals: &mut [Fr],
    domain_sep: &Fr,
) {
    // BB5 uses beta powers for lookup compression; eta is reserved for memory.
    let beta_two = &rp.beta * &rp.beta;
    let beta_three = &beta_two * &rp.beta;
    let write_term = &p[Wire::Table1]
        + &rp.gamma
        + &p[Wire::Table2] * &rp.beta
        + &p[Wire::Table3] * &beta_two
        + &p[Wire::Table4] * &beta_three;

    let derived_entry_2 = &p[Wire::Wr] + &p[Wire::Qm] * &p[Wire::WrShift];
    let derived_entry_3 = &p[Wire::Wo] + &p[Wire::Qc] * &p[Wire::WoShift];

    let read_term = &p[Wire::Wl]
        + &rp.gamma
        + &p[Wire::Qr] * &p[Wire::WlShift]
        + derived_entry_2 * &rp.beta
        + derived_entry_3 * &beta_two
        + &p[Wire::Qo] * &beta_three;

    let inv = &p[Wire::LookupInverses];
    let lookup_read_tags = &p[Wire::LookupReadTags];
    let q_lookup = &p[Wire::QLookup];
    let inv_exists = lookup_read_tags + q_lookup - lookup_read_tags * q_lookup;

    evals[3] = (&read_term * &write_term * inv - inv_exists) * domain_sep;
    evals[4] = q_lookup * (&write_term * inv) - &p[Wire::LookupReadCounts] * (read_term * inv);
    evals[5] = (lookup_read_tags * lookup_read_tags - lookup_read_tags) * domain_sep;
}

/// Accumulate the four range-check subrelations (indices 8..11).
///
/// BB: `relations/delta_range_constraint_relation.hpp::DeltaRangeConstraintRelation::accumulate`
fn accumulate_delta_range_relation(env: &Env, p: &[Fr], evals: &mut [Fr], domain_sep: &Fr) {
    let minus_one = Fr::minus_one(env);
    let minus_two = Fr::minus_two(env);
    let minus_three = Fr::minus_three(env);

    let wr = &p[Wire::Wr];
    let wl = &p[Wire::Wl];
    let wo = &p[Wire::Wo];
    let w4 = &p[Wire::W4];
    let wl_shift = &p[Wire::WlShift];
    let delta_1 = wr - wl;
    let delta_2 = wo - wr;
    let delta_3 = w4 - wo;
    let delta_4 = wl_shift - w4;
    let deltas = [delta_1, delta_2, delta_3, delta_4];
    let negs = [minus_one, minus_two, minus_three];
    let q_range_dom = &p[Wire::QRange] * domain_sep;

    // Contributions 8..11
    for i in 0..4 {
        let mut acc = deltas[i].clone();
        for n in &negs {
            acc = acc * (&deltas[i] + n);
        }
        evals[8 + i] = acc * &q_range_dom;
    }
}

/// Accumulate elliptic-curve subrelations (indices 12..13).
///
/// Uses Grumpkin curve parameter `b = -17` (so `B_NEG = 17`).
///
/// BB: `relations/elliptic_relation.hpp::EllipticRelation::accumulate`
fn accumulate_elliptic_relation(env: &Env, p: &[Fr], evals: &mut [Fr], domain_sep: &Fr) {
    let one = Fr::one(env);
    let nine = Fr::from_u64(env, 9);

    let x1 = &p[Wire::Wr];
    let y1 = &p[Wire::Wo];
    let x2 = &p[Wire::WlShift];
    let y2 = &p[Wire::W4Shift];
    let x3 = &p[Wire::WrShift];
    let y3 = &p[Wire::WoShift];

    let q_sign = &p[Wire::Ql];
    let q_double = &p[Wire::Qm];
    let q_gate = &p[Wire::QElliptic];

    let delta_x = x2 - x1;
    let y1_sq = y1 * y1;

    let x_add_id = {
        let y2_sq = y2 * y2;
        let y1y2 = y1 * y2 * q_sign;
        (x3 + x2 + x1) * &delta_x * &delta_x - &y2_sq - &y1_sq + &y1y2 + &y1y2
    };
    let y_add_id = {
        let y_diff = y2 * q_sign - y1;
        (y1 + y3) * &delta_x + (x3 - x1) * &y_diff
    };

    const B_NEG: u64 = 17;
    let b_neg = Fr::from_u64(env, B_NEG);

    let x_double_id = {
        let x_pow_4 = (&y1_sq + &b_neg) * x1;
        let y1_sqr_mul_4 = &y1_sq + &y1_sq + &y1_sq + &y1_sq;
        let x_pow_4_mul_9 = x_pow_4 * &nine;
        (x3 + x1 + x1) * y1_sqr_mul_4 - x_pow_4_mul_9
    };
    let y_double_id = {
        let x1_sqr_mul_3 = (x1 + x1 + x1) * x1;
        x1_sqr_mul_3 * (x1 - x3) - (y1 + y1) * (y1 + y3)
    };

    let q_gate_dom = q_gate * domain_sep;
    let add_factor = (one - q_double) * &q_gate_dom;
    let double_factor = q_double * q_gate_dom;

    // Contribution 12: elliptic x
    evals[12] = x_add_id * &add_factor + x_double_id * &double_factor;
    // Contribution 13: elliptic y
    evals[13] = y_add_id * add_factor + y_double_id * double_factor;
}

/// Accumulate memory subrelations (indices 14..19).
/// BB5 separates memory from non-native-field gates, and uses Qo (not QArith)
/// to select RAM consistency checks.
fn accumulate_memory_relation(
    env: &Env,
    p: &[Fr],
    rp: &RelationParameters,
    evals: &mut [Fr],
    domain_sep: &Fr,
) {
    let one = Fr::one(env);
    let wl = &p[Wire::Wl];
    let wr = &p[Wire::Wr];
    let wo = &p[Wire::Wo];
    let w4 = &p[Wire::W4];
    let wl_shift = &p[Wire::WlShift];
    let wr_shift = &p[Wire::WrShift];
    let wo_shift = &p[Wire::WoShift];
    let w4_shift = &p[Wire::W4Shift];
    let ql = &p[Wire::Ql];
    let qr = &p[Wire::Qr];
    let qo = &p[Wire::Qo];
    let q4 = &p[Wire::Q4];
    let qm = &p[Wire::Qm];
    let qc = &p[Wire::Qc];
    let q_memory = &p[Wire::QMemory];

    let memory_record_check = wo * &rp.eta_three + wr * &rp.eta_two + wl * &rp.eta + qc;
    let access_type = w4 - &memory_record_check;
    let memory_record_check = memory_record_check - w4;

    let index_delta = wl_shift - wl;
    let record_delta = w4_shift - w4;

    let index_is_monotonically_increasing = &index_delta * &index_delta - &index_delta;
    let adjacent_values_match_if_adjacent_indices_match = (&one - &index_delta) * record_delta;

    let rom_gate_common = ql * qr * q_memory * domain_sep;

    evals[15] = adjacent_values_match_if_adjacent_indices_match * &rom_gate_common;
    evals[16] = &index_is_monotonically_increasing * rom_gate_common;

    let access_check = &access_type * &access_type - access_type;

    let mut next_gate_access_type =
        wo_shift * &rp.eta_three + wr_shift * &rp.eta_two + wl_shift * &rp.eta;
    next_gate_access_type = w4_shift - &next_gate_access_type;

    let value_delta = wo_shift - wo;
    let adjacent_values_match_if_adjacent_indices_match_and_next_access_is_a_read_operation =
        (&one - &index_delta) * value_delta * (&one - &next_gate_access_type);

    let ram_gate_common = qo * q_memory * domain_sep;

    // Contributions 17..19: RAM.
    evals[17] = adjacent_values_match_if_adjacent_indices_match_and_next_access_is_a_read_operation
        * &ram_gate_common;
    evals[18] = index_is_monotonically_increasing * &ram_gate_common;
    evals[19] =
        (&next_gate_access_type * &next_gate_access_type - next_gate_access_type) * ram_gate_common;

    let rom_consistency_check_identity = &memory_record_check * ql * qr;
    let ram_timestamp_check_identity = (&one - index_delta) * (wr_shift - wr) - wo;
    let ram_consistency_check_identity = access_check * qo;

    let memory_identity = rom_consistency_check_identity
        + ram_timestamp_check_identity * q4 * ql
        + memory_record_check * qm * ql
        + ram_consistency_check_identity;

    evals[14] = memory_identity * q_memory * domain_sep;
}

/// Accumulate the BB5 non-native-field/limb identity (index 20).
fn accumulate_non_native_field_relation(env: &Env, p: &[Fr], evals: &mut [Fr], domain_sep: &Fr) {
    let limb_size = Fr(Bn254Fr::from_bytes(bytesn!(
        &env,
        0x0000000000000000000000000000000000000000000000100000000000000000
    )));
    let sublimb_shift = Fr::from_u64(env, 1 << 14);
    let wl = &p[Wire::Wl];
    let wr = &p[Wire::Wr];
    let wo = &p[Wire::Wo];
    let w4 = &p[Wire::W4];
    let wl_shift = &p[Wire::WlShift];
    let wr_shift = &p[Wire::WrShift];
    let wo_shift = &p[Wire::WoShift];
    let w4_shift = &p[Wire::W4Shift];
    let qr = &p[Wire::Qr];
    let qo = &p[Wire::Qo];
    let q4 = &p[Wire::Q4];
    let qm = &p[Wire::Qm];

    let mut limb_subproduct = wl * wr_shift + wl_shift * wr;
    let non_native_field_gate_2 =
        ((wl * w4 + wr * wo - wo_shift) * &limb_size - w4_shift + &limb_subproduct) * q4;
    limb_subproduct = &limb_size * &limb_subproduct + wl_shift * wr_shift;
    let non_native_field_gate_1 = (&limb_subproduct - (wo + w4)) * qo;
    let non_native_field_gate_3 = (&limb_subproduct + w4 - (wo_shift + w4_shift)) * qm;
    let non_native_field_identity =
        (non_native_field_gate_1 + non_native_field_gate_2 + non_native_field_gate_3) * qr;

    let mut limb_accumulator_1 = wr_shift * &sublimb_shift + wl_shift;
    limb_accumulator_1 = limb_accumulator_1 * &sublimb_shift + wo;
    limb_accumulator_1 = limb_accumulator_1 * &sublimb_shift + wr;
    limb_accumulator_1 = limb_accumulator_1 * &sublimb_shift + wl;
    limb_accumulator_1 = (limb_accumulator_1 - w4) * q4;
    let mut limb_accumulator_2 = wo_shift * &sublimb_shift + wr_shift;
    limb_accumulator_2 = limb_accumulator_2 * &sublimb_shift + wl_shift;
    limb_accumulator_2 = limb_accumulator_2 * &sublimb_shift + w4;
    limb_accumulator_2 = limb_accumulator_2 * &sublimb_shift + wo;
    limb_accumulator_2 = (limb_accumulator_2 - w4_shift) * qm;
    let limb_accumulator_identity = (limb_accumulator_1 + limb_accumulator_2) * qo;
    evals[20] =
        (non_native_field_identity + limb_accumulator_identity) * &p[Wire::QNnf] * domain_sep;
}

/// Accumulate Poseidon external subrelations (indices 21..24).
///
/// BB: `relations/poseidon2_external_relation.hpp::Poseidon2ExternalRelation::accumulate`
fn accumulate_poseidon_external_relation(p: &[Fr], evals: &mut [Fr], domain_sep: &Fr) {
    let wl = &p[Wire::Wl];
    let ql = &p[Wire::Ql];
    let wr = &p[Wire::Wr];
    let qr = &p[Wire::Qr];
    let wo = &p[Wire::Wo];
    let qo = &p[Wire::Qo];
    let w4 = &p[Wire::W4];
    let q4 = &p[Wire::Q4];
    let wl_shift = &p[Wire::WlShift];
    let wr_shift = &p[Wire::WrShift];
    let wo_shift = &p[Wire::WoShift];
    let w4_shift = &p[Wire::W4Shift];
    let q_poseidon = &p[Wire::QPoseidon2External];

    let s1 = wl + ql;
    let s2 = wr + qr;
    let s3 = wo + qo;
    let s4 = w4 + q4;

    let u1_ext = s1.pow(5);
    let u2_ext = s2.pow(5);
    let u3_ext = s3.pow(5);
    let u4_ext = s4.pow(5);

    let t0 = &u1_ext + &u2_ext;
    let t1 = &u3_ext + &u4_ext;
    let t2 = &u2_ext + &u2_ext + &t1;
    let t3 = &u4_ext + &u4_ext + &t0;

    let v4 = &t1 + &t1 + &t1 + &t1 + &t3;
    let v2 = &t0 + &t0 + &t0 + &t0 + &t2;
    let v1 = &t3 + &v2;
    let v3 = &t2 + &v4;

    let q_poseidon_dom = q_poseidon * domain_sep;
    evals[21] = (v1 - wl_shift) * &q_poseidon_dom;
    evals[22] = (v2 - wr_shift) * &q_poseidon_dom;
    evals[23] = (v3 - wo_shift) * &q_poseidon_dom;
    evals[24] = (v4 - w4_shift) * q_poseidon_dom;
}

/// Accumulate Poseidon internal subrelations (indices 25..28).
///
/// Uses the internal matrix diagonal constants from `field.rs::Fr::internal_matrix_diagonal`.
///
/// BB: `relations/poseidon2_internal_relation.hpp::Poseidon2InternalRelation::accumulate`
fn accumulate_poseidon_internal_relation(
    p: &[Fr],
    evals: &mut [Fr],
    domain_sep: &Fr,
    diag: &[Fr; 4],
) {
    let wl = &p[Wire::Wl];
    let ql = &p[Wire::Ql];
    let u1_int = (wl + ql).pow(5);
    let u2_int = &p[Wire::Wr];
    let u3_int = &p[Wire::Wo];
    let u4_int = &p[Wire::W4];
    let wl_shift = &p[Wire::WlShift];
    let wr_shift = &p[Wire::WrShift];
    let wo_shift = &p[Wire::WoShift];
    let w4_shift = &p[Wire::W4Shift];
    let q_poseidon = &p[Wire::QPoseidon2Internal];
    let q_poseidon_dom = q_poseidon * domain_sep;
    let u_sum = &u1_int + u2_int + u3_int + u4_int;

    let w1 = &u1_int * &diag[0] + &u_sum;
    let w2 = u2_int * &diag[1] + &u_sum;
    let w3 = u3_int * &diag[2] + &u_sum;
    let w4 = u4_int * &diag[3] + &u_sum;

    evals[25] = (w1 - wl_shift) * &q_poseidon_dom;
    evals[26] = (w2 - wr_shift) * &q_poseidon_dom;
    evals[27] = (w3 - wo_shift) * &q_poseidon_dom;
    evals[28] = (w4 - w4_shift) * q_poseidon_dom;
}

/// Batch all 29 subrelations with caller-provided alpha powers.
/// Result: `evals[0] + evals[1]*alpha + ... + evals[28]*alpha^2^8`.
///
/// BB: `relations/utils.hpp::RelationUtils::scale_and_batch_elements`
fn scale_and_batch_subrelations(evaluations: &[Fr], subrelation_challenges: &[Fr]) -> Fr {
    let mut accumulator = evaluations[0].clone();
    for i in 1..NUMBER_OF_SUBRELATIONS {
        accumulator = accumulator + &evaluations[i] * &subrelation_challenges[i - 1];
    }
    accumulator
}

/// Main entrypoint: evaluate all 29 subrelations and batch with alpha powers.
///
/// BB: `sumcheck_round.hpp::SumcheckVerifierRound::compute_full_relation_purported_value`
pub fn accumulate_relation_evaluations(
    env: &Env,
    purported_evaluations: &[Fr],
    rp: &RelationParameters,
    alphas: &[Fr],
    pow_partial_eval: Fr,
) -> Fr {
    let mut evaluations = Fr::zero_array::<NUMBER_OF_SUBRELATIONS>(env);
    let domain_sep = &pow_partial_eval;
    let poseidon_internal_diag = Fr::internal_matrix_diagonal(env);

    accumulate_arithmetic_relation(env, purported_evaluations, &mut evaluations, domain_sep);
    accumulate_permutation_relation(purported_evaluations, rp, &mut evaluations, domain_sep);
    accumulate_log_derivative_lookup_relation(
        purported_evaluations,
        rp,
        &mut evaluations,
        domain_sep,
    );
    accumulate_delta_range_relation(env, purported_evaluations, &mut evaluations, domain_sep);
    accumulate_elliptic_relation(env, purported_evaluations, &mut evaluations, domain_sep);
    accumulate_memory_relation(env, purported_evaluations, rp, &mut evaluations, domain_sep);
    accumulate_non_native_field_relation(env, purported_evaluations, &mut evaluations, domain_sep);
    accumulate_poseidon_external_relation(purported_evaluations, &mut evaluations, domain_sep);
    accumulate_poseidon_internal_relation(
        purported_evaluations,
        &mut evaluations,
        domain_sep,
        &poseidon_internal_diag,
    );

    scale_and_batch_subrelations(&evaluations, alphas)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bb5_relation_regression_vector() {
        let env = Env::default();
        let mut purported_evaluations =
            Fr::zero_array::<{ crate::types::NUMBER_OF_ENTITIES }>(&env);
        for (i, eval) in purported_evaluations.iter_mut().enumerate() {
            *eval = Fr::from_u64(&env, i as u64);
        }

        let rp = RelationParameters {
            eta: Fr::from_u64(&env, 100),
            eta_two: Fr::from_u64(&env, 101),
            eta_three: Fr::from_u64(&env, 102),
            beta: Fr::from_u64(&env, 103),
            gamma: Fr::from_u64(&env, 104),
            public_inputs_delta: Fr::from_u64(&env, 105),
        };

        let mut alphas = Fr::zero_array::<{ crate::types::NUMBER_OF_ALPHAS }>(&env);
        for (i, alpha) in alphas.iter_mut().enumerate() {
            *alpha = Fr::from_u64(&env, (200 + i) as u64);
        }

        let pow_partial_eval = Fr::from_u64(&env, 300);

        let result = accumulate_relation_evaluations(
            &env,
            &purported_evaluations,
            &rp,
            &alphas,
            pow_partial_eval,
        );

        assert_eq!(
            result.to_bytes(),
            crate::debug::hex_to_bytes(
                // Independent integer-field evaluation of the matching BB5
                // Solidity formulas; distinct weights catch relation ordering.
                "16c10ccac193c531ddee831660e6c80653be8e4e3e3e5daf53661fa02a2ba04c"
            )
        );
    }

    fn parameters(env: &Env) -> RelationParameters {
        RelationParameters {
            eta: Fr::from_u64(env, 100),
            eta_two: Fr::from_u64(env, 101),
            eta_three: Fr::from_u64(env, 102),
            beta: Fr::from_u64(env, 2),
            gamma: Fr::from_u64(env, 3),
            public_inputs_delta: Fr::one(env),
        }
    }

    #[test]
    fn test_permutation_enforces_both_boundaries() {
        let env = Env::default();
        let mut p = Fr::zero_array::<{ crate::types::NUMBER_OF_ENTITIES }>(&env);
        p[Wire::LagrangeFirst.index()] = Fr::from_u64(&env, 2);
        p[Wire::ZPerm.index()] = Fr::from_u64(&env, 3);
        p[Wire::LagrangeLast.index()] = Fr::from_u64(&env, 5);
        p[Wire::ZPermShift.index()] = Fr::from_u64(&env, 11);
        let mut e = Fr::zero_array::<NUMBER_OF_SUBRELATIONS>(&env);
        accumulate_permutation_relation(&p, &parameters(&env), &mut e, &Fr::from_u64(&env, 7));
        assert_eq!(e[1], Fr::from_u64(&env, 385));
        assert_eq!(e[2], Fr::from_u64(&env, 42));
    }

    #[test]
    fn test_lookup_uses_beta_and_enforces_read_tag_boolean() {
        let env = Env::default();
        let mut p = Fr::zero_array::<{ crate::types::NUMBER_OF_ENTITIES }>(&env);
        for wire in [
            Wire::Table2,
            Wire::Table3,
            Wire::Table4,
            Wire::Wl,
            Wire::QLookup,
        ] {
            p[wire.index()] = Fr::one(&env);
        }
        p[Wire::Wr.index()] = Fr::from_u64(&env, 2);
        p[Wire::Wo.index()] = Fr::from_u64(&env, 3);
        p[Wire::Qo.index()] = Fr::from_u64(&env, 4);
        p[Wire::LookupInverses.index()] = Fr::from_u64(&env, 5);
        p[Wire::LookupReadTags.index()] = Fr::from_u64(&env, 2);
        p[Wire::LookupReadCounts.index()] = Fr::from_u64(&env, 3);
        let mut e = Fr::zero_array::<NUMBER_OF_SUBRELATIONS>(&env);
        accumulate_log_derivative_lookup_relation(
            &p,
            &parameters(&env),
            &mut e,
            &Fr::from_u64(&env, 7),
        );
        // write = 17, read = 52, inverse_exists = 1. The global
        // log-derivative identity (index 4) deliberately is NOT scaled by 7.
        assert_eq!(e[3], Fr::from_u64(&env, 30_933));
        assert_eq!(e[4], -Fr::from_u64(&env, 695));
        assert_eq!(e[5], Fr::from_u64(&env, 14));
    }

    #[test]
    fn test_memory_uses_qo_and_is_independent_of_nnf() {
        let env = Env::default();
        let mut p = Fr::zero_array::<{ crate::types::NUMBER_OF_ENTITIES }>(&env);
        p[Wire::W4.index()] = Fr::from_u64(&env, 2);
        p[Wire::W4Shift.index()] = Fr::from_u64(&env, 3);
        p[Wire::Qo.index()] = Fr::from_u64(&env, 5);
        p[Wire::QMemory.index()] = Fr::from_u64(&env, 7);
        // QArith and QNnf remain zero: neither may disable a memory relation.
        let mut e = Fr::zero_array::<NUMBER_OF_SUBRELATIONS>(&env);
        let domain = Fr::from_u64(&env, 11);
        accumulate_memory_relation(&env, &p, &parameters(&env), &mut e, &domain);
        accumulate_non_native_field_relation(&env, &p, &mut e, &domain);
        assert_eq!(e[14], Fr::from_u64(&env, 770));
        assert_eq!(e[19], Fr::from_u64(&env, 2_310));
        assert_eq!(e[20], Fr::zero(&env));
        p[Wire::QMemory.index()] = Fr::zero(&env);
        accumulate_memory_relation(&env, &p, &parameters(&env), &mut e, &domain);
        assert!(e[14..20].iter().all(Fr::is_zero));
    }

    #[test]
    fn test_nnf_uses_its_own_selector() {
        let env = Env::default();
        let mut p = Fr::zero_array::<{ crate::types::NUMBER_OF_ENTITIES }>(&env);
        for (wire, value) in [
            (Wire::Wl, 2),
            (Wire::Wr, 3),
            (Wire::Wo, 5),
            (Wire::W4, 4),
            (Wire::WlShift, 7),
            (Wire::WrShift, 11),
            (Wire::WoShift, 23),
            (Wire::W4Shift, 13),
            (Wire::Qr, 2),
            (Wire::Q4, 3),
            (Wire::QNnf, 13),
        ] {
            p[wire.index()] = Fr::from_u64(&env, value);
        }
        let mut e = Fr::zero_array::<NUMBER_OF_SUBRELATIONS>(&env);
        accumulate_non_native_field_relation(&env, &p, &mut e, &Fr::from_u64(&env, 17));
        // gate_2 = (0 * 2^68 - 13 + 43) * 3; then QR * QNNF * domain.
        assert_eq!(e[20], Fr::from_u64(&env, 39_780));
        p[Wire::QNnf.index()] = Fr::zero(&env);
        accumulate_non_native_field_relation(&env, &p, &mut e, &Fr::from_u64(&env, 17));
        assert_eq!(e[20], Fr::zero(&env));
    }
}
