extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger},
    vec, xdr, TryFromVal,
};
use std::rc::Rc;

#[contract]
struct FakeVerifier;

#[contractimpl]
impl FakeVerifier {
    pub fn __constructor(env: Env, count: u32) {
        env.storage()
            .instance()
            .set(&symbol_short!("count"), &count);
    }
    pub fn profile(env: Env) -> VerificationProfile {
        let count: u32 = env
            .storage()
            .instance()
            .get(&symbol_short!("count"))
            .unwrap();
        VerificationProfile {
            vk_hash: BytesN::from_array(&env, &[7; 32]),
            external_inputs: count,
            proof_bytes: if count == 10 { 9888 } else { 10240 },
            log_n: if count == 10 { 22 } else { 23 },
        }
    }
    pub fn verify(_env: Env, proof: Bytes, _public_inputs: Bytes) -> bool {
        proof.get(0) == Some(1)
    }
}

struct Fixture {
    env: Env,
    gate: Address,
    config: Config,
    recipient: Address,
    recipient_id: xdr::AccountId,
    asset: xdr::Asset,
}

fn register_gate(env: &Env, config: Config) -> Address {
    let address = Address::generate(env);
    match std::env::var("ANCHOR_GATE_WASM") {
        Ok(path) => {
            let wasm = std::fs::read(path).expect("read explicitly selected gate Wasm");
            env.register_at(&address, wasm.as_slice(), (config,))
        }
        Err(_) => env.register_at(&address, AnchorGate, (config,)),
    }
}

fn account_fixture(env: &Env, seed: u8) -> (Address, xdr::AccountId) {
    let account_id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(
        [seed; 32],
    )));
    let key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
        account_id: account_id.clone(),
    }));
    let entry = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
            account_id: account_id.clone(),
            balance: 1_000_000_000,
            flags: 0,
            home_domain: Default::default(),
            inflation_dest: None,
            num_sub_entries: 1,
            seq_num: xdr::SequenceNumber(0),
            thresholds: xdr::Thresholds([1; 4]),
            signers: xdr::VecM::default(),
            ext: xdr::AccountEntryExt::V0,
        }),
        last_modified_ledger_seq: 1,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&key, &entry, None).unwrap();
    (
        Address::try_from_val(env, &xdr::ScAddress::Account(account_id.clone())).unwrap(),
        account_id,
    )
}

fn trustline_fixture(env: &Env, id: &xdr::AccountId, asset: &xdr::Asset, balance: i64) {
    let xdr::Asset::CreditAlphanum4(a) = asset else {
        panic!("expected credit asset");
    };
    let tl_asset = xdr::TrustLineAsset::CreditAlphanum4(a.clone());
    let key = Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
        account_id: id.clone(),
        asset: tl_asset.clone(),
    }));
    let entry = Rc::new(xdr::LedgerEntry {
        data: xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
            account_id: id.clone(),
            asset: tl_asset,
            balance,
            limit: i64::MAX,
            flags: 1,
            ext: xdr::TrustLineEntryExt::V0,
        }),
        last_modified_ledger_seq: 1,
        ext: xdr::LedgerEntryExt::V0,
    });
    env.host().add_ledger_entry(&key, &entry, None).unwrap();
}

