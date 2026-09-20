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
    pub fn change_count(env: Env, count: u32) {
        env.storage()
            .instance()
            .set(&symbol_short!("count"), &count);
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
    match std::env::var("SEP_ANCHOR_WASM") {
        Ok(path) => {
            let wasm = std::fs::read(path).expect("read explicitly selected gate Wasm");
            env.register_at(&address, wasm.as_slice(), (config,))
        }
        Err(_) => env.register_at(&address, SepAnchor, (config,)),
    }
}

fn account_fixture(env: &Env, seed: u8) -> (Address, xdr::AccountId) {
    let account_id = xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(
        ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .to_bytes(),
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
    fn client(&self) -> SepAnchorClient<'_> {
        SepAnchorClient::new(&self.env, &self.gate)
    }
    fn id(&self, n: u8) -> BytesN<32> {
        BytesN::from_array(&self.env, &[n; 32])
    }
    fn terms(&self) -> OrderTerms {
        OrderTerms {
            subject: self.client().get_subject(&self.recipient),
            refund_to: self.recipient.clone(),
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
}

impl Fixture {
    fn proof(&self, valid: bool) -> Bytes {
        let mut proof = Bytes::from_slice(&self.env, &[0; 10240]).slice(..self.config.proof_bytes);
        proof.set(0, u8::from(valid));
        proof
    }
    fn receipt(&self) -> BankReceipt {
        BankReceipt {
            event_id: self.id(11),
            quote_hash: self.terms().quote_hash,
            try_minor: 1000,
            received_at: 1000,
            bank_destination_hash: self.id(0),
        }
    }
    fn withdrawal_terms(&self) -> OrderTerms {
        let mut terms = self.terms();
        terms.direction = Direction::Withdrawal;
        terms.bank_destination_hash = self.id(20);
        terms
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
// State and authorization tests stub the external verifier; they do not prove cryptographic validity.
#[test]
fn immutable_policy_starts_without_customer_funds() {
    let f = Fixture::new();
    assert_eq!(f.client().get_config(), f.config);
    assert_eq!(f.client().get_total_reserved(), 0);
}

#[test]
fn provider_cannot_reuse_one_customers_grant_for_a_different_recipient_or_refund() {
    let f = Fixture::new();
    let terms = f.terms();
    f.client()
        .submit_eligibility(&terms.subject, &f.proof(true), &f.inputs(&terms.subject));
    let mut changed = terms.clone();
    changed.recipient = f.config.provider.clone();
    assert_eq!(
        f.client().try_create_order(&f.id(1), &changed),
        Err(Ok(GateError::InvalidTerms))
    );
    let mut changed = terms;
    changed.refund_to = f.config.provider.clone();
    assert_eq!(
        f.client().try_create_order(&f.id(1), &changed),
        Err(Ok(GateError::InvalidTerms))
    );
    assert_eq!(f.client().get_order(&f.id(1)), None);
    assert_eq!(f.client().get_total_reserved(), 0);
}

#[test]
fn public_eligibility_challenge_matches_independent_stellar_sdk_xdr() {
    let f = Fixture::new();
    assert_eq!(
        f.recipient.to_string().to_string(),
        "GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG"
    );
    assert_eq!(
        Bytes::from(f.client().get_subject(&f.recipient)),
        hex_bytes(
            &f.env,
            "17b547bbde39190c081d69d7046b8b694ad6a3ff92a02cf267d80e058a9fe986"
        )
    );
    assert_eq!(
        Bytes::from(f.client().get_policy_hash()),
        hex_bytes(
            &f.env,
            "403260ef0c2b847e3ccc64190cef93617790a505817c874ddf280ec0928563d4"
        )
    );
    assert_eq!(
        Bytes::from(
            f.client()
                .get_challenge(&f.client().get_subject(&f.recipient))
        ),
        hex_bytes(
            &f.env,
            "985bb9d7db93eddbd53c72e4c58244ddc55883b29a2d6343e0a5cc8e9b8ebc88"
        )
    );
}

#[test]
fn a_relayed_subject_grant_never_debits_or_extends_a_replayed_proof() {
    let f = Fixture::new();
    let subject = f.id(9);
    f.env.mock_auths(&[]);
    let inputs = f.inputs(&subject);
    let first = f
        .client()
        .submit_eligibility(&subject, &f.proof(true), &inputs);
    assert_eq!(
        first,
        Eligibility {
            proof_time: 1000,
            valid_until: 1300
        }
    );
    f.env.ledger().with_mut(|l| l.timestamp = 1100);
    assert_eq!(
        f.client()
            .submit_eligibility(&subject, &f.proof(true), &inputs),
        first
    );
    assert_eq!(f.client().get_eligibility(&subject), Some(first));
    assert_eq!(f.client().get_eligibility(&f.id(8)), None);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.recipient),
        0
    );
    assert_eq!(f.client().get_total_reserved(), 0);
}

#[test]
fn exact_deposit_reservation_is_idempotent_and_cannot_be_rewritten() {
    let f = Fixture::new();
    let id = f.id(1);
    let order = f.client().create_order(&id, &f.terms());
    assert!(order.escrowed);
    assert_eq!(order.created_at, 1000);
    assert_eq!(f.client().create_order(&id, &f.terms()), order);
    assert_eq!(f.client().get_order(&id), Some(order));
    assert_eq!(f.client().get_total_reserved(), 500);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.config.provider),
        999_500
    );
    let mut changed = f.terms();
    changed.refund_to = f.config.provider.clone();
    assert_eq!(
        f.client().try_create_order(&id, &changed),
        Err(Ok(GateError::OrderConflict))
    );
}

