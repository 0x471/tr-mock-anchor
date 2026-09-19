//! Shplemini batch-opening verifier (Gemini + Shplonk + KZG) for BN254.
//!
//! Verifies the polynomial commitment scheme opening by constructing a single
//! MSM that accumulates unshifted/shifted claims, Gemini fold evaluations, and
//! the constant term, then performs a BN254 pairing check.
//!
//! Pinned target: official ZKPassport 0.20.0 `OuterCount5.sol`, BB5 non-ZK
//! Keccak outer proof. The pinned format is unpadded and has 41 entities.
//! This verifies the outer PCS opening; the caller must ALSO complete the
//! recursive pairing accumulator bound into the proof's public inputs.

use crate::ec::{g1_msm, pairing_check};
use crate::field::{batch_inverse, Fr};
use crate::trace;
use crate::types::{
    G1Point, Proof, Transcript, VerificationKey, Wire, CONST_PROOF_SIZE_LOG_N, NUMBER_OF_ENTITIES,
    NUMBER_UNSHIFTED,
};
use core::array::repeat;
use core::ops::Neg;
use soroban_sdk::Env;

/// Verify the Shplemini batch-opening claim.
///
/// High-level flow (matching BB):
/// 1. Compute powers of Gemini evaluation challenge `r^{2^i}`.
/// 2. Batch-invert all Shplonk/Gemini denominators (`z +/- r^{2^j}`, fold-round
///    denominators, and `r` itself).
/// 3. Compute Shplonk scalar weights for unshifted and shifted polynomial batches.
/// 4. Accumulate batched multilinear evaluation `sum rho^i*eval_i`.
/// 5. Load VK + proof commitments into MSM arrays (shifted scalars merged into
///    unshifted counterparts to match BB's `remove_repeated_commitments`).
/// 6. Reconstruct positive Gemini fold evaluations `A_j(r^{2^j})`.
/// 7. Accumulate constant term and fold-round MSM scalars.
/// 8. Add generator (with constant-term scalar) and KZG quotient (with scalar `z`).
/// 9. Single MSM + pairing check.
///
/// BB: `commitment_schemes/shplonk/shplemini.hpp::ShpleminiVerifier_::compute_batch_opening_claim`
pub fn verify_shplemini(
    env: &Env,
    proof: &Proof,
    vk: &VerificationKey,
    tp: &Transcript,
) -> Result<(), &'static str> {
    let log_n = vk.log_circuit_size as usize;
    if log_n != CONST_PROOF_SIZE_LOG_N {
        return Err("shplemini: unsupported log_circuit_size");
    }

    // 1) r^{2^i}
    let one = Fr::one(env);
    let two = Fr::from_u64(env, 2);
    let mut r_pows = Fr::zero_array::<CONST_PROOF_SIZE_LOG_N>(env);
    r_pows[0] = tp.gemini_r.clone();
    for i in 1..log_n {
        r_pows[i] = &r_pows[i - 1] * &r_pows[i - 1];
    }

    // We need the following inversions:
    //   - (z - r^0), (z + r^0)          for shplonk weights (pos0, neg0)
    //   - gemini_r                       for shifted weight
    //   - (r^j*(1-u_j) + u_j)           for j in 1..=log_n  (fold round denoms)
    //   - (z - r^j), (z + r^j)          for j in 1..log_n   (further folding)
    //
    // Total: 2 + 1 + log_n + 2*(log_n - 1) = 3*log_n + 1 values.

    // Collect all values to invert into a flat array.
    // Layout:
    //   [0]           = z - r^0
    //   [1]           = z + r^0
    //   [2]           = gemini_r
    //   [3 .. 3+log_n)  = fold round denominators (j = log_n down to 1)
    //   [3+log_n .. 3+log_n + 2*(log_n-1))  = pairs (z - r^j, z + r^j) for j=1..log_n
    // Max batch size: 3*CONST_PROOF_SIZE_LOG_N + 1 (upper bound when log_n == CONST_PROOF_SIZE_LOG_N)
    const MAX_BATCH: usize = 3 * CONST_PROOF_SIZE_LOG_N + 1;
    let batch_size = 3 + log_n + 2 * (log_n - 1);
    let mut to_invert = Fr::zero_array::<MAX_BATCH>(env);
    let mut inverted = Fr::zero_array::<MAX_BATCH>(env);

    to_invert[0] = &tp.shplonk_z - &r_pows[0];
    to_invert[1] = &tp.shplonk_z + &r_pows[0];
    to_invert[2] = tp.gemini_r.clone();

    // fold round denominators: r^j * (1 - u_j) + u_j, for j = log_n down to 1
    for j in (1..=log_n).rev() {
        let u = &tp.sumcheck_u_challenges[j - 1];
        to_invert[3 + (log_n - j)] = &r_pows[j - 1] * &(&one - u) + u;
    }

    // further folding denominators: (z - r^j) and (z + r^j) for j = 1..log_n
    let further_base = 3 + log_n;
    for j in 1..log_n {
        to_invert[further_base + 2 * (j - 1)] = &tp.shplonk_z - &r_pows[j];
        to_invert[further_base + 2 * (j - 1) + 1] = &tp.shplonk_z + &r_pows[j];
    }

    batch_inverse(&to_invert[..batch_size], &mut inverted[..batch_size]).map_err(|_| {
        "shplemini: batch inversion failed (zero denominator in shplonk/gemini/fold)"
    })?;

    // Defense-in-depth: ensure no inverted result is zero before use.
    if inverted[..batch_size.min(inverted.len())]
        .iter()
        .any(|x| x.is_zero())
    {
        return Err("shplemini: batch inversion produced zero result");
    }

    let pos0 = inverted[0].clone();
    let neg0 = inverted[1].clone();
    let gemini_r_inv = inverted[2].clone();

    // Deduplicated layout: shifted commitments merged into unshifted counterparts.
    // Layout:
    //   [0]                 = shplonk_Q
    //   [1..=28]            = VK precomputed, in BB5 evaluation order
    //   [29..=33]           = w1,w2,w3,w4,z_perm (merged shifted scalars)
    //   [34..=36]           = lookup_inverses, read_counts, read_tags
    //   [37..37+log_n-1)    = Gemini fold commitments
    //   [36+log_n]          = generator with const_acc scalar
    //   [37+log_n]          = kzg_quotient with scalar z
    const TOTAL: usize = 1 + NUMBER_UNSHIFTED + CONST_PROOF_SIZE_LOG_N + 1;
    trace!("total = {}", TOTAL);
    let mut scalars = Fr::zero_array::<TOTAL>(env);
    let mut coms = repeat::<G1Point, TOTAL>(G1Point::infinity(env));

    // 3) compute shplonk weights
    let unshifted = &tp.shplonk_nu * &neg0 + &pos0;
    let shifted = gemini_r_inv * (&pos0 - &(&tp.shplonk_nu * &neg0));
    let neg_unshifted = -&unshifted;
    let neg_shifted = -&shifted;
    // 4) shplonk_Q
    scalars[0] = one.clone();
    coms[0] = proof.shplonk_q.clone();

    // 5) weight sumcheck evals
    let mut rho_pow = one.clone();
    let mut eval_acc = Fr::zero(env);
    let mut eval_scalars = Fr::zero_array::<NUMBER_OF_ENTITIES>(env);
    for (idx, eval) in proof
        .sumcheck_evaluations
        .iter()
        .take(NUMBER_OF_ENTITIES)
        .enumerate()
    {
        let scalar = if idx < NUMBER_UNSHIFTED {
            neg_unshifted.clone()
        } else {
            neg_shifted.clone()
        } * &rho_pow;
        eval_scalars[idx] = scalar;
        eval_acc = eval_acc + &(eval * &rho_pow);
        rho_pow = rho_pow * &tp.rho;
    }

    // Merge shifted scalars into their unshifted counterparts:
    // The same commitments occur in both batches, so their MSM coefficients
    // can be added. Use named BB5 indices rather than the old 40-entity offsets.
    for (unshifted, shifted) in [
        (Wire::Wl, Wire::WlShift),
        (Wire::Wr, Wire::WrShift),
        (Wire::Wo, Wire::WoShift),
        (Wire::W4, Wire::W4Shift),
        (Wire::ZPerm, Wire::ZPermShift),
    ] {
        eval_scalars[unshifted.index()] =
            &eval_scalars[unshifted.index()] + &eval_scalars[shifted.index()];
    }

    // 6) load VK & proof (deduplicated: shifted commitments merged into unshifted)
    {
        let mut j = 1;
        macro_rules! push_vk {
            ($($field:ident),+ $(,)?) => {
                $(
                    coms[j] = vk.$field.clone();
                    scalars[j] = eval_scalars[j - 1].clone();
                    j += 1;
                )+
            };
        }
        push_vk![
            s1,
            s2,
            s3,
            s4,
            id1,
            id2,
            id3,
            id4,
            lagrange_first,
            lagrange_last,
            q_lookup,
            t1,
            t2,
            t3,
            t4,
            qm,
            qr,
            qo,
            qc,
            ql,
            q4,
            q_arith,
            q_delta_range,
            q_elliptic,
            q_memory,
            q_nnf,
            q_poseidon2_external,
            q_poseidon2_internal
        ];

        coms[j] = proof.w1.clone();
        scalars[j] = eval_scalars[Wire::Wl.index()].clone();
        j += 1;
        coms[j] = proof.w2.clone();
        scalars[j] = eval_scalars[Wire::Wr.index()].clone();
        j += 1;
        coms[j] = proof.w3.clone();
        scalars[j] = eval_scalars[Wire::Wo.index()].clone();
        j += 1;
        coms[j] = proof.w4.clone();
        scalars[j] = eval_scalars[Wire::W4.index()].clone();
        j += 1;
        coms[j] = proof.z_perm.clone();
        scalars[j] = eval_scalars[Wire::ZPerm.index()].clone();
        j += 1;
        coms[j] = proof.lookup_inverses.clone();
        scalars[j] = eval_scalars[Wire::LookupInverses.index()].clone();
        j += 1;
        coms[j] = proof.lookup_read_counts.clone();
        scalars[j] = eval_scalars[Wire::LookupReadCounts.index()].clone();
        j += 1;
        coms[j] = proof.lookup_read_tags.clone();
        scalars[j] = eval_scalars[Wire::LookupReadTags.index()].clone();
        j += 1;
        debug_assert_eq!(j, 1 + NUMBER_UNSHIFTED);
    }

    // 7) folding rounds - use batch-inverted denominators
    let mut fold_pos = Fr::zero_array::<CONST_PROOF_SIZE_LOG_N>(env);
    let mut cur = eval_acc;
    for j in (1..=log_n).rev() {
        let r2 = &r_pows[j - 1];
        let u = &tp.sumcheck_u_challenges[j - 1];
        let fold_lin = r2 * &(&one - u) - u;
        let num = r2 * &cur * &two - &(&proof.gemini_a_evaluations[j - 1] * &fold_lin);
        let den_inv = inverted[3 + (log_n - j)].clone();
        cur = num * &den_inv;
        fold_pos[j - 1] = cur.clone();
    }
    // 8) accumulate constant term
    let nu_sq = &tp.shplonk_nu * &tp.shplonk_nu;
    let mut const_acc =
        &fold_pos[0] * &pos0 + &(&proof.gemini_a_evaluations[0] * &tp.shplonk_nu * &neg0);
    let mut v_pow = nu_sq.clone();
    // 9) further folding + commit - use batch-inverted denominators
    // Base index where fold commitments start
    let base = 1 + NUMBER_UNSHIFTED;
    for j in 1..log_n {
        let pos_inv = inverted[further_base + 2 * (j - 1)].clone();
        let neg_inv = inverted[further_base + 2 * (j - 1) + 1].clone();
        let sp = &v_pow * &pos_inv;
        let sn = &v_pow * &tp.shplonk_nu * &neg_inv;

        scalars[base + j - 1] = -(&sp + &sn);
        const_acc = const_acc + &(&proof.gemini_a_evaluations[j] * &sn) + &(&fold_pos[j] * &sp);

        v_pow = v_pow * &nu_sq;

        coms[base + j - 1] = proof.gemini_fold_comms[j - 1].clone();
    }

    // 10) add generator
    // Unpadded BB5: the generator immediately follows the log_n - 1 folds.
    let one_idx = base + (log_n - 1);
    trace!("one_idx = {}", one_idx);
    coms[one_idx] = G1Point::generator(env);
    scalars[one_idx] = const_acc;

    // 11) add quotient
    let q_idx = one_idx + 1;
    trace!("q_idx = {}", q_idx);
    coms[q_idx] = proof.kzg_quotient.clone();
    scalars[q_idx] = tp.shplonk_z.clone();

    // 12) MSM + pairing
    let p0 = g1_msm(env, &coms, &scalars)?;
    let p1 = proof.kzg_quotient.0.clone().neg();
    if pairing_check(env, &p0, &p1) {
        Ok(())
    } else {
        Err("Shplonk pairing check failed")
    }
}