impl Fixture {
    fn new() -> Self {
        Self::countries(false, false)
    }
    fn countries(nationality: bool, issuer: bool) -> Self {
        Self::policy(nationality, issuer, None)
    }
    fn policy(nationality: bool, issuer: bool, sanctions: Option<bool>) -> Self {
        let env = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        env.mock_all_auths();
        let network = env
            .crypto()
            .sha256(&Bytes::from_slice(
                &env,
                b"Test SDF Network ; September 2015",
            ))
            .to_bytes();
        env.ledger().with_mut(|l| {
            l.timestamp = 1000;
            l.network_id = network.to_array();
        });
        let (provider, provider_id) = account_fixture(&env, 1);
        let (notary, _) = account_fixture(&env, 2);
        let (recipient, recipient_id) = account_fixture(&env, 3);
        let asset = env.register_stellar_asset_contract_v2(Address::generate(&env));
        trustline_fixture(&env, &provider_id, &asset.asset(), 1_000_000);
        trustline_fixture(&env, &recipient_id, &asset.asset(), 0);
        let count =
            10 + u32::from(nationality) + u32::from(issuer) + u32::from(sanctions.is_some());
        let verifier = env.register(FakeVerifier, (count,));
        let Some(Executable::Wasm(wasm_hash)) = verifier.executable() else {
            panic!("fake executable");
        };
        let config = Config {
            provider,
            bank_notary: notary,
            token: asset.address(),
            verifier,
            verifier_wasm_hash: wasm_hash,
            verifier_vk_hash: BytesN::from_array(&env, &[7; 32]),
            network_id: network,
            certificate_root: BytesN::from_array(&env, &[1; 32]),
            circuit_root: BytesN::from_array(&env, &[2; 32]),
            domain: String::from_str(&env, "localhost"),
            scope: String::from_str(&env, "anchor-test"),
            min_age: 18,
            allowed_nationalities: if nationality {
                vec![
                    &env,
                    BytesN::from_array(&env, b"GBR"),
                    BytesN::from_array(&env, b"USA"),
                ]
            } else {
                Vec::new(&env)
            },
            allowed_issuers: if issuer {
                vec![
                    &env,
                    BytesN::from_array(&env, b"GBR"),
                    BytesN::from_array(&env, b"USA"),
                ]
            } else {
                Vec::new(&env)
            },
            proof_bytes: if count == 10 { 9888 } else { 10240 },
            sanctions_root: BytesN::from_array(
                &env,
                &[if sanctions.is_some() { 3 } else { 0 }; 32],
            ),
            sanctions_strict: sanctions.unwrap_or(false),
            external_inputs: count,
            max_proof_age: 300,
            policy_valid_until: 2000,
            max_order_lifetime: 900,
            max_amount: 100_000,
            max_try_minor: 100_000,
        };
        let gate = register_gate(&env, config.clone());
        Self {
            env,
            gate,
            config,
            recipient,
            recipient_id,
            asset: asset.asset(),
        }
    }
    fn client(&self) -> AnchorGateClient<'_> {
        AnchorGateClient::new(&self.env, &self.gate)
    }
    fn id(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }
    fn terms(&self) -> OrderTerms {
        OrderTerms {
            direction: Direction::Deposit,
            bank_destination_hash: self.id(0),
            recipient: self.recipient.clone(),
            quote_hash: self.id(4),
            try_minor: 1000,
            amount: 500,
            deadline: 1800,
            nonce: self.id(5),
        }
    }
    fn proof(&self, valid: bool) -> Bytes {
        let mut proof = Bytes::from_slice(&self.env, &[0; 10240]).slice(..self.config.proof_bytes);
        proof.set(0, u8::from(valid));
        proof
    }
    fn inputs(&self, id: &BytesN<32>) -> Bytes {
        let challenge = self.client().get_challenge(id).to_array();
        let mut bind = [0u8; 512];
        bind[..6].copy_from_slice(&[8, 1, 253, 3, 0, 64]);
        for (i, byte) in challenge.iter().enumerate() {
            bind[6 + i * 2] = b"0123456789abcdef"[(byte >> 4) as usize];
            bind[7 + i * 2] = b"0123456789abcdef"[(byte & 15) as usize];
        }
        let hash31 = |bytes: &[u8]| {
            let hash = self
                .env
                .crypto()
                .sha256(&Bytes::from_slice(&self.env, bytes))
                .to_array();
            let mut value = [0; 32];
            value[1..].copy_from_slice(&hash[..31]);
            value
        };
        let mut time = [0; 32];
        time[24..].copy_from_slice(&1000u64.to_be_bytes());
        let mut kind = [0; 32];
        kind[31] = 2;
        let mut nullifier = [0; 32];
        nullifier[31] = 1;
        let age = [
            0, 251, 195, 81, 158, 181, 97, 55, 57, 77, 127, 14, 105, 122, 227, 196, 9, 7, 208, 221,
            70, 112, 209, 86, 134, 108, 255, 160, 127, 244, 152, 105,
        ];
        let fields = [
            self.config.certificate_root.to_array(),
            self.config.circuit_root.to_array(),
            time,
            hash31(b"localhost"),
            hash31(b"anchor-test"),
            age,
            hash31(&bind),
        ];
        let mut result = Bytes::new(&self.env);
        for f in fields {
            result.extend_from_array(&f);
        }
        // Independent official SDK golden vectors for the ordered ['GBR', 'USA'] list.
        if !self.config.allowed_nationalities.is_empty() {
            result.append(&hex_bytes(
                &self.env,
                "000b6e1544d358a43d6b1d8ffd0710f4641604d87970a78f64d0e76e1516dbb2",
            ));
        }
        if !self.config.allowed_issuers.is_empty() {
            result.append(&hex_bytes(
                &self.env,
                "00ba10739c274dd1c234bc86780ac3c0b0e4da1b19842b577b6ef856b987650b",
            ));
        }
        if self.config.sanctions_root != self.id(0) {
            result.append(&hex_bytes(
                &self.env,
                if self.config.sanctions_strict {
                    "00347ed9e64d44d11afa900d8c2e73c1429f68154c2f86df7ecb81317763f7bc"
                } else {
                    "006b928647f3261ac4109ef5703bb20772873c1f7bd089134d03d2032499d197"
                },
            ));
        }
        for f in [kind, nullifier, [0; 32]] {
            result.extend_from_array(&f);
        }
        result
    }
    fn receipt(&self) -> BankReceipt {
        BankReceipt {
            bank_destination_hash: self.id(0),
            event_id: self.id(11),
            quote_hash: self.terms().quote_hash,
            try_minor: 1000,
            received_at: 1000,
        }
    }
    fn eligible(&self, id: &BytesN<32>) {
        self.client().create_order(id, &self.terms());
        self.client()
            .prove_order(id, &self.proof(true), &self.inputs(id));
    }
    fn withdrawal_terms(&self) -> OrderTerms {
        let mut terms = self.terms();
        terms.direction = Direction::Withdrawal;
        terms.bank_destination_hash = self.id(20);
        terms
    }
    fn withdrawal_eligible(&self, id: &BytesN<32>) {
        trustline_fixture(&self.env, &self.recipient_id, &self.asset, 1000);
        self.client().create_order(id, &self.withdrawal_terms());
        self.client()
            .prove_order(id, &self.proof(true), &self.inputs(id));
    }
}