#[test]
fn a_current_subject_grant_and_exact_receipt_release_only_the_reserved_deposit() {
    let f = Fixture::new();
    let id = f.id(1);
    f.client().create_order(&id, &f.terms());
    assert!(f.client().try_settle(&id).is_err());
    f.client().submit_eligibility(
        &f.terms().subject,
        &f.proof(true),
        &f.inputs(&f.terms().subject),
    );
    f.client().record_receipt(&id, &f.receipt());
    f.env.mock_auths(&[]);
    let settled = f.client().settle(&id);
    assert_eq!(settled.settled_at, Some(1000));
    assert!(!settled.escrowed);
    assert_eq!(f.client().settle(&id), settled);
    assert_eq!(f.client().get_total_reserved(), 0);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.recipient),
        500
    );
}

#[test]
fn withdrawal_funding_sweeps_provider_tokens_once_and_deduplicates_operations() {
    let f = Fixture::new();
    let id = f.id(1);
    let order = f.client().create_order(&id, &f.withdrawal_terms());
    assert!(!order.escrowed);
    assert_eq!(f.client().get_total_reserved(), 0);
    let funded = f.client().fund_withdrawal(&id, &f.id(21));
    assert_eq!(
        funded.funding,
        FundingState::Some(Funding {
            operation_id: f.id(21),
            recorded_at: 1000
        })
    );
    assert!(funded.escrowed);
    assert_eq!(f.client().fund_withdrawal(&id, &f.id(21)), funded);
    assert!(f.client().try_fund_withdrawal(&id, &f.id(22)).is_err());
    f.client().create_order(&f.id(2), &f.withdrawal_terms());
    assert_eq!(
        f.client().try_fund_withdrawal(&f.id(2), &f.id(21)),
        Err(Ok(GateError::FundingUsed))
    );
    assert_eq!(f.client().get_total_reserved(), 500);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&f.recipient), 0);
    assert_eq!(token.balance(&f.config.provider), 999_500);
}

#[test]
fn a_withdrawal_obligation_requires_current_eligibility_but_survives_late_bank_evidence() {
    let f = Fixture::new();
    let id = f.id(1);
    let terms = f.withdrawal_terms();
    f.client().create_order(&id, &terms);
    f.client().fund_withdrawal(&id, &f.id(21));
    assert!(f.client().try_authorize_payout(&id).is_err());
    f.client()
        .submit_eligibility(&terms.subject, &f.proof(true), &f.inputs(&terms.subject));
    let mut receipt = f.receipt();
    receipt.bank_destination_hash = terms.bank_destination_hash;
    assert!(f.client().try_record_receipt(&id, &receipt).is_err());
    f.env.ledger().with_mut(|l| l.timestamp = 1050);
    let authorized = f.client().authorize_payout(&id);
    assert_eq!(authorized.payout, PayoutState::Authorized(1050));
    assert!(f.client().try_record_receipt(&id, &receipt).is_err());
    f.env.ledger().with_mut(|l| l.timestamp = 2100);
    assert_eq!(f.client().authorize_payout(&id), authorized);
    receipt.received_at = 2100;
    f.client().record_receipt(&id, &receipt);
    let settled = f.client().settle(&id);
    assert_eq!(settled.settled_at, Some(2100));
    assert_eq!(f.client().get_total_reserved(), 0);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.config.provider),
        1_000_000
    );
}

#[test]
fn expired_unapproved_withdrawal_returns_exact_escrow_only_to_fixed_refund_account() {
    let f = Fixture::new();
    let (refund_to, refund_id) = account_fixture(&f.env, 4);
    trustline_fixture(&f.env, &refund_id, &f.asset, 0);
    let mut terms = f.withdrawal_terms();
    terms.recipient = refund_to.clone();
    terms.refund_to = refund_to.clone();
    terms.subject = f.client().get_subject(&refund_to);
    let id = f.id(1);
    f.client().create_order(&id, &terms);
    f.env.ledger().with_mut(|l| l.timestamp = 2100);
    f.client().fund_withdrawal(&id, &f.id(21));
    let refunded = f.client().refund(&id);
    assert_eq!(refunded.refunded_at, Some(2100));
    assert_eq!(refunded.settled_at, None);
    assert!(!refunded.escrowed);
    assert_eq!(f.client().refund(&id), refunded);
    assert!(f.client().try_authorize_payout(&id).is_err());
    assert!(f.client().try_settle(&id).is_err());
    assert_eq!(f.client().get_total_reserved(), 0);
    let token = token::TokenClient::new(&f.env, &f.config.token);
    assert_eq!(token.balance(&refund_to), 500);
    assert_eq!(token.balance(&f.recipient), 0);
}

#[test]
fn cancellation_releases_only_a_deposit_without_a_bank_receipt() {
    let f = Fixture::new();
    f.client().create_order(&f.id(1), &f.terms());
    f.client().create_order(&f.id(2), &f.terms());
    f.client().submit_eligibility(
        &f.terms().subject,
        &f.proof(true),
        &f.inputs(&f.terms().subject),
    );
    f.client().record_receipt(&f.id(2), &f.receipt());
    f.env.ledger().with_mut(|l| l.timestamp = 2100);
    let cancelled = f.client().cancel(&f.id(1));
    assert_eq!(cancelled.cancelled_at, Some(2100));
    assert_eq!(f.client().cancel(&f.id(1)), cancelled);
    assert!(!cancelled.escrowed);
    assert!(f.client().try_cancel(&f.id(2)).is_err());
    assert!(f
        .client()
        .try_record_receipt(&f.id(1), &f.receipt())
        .is_err());
    assert!(f.client().try_settle(&f.id(1)).is_err());
    assert!(f.client().try_refund(&f.id(1)).is_err());
    assert_eq!(f.client().get_total_reserved(), 500);
    assert_eq!(
        token::TokenClient::new(&f.env, &f.config.token).balance(&f.config.provider),
        999_500
    );
}