fn hex_bytes(env: &Env, value: &str) -> Bytes {
    assert_eq!(value.len() % 2, 0);
    assert!(value.bytes().all(|b| b.is_ascii_hexdigit()));
    let mut bytes = Bytes::new(env);
    for pair in value.as_bytes().chunks_exact(2) {
        let digit = |b: u8| {
            if b <= b'9' {
                b - b'0'
            } else {
                b.to_ascii_lowercase() - b'a' + 10
            }
        };
        bytes.push_back(digit(pair[0]) * 16 + digit(pair[1]));
    }
    bytes
}

// Policy/state tests use a fake external verifier, not evidence of cryptographic validity.
#[test]
fn constructor_exposes_immutable_mock_only_policy() {
    let f = Fixture::new();
    assert_eq!(f.client().get_config(), f.config);
    assert_eq!(f.client().get_total_reserved(), 0);
}

#[test]
fn creating_an_order_reserves_exact_tokens_and_retry_does_not_double_reserve() {
    let f = Fixture::new();
    let c = f.client();
    let order = c.create_order(&f.id(10), &f.terms());
    assert_eq!(order.created_at, 1000);
    assert_eq!(c.get_order(&f.id(10)), Some(order.clone()));
    assert_eq!(c.create_order(&f.id(10), &f.terms()), order);
    assert_eq!(c.get_total_reserved(), 500);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&f.gate), 500);
    assert_eq!(token.balance(&f.config.provider), 999_500);
}

#[test]
fn bound_native_proof_grants_short_lived_eligibility_not_tokens() {
    let f = Fixture::new();
    let id = f.id(10);
    f.client().create_order(&id, &f.terms());
    let order = f.client().prove_order(&id, &f.proof(true), &f.inputs(&id));
    assert_eq!(
        order.eligibility,
        EligibilityState::Some(Eligibility {
            proof_time: 1000,
            valid_until: 1300
        })
    );
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.recipient),
        0
    );
    assert_eq!(order.receipt, ReceiptState::None);
}

#[test]
fn exact_receipt_allows_one_permissionless_settlement_to_the_bound_recipient() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    c.create_order(&id, &f.terms());
    c.prove_order(&id, &f.proof(true), &f.inputs(&id));
    let receipt = BankReceipt {
        bank_destination_hash: f.id(0),
        event_id: f.id(11),
        quote_hash: f.terms().quote_hash,
        try_minor: 1000,
        received_at: 1000,
    };
    let funded = c.record_receipt(&id, &receipt);
    assert_eq!(funded.receipt, ReceiptState::Some(receipt.clone()));
    assert_eq!(c.record_receipt(&id, &receipt), funded);
    assert_eq!(c.get_total_reserved(), 500);
    f.env.set_auths(&[]);
    let settled = c.settle(&id);
    assert!(settled.settled);
    assert_eq!(c.settle(&id), settled);
    assert_eq!(c.get_total_reserved(), 0);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&f.recipient), 500);
    assert_eq!(token.balance(&f.gate), 0);
}

#[test]
fn provider_recipient_and_bank_require_their_own_authorization() {
    let f = Fixture::new();
    let c = f.client();
    let id = f.id(10);
    f.env.set_auths(&[]);
    assert!(c.try_create_order(&id, &f.terms()).is_err());
    assert_eq!(c.get_order(&id), None);
    f.env.mock_all_auths();
    c.create_order(&id, &f.terms());
    let inputs = f.inputs(&id);
    f.env.set_auths(&[]);
    assert!(c.try_prove_order(&id, &f.proof(true), &inputs).is_err());
    assert_eq!(
        c.get_order(&id).unwrap().eligibility,
        EligibilityState::None
    );
    f.env.mock_all_auths();
    c.prove_order(&id, &f.proof(true), &inputs);
    f.env.set_auths(&[]);
    assert!(c.try_record_receipt(&id, &f.receipt()).is_err());
    assert_eq!(c.get_order(&id).unwrap().receipt, ReceiptState::None);
}

#[test]
fn changed_order_terms_and_out_of_bounds_amounts_never_reserve() {
    let f = Fixture::new();
    let c = f.client();
    let id = f.id(10);
    c.create_order(&id, &f.terms());
    let mut changed = f.terms();
    changed.amount += 1;
    assert_eq!(
        c.try_create_order(&id, &changed),
        Err(Ok(GateError::OrderConflict))
    );
    for amount in [0, -1, 100_001, i128::MAX] {
        changed.amount = amount;
        assert_eq!(
            c.try_create_order(&f.id(12), &changed),
            Err(Ok(GateError::InvalidTerms))
        );
    }
    assert_eq!(c.get_total_reserved(), 500);
}

#[test]
fn failed_native_verification_cannot_grant_eligibility() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    c.create_order(&id, &f.terms());
    assert_eq!(
        c.try_prove_order(&id, &f.proof(false), &f.inputs(&id)),
        Err(Ok(GateError::InvalidProof))
    );
    assert_eq!(
        c.get_order(&id).unwrap().eligibility,
        EligibilityState::None
    );
}

#[test]
fn every_policy_field_and_binding_is_checked_even_when_math_adapter_returns_true() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    c.create_order(&id, &f.terms());
    for index in [0u32, 1, 3, 4, 5, 6, 7, 9] {
        let mut inputs = f.inputs(&id);
        let pos = index * 32 + 31;
        inputs.set(pos, inputs.get(pos).unwrap() ^ 1);
        assert!(
            c.try_prove_order(&id, &f.proof(true), &inputs).is_err(),
            "field {index}"
        );
        assert_eq!(
            c.get_order(&id).unwrap().eligibility,
            EligibilityState::None
        );
    }
    let mut zero_nullifier = f.inputs(&id);
    zero_nullifier.set(8 * 32 + 31, 0);
    assert!(c
        .try_prove_order(&id, &f.proof(true), &zero_nullifier)
        .is_err());
    assert!(c
        .try_prove_order(&id, &f.proof(true).slice(..9887), &f.inputs(&id))
        .is_err());
    assert!(c
        .try_prove_order(&id, &f.proof(true), &f.inputs(&id).slice(..319))
        .is_err());
}

#[test]
fn proof_cannot_move_to_another_order_and_commitments_are_order_independent() {
    let f = Fixture::new();
    let c = f.client();
    c.create_order(&f.id(10), &f.terms());
    c.create_order(&f.id(12), &f.terms());
    let inputs = f.inputs(&f.id(10));
    assert_eq!(
        c.try_prove_order(&f.id(12), &f.proof(true), &inputs),
        Err(Ok(GateError::InvalidBinding))
    );
    let mut reordered = inputs.slice(..160);
    reordered.append(&inputs.slice(192..224));
    reordered.append(&inputs.slice(160..192));
    reordered.append(&inputs.slice(224..));
    c.prove_order(&f.id(10), &f.proof(true), &reordered);
    let mut duplicate = inputs.clone();
    for i in 0..32 {
        duplicate.set(192 + i, inputs.get(160 + i).unwrap());
    }
    assert_eq!(
        c.try_prove_order(&f.id(10), &f.proof(true), &duplicate),
        Err(Ok(GateError::InvalidBinding))
    );
}

#[test]
fn country_inclusion_profiles_match_independent_official_sdk_vectors() {
    for (nationality, issuer) in [(true, false), (false, true), (true, true)] {
        let f = Fixture::countries(nationality, issuer);
        let id = f.id(10);
        let c = f.client();
        c.create_order(&id, &f.terms());
        c.prove_order(&id, &f.proof(true), &f.inputs(&id));
        let mut wrong_country = f.inputs(&id);
        wrong_country.set(7 * 32 + 31, 0);
        assert!(c
            .try_prove_order(&id, &f.proof(true), &wrong_country)
            .is_err());
    }
}

#[test]
fn sanctions_profiles_accept_the_exact_official_sdk_parameter_commitment() {
    for (nationality, issuer) in [(false, false), (true, false), (false, true), (true, true)] {
        for strict in [false, true] {
            let f = Fixture::policy(nationality, issuer, Some(strict));
            let id = f.id(10);
            let c = f.client();
            c.create_order(&id, &f.terms());
            let order = c.prove_order(&id, &f.proof(true), &f.inputs(&id));
            assert!(matches!(order.eligibility, EligibilityState::Some(_)));
        }
    }
}

#[test]
fn constructor_rejects_ambiguous_or_noncanonical_sanctions_roots() {
    let f = Fixture::new();
    let mut disabled_strict = f.config.clone();
    disabled_strict.sanctions_strict = true;
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        register_gate(&f.env, disabled_strict);
    }))
    .is_err());

    let f = Fixture::policy(false, false, Some(true));
    for root in [
        "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
        "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ] {
        let mut invalid = f.config.clone();
        invalid.sanctions_root = hex_bytes(&f.env, root).try_into().unwrap();
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            register_gate(&f.env, invalid);
        }))
        .is_err());
    }
}