#[test]
fn subject_roots_country_age_sanctions_and_mock_document_policy_are_all_mandatory() {
    let f = Fixture::policy(true, true, Some(true));
    let subject = f.id(9);
    let inputs = f.inputs(&subject);
    assert_eq!(
        f.client()
            .try_submit_eligibility(&subject, &f.proof(false), &inputs),
        Err(Ok(GateError::InvalidProof))
    );
    for index in 0..f.config.external_inputs {
        let mut bad = inputs.clone();
        let offset = index * 32 + 31;
        bad.set(offset, bad.get(offset).unwrap() ^ 1);
        assert!(
            f.client()
                .try_submit_eligibility(&subject, &f.proof(true), &bad)
                .is_err(),
            "field {index}"
        );
    }
    let mut extra = inputs.clone();
    extra.extend_from_array(&[0; 32]);
    assert!(f
        .client()
        .try_submit_eligibility(&subject, &f.proof(true), &extra)
        .is_err());
    assert!(f
        .client()
        .try_submit_eligibility(&subject, &f.proof(true), &inputs.slice(..inputs.len() - 32))
        .is_err());
    assert!(f
        .client()
        .try_submit_eligibility(&subject, &f.proof(true).slice(..100), &inputs)
        .is_err());
    assert!(f
        .client()
        .try_submit_eligibility(&f.id(8), &f.proof(true), &inputs)
        .is_err());
    assert!(f
        .client()
        .try_submit_eligibility(&f.id(0), &f.proof(true), &inputs)
        .is_err());
    assert_eq!(f.client().get_eligibility(&subject), None);
    f.client()
        .submit_eligibility(&subject, &f.proof(true), &inputs);
}

#[test]
fn a_refresh_is_subject_scoped_and_cannot_be_rolled_back_by_an_older_proof() {
    let f = Fixture::new();
    let subject = f.terms().subject;
    let old = f.inputs(&subject);
    f.client()
        .submit_eligibility(&subject, &f.proof(true), &old);
    f.client().create_order(&f.id(1), &f.terms());
    let mut other = f.terms();
    other.recipient = f.config.provider.clone();
    other.refund_to = f.config.provider.clone();
    other.subject = f.client().get_subject(&f.config.provider);
    f.client().create_order(&f.id(2), &other);
    f.client().record_receipt(&f.id(1), &f.receipt());
    assert!(f
        .client()
        .try_record_receipt(&f.id(2), &f.receipt())
        .is_err());
    f.env.ledger().with_mut(|l| l.timestamp = 1200);
    let mut fresh = old.clone();
    for (i, byte) in 1200u64.to_be_bytes().iter().enumerate() {
        fresh.set(88 + i as u32, *byte);
    }
    let refreshed = f
        .client()
        .submit_eligibility(&subject, &f.proof(true), &fresh);
    assert_eq!(refreshed.valid_until, 1500);
    assert_eq!(
        f.client()
            .submit_eligibility(&subject, &f.proof(true), &old),
        refreshed
    );
    f.env.ledger().with_mut(|l| l.timestamp = 1300);
    assert_eq!(
        f.client()
            .try_submit_eligibility(&subject, &f.proof(true), &old),
        Err(Ok(GateError::Expired))
    );
    assert_eq!(f.client().settle(&f.id(1)).settled_at, Some(1300));
    assert_eq!(f.client().get_eligibility(&f.id(8)), None);
}

#[test]
fn eligibility_expiry_blocks_new_payment_obligations_and_deposit_release() {
    let f = Fixture::new();
    let subject = f.terms().subject;
    f.client()
        .submit_eligibility(&subject, &f.proof(true), &f.inputs(&subject));
    f.client().create_order(&f.id(1), &f.terms());
    f.client().record_receipt(&f.id(1), &f.receipt());
    f.client().create_order(&f.id(2), &f.withdrawal_terms());
    f.client().fund_withdrawal(&f.id(2), &f.id(21));
    f.env.ledger().with_mut(|l| l.timestamp = 1300);
    assert_eq!(f.client().try_settle(&f.id(1)), Err(Ok(GateError::Expired)));
    assert_eq!(
        f.client().try_authorize_payout(&f.id(2)),
        Err(Ok(GateError::Expired))
    );
    assert_eq!(f.client().get_total_reserved(), 1000);
    assert_eq!(
        f.client().get_order(&f.id(2)).unwrap().payout,
        PayoutState::None
    );
}