#[test]
fn sanctions_policy_rejects_missing_other_root_and_weaker_checks_before_escrow() {
    let f = Fixture::policy(true, true, Some(true));
    let id = f.id(10);
    let c = f.client();
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, 1000);
    c.create_order(&id, &f.withdrawal_terms());
    let inputs = f.inputs(&id);
    let start = 9 * 32;
    for commitment in [
        "006b928647f3261ac4109ef5703bb20772873c1f7bd089134d03d2032499d197",
        "000669df6e408039d2c0fccf7ba6266daa95a98fb0680aafd2d7494cac0a724d",
    ] {
        let mut changed = inputs.slice(..start);
        changed.append(&hex_bytes(&f.env, commitment));
        changed.append(&inputs.slice(start + 32..));
        assert_eq!(
            c.try_prove_order(&id, &f.proof(true), &changed),
            Err(Ok(GateError::InvalidBinding))
        );
    }
    let mut duplicate = inputs.slice(..start);
    duplicate.append(&inputs.slice(5 * 32..6 * 32));
    duplicate.append(&inputs.slice(start + 32..));
    assert_eq!(
        c.try_prove_order(&id, &f.proof(true), &duplicate),
        Err(Ok(GateError::InvalidBinding))
    );
    let mut omitted = inputs.slice(..start);
    omitted.append(&inputs.slice(start + 32..));
    assert_eq!(
        c.try_prove_order(&id, &f.proof(true), &omitted),
        Err(Ok(GateError::InvalidProof))
    );
    let mut extra = inputs.clone();
    extra.extend_from_array(&[0; 32]);
    assert_eq!(
        c.try_prove_order(&id, &f.proof(true), &extra),
        Err(Ok(GateError::InvalidProof))
    );
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&f.recipient), 1000);
    assert_eq!(c.get_total_reserved(), 0);
    assert_eq!(
        c.get_order(&id).unwrap().eligibility,
        EligibilityState::None
    );
    assert_eq!(
        c.try_authorize_payout(&id),
        Err(Ok(GateError::InvalidState))
    );
    let accepted = c.prove_order(&id, &f.proof(true), &inputs);
    assert!(accepted.escrowed);
    assert_eq!(token.balance(&f.recipient), 500);
}

#[test]
fn sanctions_snapshot_root_and_mode_are_bound_to_policy_and_order() {
    let mut f = Fixture::policy(true, true, Some(true));
    let old_policy = f.client().get_policy_hash();
    f.config.sanctions_root = hex_bytes(
        &f.env,
        "2dfcc0ca426d9d8e751bb00fc9ab502bfb081ba8d2ce3f5f94a8f1712b3afca8",
    )
    .try_into()
    .unwrap();
    f.gate = register_gate(&f.env, f.config.clone());
    let c = f.client();
    assert_ne!(old_policy, c.get_policy_hash());
    let id = f.id(10);
    c.create_order(&id, &f.terms());
    let inputs = f.inputs(&id);
    let mut current = inputs.slice(..9 * 32);
    current.append(&hex_bytes(
        &f.env,
        "006f97b7c86e5e666d8a256002ff4f9ca418115bb9a4d13a7161d73896025b3b",
    ));
    current.append(&inputs.slice(10 * 32..));
    assert_eq!(
        c.try_prove_order(&id, &f.proof(true), &inputs),
        Err(Ok(GateError::InvalidBinding))
    );
    c.prove_order(&id, &f.proof(true), &current);
    c.create_order(&f.id(11), &f.terms());
    assert_eq!(
        c.try_prove_order(&f.id(11), &f.proof(true), &current),
        Err(Ok(GateError::InvalidBinding))
    );
    let strict_policy = c.get_policy_hash();
    f.config.sanctions_strict = false;
    let standard_gate = register_gate(&f.env, f.config.clone());
    assert_ne!(
        strict_policy,
        AnchorGateClient::new(&f.env, &standard_gate).get_policy_hash()
    );
}

#[test]
fn receipts_require_prior_eligibility_exact_amount_and_unique_bank_event() {
    let f = Fixture::new();
    let c = f.client();
    let id = f.id(10);
    c.create_order(&id, &f.terms());
    assert_eq!(
        c.try_record_receipt(&id, &f.receipt()),
        Err(Ok(GateError::InvalidState))
    );
    c.prove_order(&id, &f.proof(true), &f.inputs(&id));
    let mut wrong = f.receipt();
    wrong.try_minor += 1;
    assert_eq!(
        c.try_record_receipt(&id, &wrong),
        Err(Ok(GateError::InvalidReceipt))
    );
    c.record_receipt(&id, &f.receipt());
    f.eligible(&f.id(12));
    assert_eq!(
        c.try_record_receipt(&f.id(12), &f.receipt()),
        Err(Ok(GateError::ReceiptUsed))
    );
    assert_eq!(c.get_total_reserved(), 1000);
}

#[test]
fn late_funded_orders_keep_reservation_but_cannot_settle_or_rewrite_deadline() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    f.eligible(&id);
    f.env.ledger().with_mut(|l| l.timestamp = 1800);
    let mut late = f.receipt();
    late.received_at = 1799;
    c.record_receipt(&id, &late);
    assert_eq!(c.try_settle(&id), Err(Ok(GateError::Expired)));
    assert_eq!(
        c.try_prove_order(&id, &f.proof(true), &f.inputs(&id)),
        Err(Ok(GateError::Expired))
    );
    assert_eq!(c.get_total_reserved(), 500);
    assert_eq!(c.get_order(&id).unwrap().receipt, ReceiptState::Some(late));
}

#[test]
fn proof_freshness_excludes_future_preorder_and_exact_expiry_time() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    c.create_order(&id, &f.terms());
    for time in [999u64, 1001, u64::MAX] {
        let mut inputs = f.inputs(&id);
        for (i, b) in time.to_be_bytes().iter().enumerate() {
            inputs.set(2 * 32 + 24 + i as u32, *b);
        }
        assert_eq!(
            c.try_prove_order(&id, &f.proof(true), &inputs),
            Err(Ok(GateError::Expired))
        );
    }
    c.prove_order(&id, &f.proof(true), &f.inputs(&id));
    c.record_receipt(&id, &f.receipt());
    f.env.ledger().with_mut(|l| l.timestamp = 1300);
    assert_eq!(c.try_settle(&id), Err(Ok(GateError::Expired)));
    assert_eq!(c.get_total_reserved(), 500);
}

#[test]
fn public_intent_fixture_for_independent_xdr_vector() {
    use xdr::WriteXdr;
    let f = Fixture::new();
    let id = f.id(10);
    let order = f.client().create_order(&id, &f.terms());
    // Independently constructed with @stellar/stellar-sdk typed ScVal encoding.
    assert_eq!(
        Bytes::from(f.client().get_policy_hash()),
        hex_bytes(
            &f.env,
            "5b3dc60efd43cce7804146f003c4012695079d4cd1feb97c067d985c05e32c2e"
        )
    );
    assert_eq!(
        Bytes::from(f.client().get_challenge(&id)),
        hex_bytes(
            &f.env,
            "d94cf0ae9f41684680d40a9b548b00cc300279023b1f317a1a73e90836a6ada1"
        )
    );
    let config: xdr::ScVal = f.config.clone().try_into().unwrap();
    let order_xdr: xdr::ScVal = order.try_into().unwrap();
    std::println!(
        "CONFIG_XDR={}",
        config.to_xdr_base64(xdr::Limits::none()).unwrap()
    );
    std::println!(
        "ORDER_XDR={}",
        order_xdr.to_xdr_base64(xdr::Limits::none()).unwrap()
    );
    std::println!("GATE={}", f.gate.to_string().to_string());
    std::println!("POLICY_HASH={:?}", f.client().get_policy_hash().to_array());
    std::println!("CHALLENGE={:?}", f.client().get_challenge(&id).to_array());
}

#[test]
fn a_failed_recipient_transfer_rolls_back_settlement_and_keeps_the_receipt() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    f.eligible(&id);
    c.record_receipt(&id, &f.receipt());
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, i64::MAX);
    assert!(c.try_settle(&id).is_err());
    let order = c.get_order(&id).unwrap();
    assert!(!order.settled);
    assert_eq!(order.receipt, ReceiptState::Some(f.receipt()));
    assert_eq!(c.get_total_reserved(), 500);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.gate),
        500
    );
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, 0);
    assert!(c.settle(&id).settled);
}

#[test]
fn fresh_bound_proof_can_refresh_eligibility_without_changing_funded_order_terms() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    f.eligible(&id);
    c.record_receipt(&id, &f.receipt());
    f.env.ledger().with_mut(|l| l.timestamp = 1200);
    let mut fresh = f.inputs(&id);
    for (i, b) in 1200u64.to_be_bytes().iter().enumerate() {
        fresh.set(88 + i as u32, *b);
    }
    let refreshed = c.prove_order(&id, &f.proof(true), &fresh);
    assert_eq!(refreshed.terms, f.terms());
    assert_eq!(refreshed.receipt, ReceiptState::Some(f.receipt()));
    assert_eq!(
        refreshed.eligibility,
        EligibilityState::Some(Eligibility {
            proof_time: 1200,
            valid_until: 1500
        })
    );
}

#[test]
fn constructor_rejects_wrong_network_profile_and_ambiguous_country_rules() {
    let f = Fixture::new();
    let mut cases = std::vec::Vec::new();
    let mut c = f.config.clone();
    c.network_id = f.id(8);
    cases.push(c);
    let mut c = f.config.clone();
    c.verifier_vk_hash = f.id(8);
    cases.push(c);
    let mut c = f.config.clone();
    c.provider = c.bank_notary.clone();
    cases.push(c);
    let mut c = f.config.clone();
    c.policy_valid_until = 1000 + 86401;
    cases.push(c);
    let mut c = f.config.clone();
    c.allowed_issuers = vec![&f.env, BytesN::from_array(&f.env, b"GBR")];
    cases.push(c);
    let mut c = f.config.clone();
    c.allowed_issuers = vec![&f.env, BytesN::from_array(&f.env, b"gbr")];
    cases.push(c);
    let mut c = f.config.clone();
    c.allowed_nationalities = vec![
        &f.env,
        BytesN::from_array(&f.env, b"USA"),
        BytesN::from_array(&f.env, b"GBR"),
    ];
    cases.push(c);
    for invalid in cases {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            register_gate(&f.env, invalid);
        }))
        .is_err());
    }
}