#[test]
fn payout_authorization_wins_the_refund_race_and_cannot_change_its_timestamp() {
    let f = Fixture::new();
    let terms = f.withdrawal_terms();
    let id = f.id(1);
    f.client()
        .submit_eligibility(&terms.subject, &f.proof(true), &f.inputs(&terms.subject));
    f.client().create_order(&id, &terms);
    f.client().fund_withdrawal(&id, &f.id(21));
    let authorized = f.client().authorize_payout(&id);
    assert!(f.client().try_refund(&id).is_err());
    assert!(f.client().try_cancel(&id).is_err());
    f.env.ledger().with_mut(|l| l.timestamp = 2100);
    assert!(f.client().try_refund(&id).is_err());
    assert_eq!(f.client().authorize_payout(&id), authorized);
    assert_eq!(f.client().get_total_reserved(), 500);
}

#[test]
fn failed_sac_transfers_roll_back_refunds_and_preserve_exact_reservation() {
    let f = Fixture::new();
    let id = f.id(1);
    f.client().create_order(&id, &f.withdrawal_terms());
    let funded = f.client().fund_withdrawal(&id, &f.id(21));
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, i64::MAX);
    assert!(f.client().try_refund(&id).is_err());
    assert_eq!(f.client().get_order(&id), Some(funded));
    assert_eq!(f.client().get_total_reserved(), 500);
    trustline_fixture(&f.env, &f.recipient_id, &f.asset, 0);
    assert_eq!(f.client().refund(&id).refunded_at, Some(1000));
}

#[test]
fn funding_requires_both_custody_roles_and_the_exact_nested_provider_transfer() {
    use soroban_sdk::testutils::MockAuthInvoke;
    let f = Fixture::new();
    let id = f.id(1);
    f.client().create_order(&id, &f.withdrawal_terms());
    let args: Vec<Val> = (id.clone(), f.id(21)).into_val(&f.env);
    let root = MockAuthInvoke {
        contract: &f.gate,
        fn_name: "fund_withdrawal",
        args: args.clone(),
        sub_invokes: &[],
    };
    let provider_invocation = MockAuthInvoke {
        contract: &f.gate,
        fn_name: "fund_withdrawal",
        args,
        sub_invokes: &[MockAuthInvoke {
            contract: &f.config.token,
            fn_name: "transfer",
            args: (f.config.provider.clone(), f.gate.clone(), 500i128).into_val(&f.env),
            sub_invokes: &[],
        }],
    };
    for seed in [1, 2] {
        f.env.set_auths(&[signed_auth(&f.env, seed, &root, 100)]);
        assert!(f.client().try_fund_withdrawal(&id, &f.id(21)).is_err());
        assert_eq!(f.client().get_total_reserved(), 0);
    }
    f.env.set_auths(&[
        signed_auth(&f.env, 1, &root, 100),
        signed_auth(&f.env, 2, &root, 100),
    ]);
    assert!(f.client().try_fund_withdrawal(&id, &f.id(21)).is_err());
    f.env.set_auths(&[
        signed_auth(&f.env, 1, &provider_invocation, 100),
        signed_auth(&f.env, 2, &root, 100),
    ]);
    assert!(f.client().fund_withdrawal(&id, &f.id(21)).escrowed);
}

#[test]
fn recovery_needs_both_roles_and_bank_actions_cannot_be_called_without_notary() {
    use soroban_sdk::testutils::MockAuthInvoke;
    let f = Fixture::new();
    let deposit = f.id(1);
    let withdrawal = f.id(2);
    f.env.set_auths(&[]);
    assert!(f.client().try_create_order(&deposit, &f.terms()).is_err());
    f.env.mock_all_auths();
    f.client().create_order(&deposit, &f.terms());
    f.client().create_order(&withdrawal, &f.withdrawal_terms());
    f.client().fund_withdrawal(&withdrawal, &f.id(21));
    f.client().submit_eligibility(
        &f.terms().subject,
        &f.proof(true),
        &f.inputs(&f.terms().subject),
    );
    f.env.set_auths(&[]);
    assert!(f
        .client()
        .try_record_receipt(&deposit, &f.receipt())
        .is_err());
    assert!(f.client().try_authorize_payout(&withdrawal).is_err());
    for (name, id) in [("cancel", deposit.clone()), ("refund", withdrawal.clone())] {
        let invocation = MockAuthInvoke {
            contract: &f.gate,
            fn_name: name,
            args: (id.clone(),).into_val(&f.env),
            sub_invokes: &[],
        };
        let nonce = if name == "cancel" { 200 } else { 300 };
        for seed in [1, 2] {
            f.env
                .set_auths(&[signed_auth(&f.env, seed, &invocation, nonce)]);
            if name == "cancel" {
                assert!(f.client().try_cancel(&id).is_err());
            } else {
                assert!(f.client().try_refund(&id).is_err());
            }
        }
        f.env.set_auths(&[
            signed_auth(&f.env, 1, &invocation, nonce),
            signed_auth(&f.env, 2, &invocation, nonce),
        ]);
        if name == "cancel" {
            f.client().cancel(&id);
        } else {
            f.client().refund(&id);
        }
    }
    assert_eq!(f.client().get_total_reserved(), 0);
}

#[test]
fn verifier_profile_changes_block_new_eligibility_and_obligations_but_not_recovery() {
    let f = Fixture::new();
    let subject = f.terms().subject;
    let inputs = f.inputs(&subject);
    f.client()
        .submit_eligibility(&subject, &f.proof(true), &inputs);
    f.client().create_order(&f.id(1), &f.terms());
    f.client().create_order(&f.id(2), &f.withdrawal_terms());
    f.client().fund_withdrawal(&f.id(2), &f.id(21));
    f.client().record_receipt(&f.id(1), &f.receipt());
    FakeVerifierClient::new(&f.env, &f.config.verifier).change_count(&11);
    assert_eq!(
        f.client()
            .try_submit_eligibility(&subject, &f.proof(true), &inputs),
        Err(Ok(GateError::WrongVerifier))
    );
    assert_eq!(
        f.client().try_settle(&f.id(1)),
        Err(Ok(GateError::WrongVerifier))
    );
    assert_eq!(
        f.client().try_authorize_payout(&f.id(2)),
        Err(Ok(GateError::WrongVerifier))
    );
    assert_eq!(
        f.client().try_create_order(&f.id(3), &f.terms()),
        Err(Ok(GateError::WrongVerifier))
    );
    assert_eq!(f.client().refund(&f.id(2)).refunded_at, Some(1000));
}

#[test]
fn bank_receipts_bind_amount_quote_destination_time_and_unique_event() {
    let f = Fixture::new();
    let subject = f.terms().subject;
    f.client()
        .submit_eligibility(&subject, &f.proof(true), &f.inputs(&subject));
    f.client().create_order(&f.id(1), &f.terms());
    f.client().create_order(&f.id(2), &f.terms());
    for index in 0..6 {
        let mut receipt = f.receipt();
        match index {
            0 => receipt.try_minor += 1,
            1 => receipt.quote_hash = f.id(8),
            2 => receipt.bank_destination_hash = f.id(8),
            3 => receipt.event_id = f.id(0),
            4 => receipt.received_at = 999,
            _ => receipt.received_at = 1001,
        }
        assert_eq!(
            f.client().try_record_receipt(&f.id(1), &receipt),
            Err(Ok(GateError::InvalidReceipt))
        );
        assert_eq!(
            f.client().get_order(&f.id(1)).unwrap().receipt,
            ReceiptState::None
        );
    }
    let recorded = f.client().record_receipt(&f.id(1), &f.receipt());
    assert_eq!(f.client().record_receipt(&f.id(1), &f.receipt()), recorded);
    assert_eq!(
        f.client().try_record_receipt(&f.id(2), &f.receipt()),
        Err(Ok(GateError::ReceiptUsed))
    );
    assert_eq!(f.client().get_total_reserved(), 1000);
}