#[test]
fn withdrawal_quote_creation_does_not_take_provider_or_customer_tokens() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    let mut terms = f.terms();
    terms.direction = Direction::Withdrawal;
    terms.bank_destination_hash = f.id(20);
    let order = c.create_order(&id, &terms);
    assert!(!order.escrowed);
    assert_eq!(order.payout, PayoutState::None);
    assert_eq!(c.get_total_reserved(), 0);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&f.config.provider), 1_000_000);
    assert_eq!(token.balance(&f.gate), 0);
    assert_eq!(
        Bytes::from(c.get_challenge(&id)),
        hex_bytes(
            &f.env,
            "9cf810f84bd76726249d9f4ac026f763334876c89ab8059ea1b6eba3267c3ac0"
        )
    );
}

#[test]
fn withdrawal_proof_escrows_once_and_failed_proof_never_debits_the_customer() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, 1000);
    let mut terms = f.terms();
    terms.direction = Direction::Withdrawal;
    terms.bank_destination_hash = f.id(20);
    c.create_order(&id, &terms);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(
        c.try_prove_order(&id, &f.proof(false), &f.inputs(&id)),
        Err(Ok(GateError::InvalidProof))
    );
    assert_eq!(token.balance(&f.recipient), 1000);
    assert_eq!(c.get_total_reserved(), 0);
    let eligible = c.prove_order(&id, &f.proof(true), &f.inputs(&id));
    assert!(eligible.escrowed);
    assert_eq!(token.balance(&f.recipient), 500);
    assert_eq!(c.get_total_reserved(), 500);
    c.prove_order(&id, &f.proof(true), &f.inputs(&id));
    assert_eq!(token.balance(&f.recipient), 500);
    assert_eq!(c.get_total_reserved(), 500);
}

#[test]
fn only_notary_can_authorize_one_eligible_escrowed_withdrawal_obligation() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    c.create_order(&id, &f.withdrawal_terms());
    assert_eq!(
        c.try_authorize_payout(&id),
        Err(Ok(GateError::InvalidState))
    );
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, 1000);
    c.prove_order(&id, &f.proof(true), &f.inputs(&id));
    f.env.set_auths(&[]);
    assert!(c.try_authorize_payout(&id).is_err());
    f.env.mock_all_auths();
    let authorized = c.authorize_payout(&id);
    assert_eq!(authorized.payout, PayoutState::Authorized(1000));
    assert_eq!(c.authorize_payout(&id), authorized);
    assert_eq!(c.get_total_reserved(), 500);
    assert_eq!(
        c.try_prove_order(&id, &f.proof(true), &f.inputs(&id)),
        Err(Ok(GateError::InvalidState))
    );
}

#[test]
fn withdrawal_receipt_requires_authorization_and_destination_then_finalizes_even_if_late() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    f.withdrawal_eligible(&id);
    let mut receipt = f.receipt();
    receipt.bank_destination_hash = f.id(20);
    assert_eq!(
        c.try_record_receipt(&id, &receipt),
        Err(Ok(GateError::InvalidState))
    );
    c.authorize_payout(&id);
    assert_eq!(
        c.try_record_receipt(&id, &f.receipt()),
        Err(Ok(GateError::InvalidReceipt))
    );
    assert_eq!(c.try_settle(&id), Err(Ok(GateError::InvalidState)));
    f.env.ledger().with_mut(|l| l.timestamp = 2500);
    receipt.received_at = 2400;
    c.record_receipt(&id, &receipt);
    f.env.set_auths(&[]);
    let settled = c.settle(&id);
    assert!(settled.settled);
    assert!(!settled.escrowed);
    assert_eq!(c.settle(&id), settled);
    assert_eq!(c.get_total_reserved(), 0);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&f.recipient), 500);
    assert_eq!(token.balance(&f.config.provider), 1_000_500);
    assert_eq!(token.balance(&f.gate), 0);
}