#[test]
fn changed_contract_policy_or_network_cannot_reuse_a_subject_proof() {
    let f = Fixture::new();
    let subject = f.terms().subject;
    let inputs = f.inputs(&subject);
    let second = register_gate(&f.env, f.config.clone());
    let client = SepAnchorClient::new(&f.env, &second);
    assert_ne!(
        f.client().get_challenge(&subject),
        client.get_challenge(&subject)
    );
    assert_eq!(
        client.try_submit_eligibility(&subject, &f.proof(true), &inputs),
        Err(Ok(GateError::InvalidBinding))
    );
    let mut changed = f.config.clone();
    changed.scope = String::from_str(&f.env, "different-anchor-policy");
    let other_policy = register_gate(&f.env, changed);
    let client = SepAnchorClient::new(&f.env, &other_policy);
    assert_ne!(f.client().get_policy_hash(), client.get_policy_hash());
    assert!(client
        .try_submit_eligibility(&subject, &f.proof(true), &inputs)
        .is_err());
    f.env
        .ledger()
        .with_mut(|ledger| ledger.network_id = [1; 32]);
    assert_eq!(
        f.client()
            .try_submit_eligibility(&subject, &f.proof(true), &inputs),
        Err(Ok(GateError::WrongNetwork))
    );
}

#[test]
fn invalid_immutable_policy_and_nonclassic_recipients_are_rejected() {
    let f = Fixture::new();
    for index in 0..5 {
        let mut config = f.config.clone();
        match index {
            0 => config.verifier_wasm_hash = f.id(8),
            1 => config.verifier_vk_hash = f.id(8),
            2 => config.sanctions_strict = true,
            3 => config.max_proof_age = 3601,
            _ => config.policy_valid_until = 1000 + 86401,
        }
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| register_gate(
                &f.env, config
            )))
            .is_err()
        );
    }
    let mut terms = f.terms();
    terms.recipient = f.gate.clone();
    terms.refund_to = f.gate.clone();
    assert!(f.client().try_get_subject(&f.gate).is_err());
    assert!(f.client().try_create_order(&f.id(1), &terms).is_err());
    assert_eq!(f.client().get_total_reserved(), 0);
}

fn signed_auth(
    env: &Env,
    seed: u8,
    invocation: &soroban_sdk::testutils::MockAuthInvoke<'_>,
    nonce: i64,
) -> xdr::SorobanAuthorizationEntry {
    use ed25519_dalek::Signer;
    use xdr::WriteXdr;
    let signing = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let public = signing.verifying_key().to_bytes();
    let root: xdr::SorobanAuthorizedInvocation = invocation.into();
    let expiration = env.ledger().sequence() + 100;
    let payload =
        xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
            network_id: xdr::Hash(env.ledger().network_id().to_array()),
            nonce,
            signature_expiration_ledger: expiration,
            invocation: root.clone(),
        })
        .to_xdr(xdr::Limits::none())
        .unwrap();
    let digest = env.crypto().sha256(&Bytes::from_slice(env, &payload));
    let signature = signing.sign(&digest.to_array()).to_bytes();
    let signatures = vec![
        env,
        soroban_sdk::Map::<soroban_sdk::Symbol, Val>::from_array(
            env,
            [
                (
                    soroban_sdk::Symbol::new(env, "public_key"),
                    BytesN::<32>::from_array(env, &public).into_val(env),
                ),
                (
                    symbol_short!("signature"),
                    BytesN::<64>::from_array(env, &signature).into_val(env),
                ),
            ],
        ),
    ];
    let signature_value: Val = signatures.into_val(env);
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: xdr::ScAddress::Account(xdr::AccountId(xdr::PublicKey::PublicKeyTypeEd25519(
                xdr::Uint256(public),
            ))),
            nonce,
            signature_expiration_ledger: expiration,
            signature: xdr::ScVal::try_from_val(env, &signature_value).unwrap(),
        }),
        root_invocation: root,
    }
}