#[test]
fn withdrawal_escrow_needs_the_recipients_nested_exact_token_transfer_authorization() {
    use soroban_sdk::testutils::MockAuthInvoke;
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, 1000);
    c.create_order(&id, &f.withdrawal_terms());
    let proof = f.proof(true);
    let inputs = f.inputs(&id);
    let args: Vec<Val> = (id.clone(), proof.clone(), inputs.clone()).into_val(&f.env);
    f.env
        .host()
        .set_source_account(f.recipient_id.clone())
        .unwrap();
    f.env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::SourceAccount,
        root_invocation: (&MockAuthInvoke {
            contract: &f.gate,
            fn_name: "prove_order",
            args: args.clone(),
            sub_invokes: &[],
        })
            .into(),
    }]);
    assert!(c.try_prove_order(&id, &proof, &inputs).is_err());
    assert_eq!(c.get_total_reserved(), 0);
    f.env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::SourceAccount,
        root_invocation: (&MockAuthInvoke {
            contract: &f.gate,
            fn_name: "prove_order",
            args,
            sub_invokes: &[MockAuthInvoke {
                contract: &f.config.token,
                fn_name: "transfer",
                args: (f.recipient.clone(), f.gate.clone(), 500i128).into_val(&f.env),
                sub_invokes: &[],
            }],
        })
            .into(),
    }]);
    assert!(c.prove_order(&id, &proof, &inputs).escrowed);
}

#[test]
fn insufficient_customer_tokens_cannot_create_eligibility_or_bank_payout_authority() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    c.create_order(&id, &f.withdrawal_terms());
    assert!(c
        .try_prove_order(&id, &f.proof(true), &f.inputs(&id))
        .is_err());
    let state = c.get_order(&id).unwrap();
    assert_eq!(state.eligibility, EligibilityState::None);
    assert!(!state.escrowed);
    assert_eq!(c.get_total_reserved(), 0);
    assert_eq!(
        c.try_authorize_payout(&id),
        Err(Ok(GateError::InvalidState))
    );
}

#[test]
fn stale_eligibility_cannot_authorize_a_new_withdrawal_obligation() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    f.withdrawal_eligible(&id);
    for time in [1300, 1800, 2500] {
        f.env.ledger().with_mut(|l| l.timestamp = time);
        assert_eq!(c.try_authorize_payout(&id), Err(Ok(GateError::Expired)));
        assert_eq!(c.get_order(&id).unwrap().payout, PayoutState::None);
        assert_eq!(c.get_total_reserved(), 500);
    }
}

#[test]
fn authorized_payout_timestamp_is_stable_and_cannot_cover_earlier_bank_events() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    f.withdrawal_eligible(&id);
    f.env.ledger().with_mut(|l| l.timestamp = 1100);
    let authorized = c.authorize_payout(&id);
    let mut receipt = f.receipt();
    receipt.bank_destination_hash = f.id(20);
    assert_eq!(
        c.try_record_receipt(&id, &receipt),
        Err(Ok(GateError::InvalidReceipt))
    );
    receipt.received_at = 1101;
    assert_eq!(
        c.try_record_receipt(&id, &receipt),
        Err(Ok(GateError::InvalidReceipt))
    );
    f.env.ledger().with_mut(|l| l.timestamp = 2500);
    assert_eq!(c.authorize_payout(&id), authorized);
    assert_eq!(c.get_total_reserved(), 500);
}

#[test]
fn direction_and_bank_destination_are_immutable_and_deposit_cannot_authorize_bank_payout() {
    let f = Fixture::new();
    let id = f.id(10);
    let c = f.client();
    let mut bad_deposit = f.terms();
    bad_deposit.bank_destination_hash = f.id(20);
    assert_eq!(
        c.try_create_order(&id, &bad_deposit),
        Err(Ok(GateError::InvalidTerms))
    );
    let mut bad_withdrawal = f.withdrawal_terms();
    bad_withdrawal.bank_destination_hash = f.id(0);
    assert_eq!(
        c.try_create_order(&id, &bad_withdrawal),
        Err(Ok(GateError::InvalidTerms))
    );
    f.eligible(&id);
    assert_eq!(
        c.try_authorize_payout(&id),
        Err(Ok(GateError::InvalidState))
    );
    assert_eq!(
        c.try_create_order(&id, &f.withdrawal_terms()),
        Err(Ok(GateError::OrderConflict))
    );
    let mut receipt = f.receipt();
    receipt.bank_destination_hash = f.id(20);
    assert_eq!(
        c.try_record_receipt(&id, &receipt),
        Err(Ok(GateError::InvalidReceipt))
    );
    assert_eq!(c.get_total_reserved(), 500);
}

#[test]
fn bank_receipt_ids_cannot_be_reused_across_deposit_and_withdrawal() {
    let f = Fixture::new();
    let deposit = f.id(10);
    let withdrawal = f.id(12);
    let c = f.client();
    f.eligible(&deposit);
    c.record_receipt(&deposit, &f.receipt());
    f.withdrawal_eligible(&withdrawal);
    c.authorize_payout(&withdrawal);
    let mut reused = f.receipt();
    reused.bank_destination_hash = f.id(20);
    assert_eq!(
        c.try_record_receipt(&withdrawal, &reused),
        Err(Ok(GateError::ReceiptUsed))
    );
    assert_eq!(c.get_total_reserved(), 1000);
}
