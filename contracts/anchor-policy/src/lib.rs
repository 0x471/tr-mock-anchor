#![no_std]

use soroban_sdk::{
    contracterror, contracttype, symbol_short, token, vec, Address, Bytes, BytesN, Env, Executable,
    String, Vec,
};

const FR_MODULUS: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub provider: Address,
    pub bank_notary: Address,
    pub token: Address,
    pub verifier: Address,
    pub verifier_wasm_hash: BytesN<32>,
    pub verifier_vk_hash: BytesN<32>,
    pub network_id: BytesN<32>,
    pub certificate_root: BytesN<32>,
    pub circuit_root: BytesN<32>,
    pub domain: String,
    pub scope: String,
    pub min_age: u32,
    pub allowed_nationalities: Vec<BytesN<3>>,
    pub allowed_issuers: Vec<BytesN<3>>,
    pub sanctions_root: BytesN<32>,
    pub sanctions_strict: bool,
    pub proof_bytes: u32,
    pub external_inputs: u32,
    pub max_proof_age: u64,
    pub policy_valid_until: u64,
    pub max_order_lifetime: u64,
    pub max_amount: i128,
    pub max_try_minor: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationProfile {
    pub vk_hash: BytesN<32>,
    pub external_inputs: u32,
    pub proof_bytes: u32,
    pub log_n: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Eligibility {
    pub proof_time: u64,
    pub valid_until: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GateError {
    ConfigMissing = 1,
    InvalidConfig = 2,
    WrongNetwork = 3,
    WrongVerifier = 4,
    InvalidTerms = 5,
    OrderConflict = 6,
    OrderMissing = 7,
    Expired = 8,
    InvalidProof = 9,
    InvalidPolicy = 10,
    InvalidBinding = 11,
    InvalidState = 12,
    InvalidReceipt = 13,
    ReceiptUsed = 14,
    InsufficientReserve = 15,
    Arithmetic = 16,
    FundingUsed = 17,
    EligibilityMissing = 18,
    InvalidSubject = 19,
}

fn h31(env: &Env, bytes: &Bytes) -> BytesN<32> {
    let hash = env.crypto().sha256(bytes).to_array();
    let mut field = [0; 32];
    field[1..].copy_from_slice(&hash[..31]);
    BytesN::from_array(env, &field)
}

fn bind_commitment(env: &Env, digest: &BytesN<32>) -> BytesN<32> {
    let mut record = [0; 512];
    record[..6].copy_from_slice(&[8, 1, 253, 3, 0, 64]);
    for (i, byte) in digest.to_array().iter().enumerate() {
        record[6 + i * 2] = b"0123456789abcdef"[(byte >> 4) as usize];
        record[7 + i * 2] = b"0123456789abcdef"[(byte & 15) as usize];
    }
    h31(env, &Bytes::from_slice(env, &record))
}

fn country_commitment(env: &Env, kind: u8, countries: &Vec<BytesN<3>>) -> BytesN<32> {
    let mut record = [0; 603];
    record[..3].copy_from_slice(&[kind, 2, 88]);
    for (i, code) in countries.iter().enumerate() {
        record[3 + i * 3..6 + i * 3].copy_from_slice(&code.to_array());
    }
    h31(env, &Bytes::from_slice(env, &record))
}

fn sanctions_commitment(env: &Env, c: &Config) -> BytesN<32> {
    let mut record = [0; 36];
    record[..3].copy_from_slice(&[9, 0, 33]);
    record[3..35].copy_from_slice(&c.sanctions_root.to_array());
    record[35] = u8::from(c.sanctions_strict);
    h31(env, &Bytes::from_slice(env, &record))
}

fn field(env: &Env, inputs: &Bytes, index: u32) -> BytesN<32> {
    let mut value = [0; 32];
    inputs
        .slice(index * 32..(index + 1) * 32)
        .copy_into_slice(&mut value);
    BytesN::from_array(env, &value)
}

fn narrow_u64(value: &BytesN<32>) -> Result<u64, GateError> {
    let bytes = value.to_array();
    if bytes[..24].iter().any(|b| *b != 0) {
        return Err(GateError::InvalidPolicy);
    }
    let mut tail = [0; 8];
    tail.copy_from_slice(&bytes[24..]);
    Ok(u64::from_be_bytes(tail))
}

pub fn check_eligibility(
    env: &Env,
    c: &Config,
    digest: &BytesN<32>,
    issued_after: u64,
    expires_at: u64,
    inputs: &Bytes,
) -> Result<Eligibility, GateError> {
    if field(env, inputs, 0) != c.certificate_root
        || field(env, inputs, 1) != c.circuit_root
        || field(env, inputs, 3) != h31(env, &c.domain.to_bytes())
        || field(env, inputs, 4) != h31(env, &c.scope.to_bytes())
    {
        return Err(GateError::InvalidPolicy);
    }
    let proof_time = narrow_u64(&field(env, inputs, 2))?;
    let now = env.ledger().timestamp();
    if proof_time < issued_after || proof_time > now || now - proof_time >= c.max_proof_age {
        return Err(GateError::Expired);
    }
    let expected_age = h31(env, &Bytes::from_slice(env, &[1, 0, 2, c.min_age as u8, 0]));
    let expected_bind = bind_commitment(env, digest);
    let mut expected = vec![env, expected_age, expected_bind];
    if !c.allowed_nationalities.is_empty() {
        expected.push_back(country_commitment(env, 4, &c.allowed_nationalities));
    }
    if !c.allowed_issuers.is_empty() {
        expected.push_back(country_commitment(env, 6, &c.allowed_issuers));
    }
    if c.sanctions_root != BytesN::from_array(env, &[0; 32]) {
        expected.push_back(sanctions_commitment(env, c));
    }
    let count = expected.len();
    for i in 0..count {
        let actual = field(env, inputs, 5 + i);
        let Some(position) = expected.first_index_of(actual) else {
            return Err(GateError::InvalidBinding);
        };
        expected.remove(position);
    }
    let nullifier_index = 5 + count;
    let zero = BytesN::from_array(env, &[0; 32]);
    if narrow_u64(&field(env, inputs, nullifier_index))? != 2
        || field(env, inputs, nullifier_index + 1) == zero
        || field(env, inputs, nullifier_index + 2) != zero
    {
        return Err(GateError::InvalidPolicy);
    }
    let valid_until = proof_time
        .checked_add(c.max_proof_age)
        .ok_or(GateError::Arithmetic)?
        .min(expires_at)
        .min(c.policy_valid_until);
    Ok(Eligibility {
        proof_time,
        valid_until,
    })
}

pub fn account(address: &Address) -> bool {
    matches!(address.executable(), Some(Executable::Account))
}

pub fn verifier_identity(env: &Env, c: &Config) -> Result<(), GateError> {
    if c.verifier.executable() != Some(Executable::Wasm(c.verifier_wasm_hash.clone())) {
        return Err(GateError::WrongVerifier);
    }
    let p: VerificationProfile =
        env.invoke_contract(&c.verifier, &symbol_short!("profile"), vec![env]);
    let log_n = if c.external_inputs == 10 { 22 } else { 23 };
    if p.vk_hash != c.verifier_vk_hash
        || p.external_inputs != c.external_inputs
        || p.proof_bytes != c.proof_bytes
        || p.log_n != log_n
    {
        return Err(GateError::WrongVerifier);
    }
    Ok(())
}

fn valid_countries(countries: &Vec<BytesN<3>>) -> bool {
    if countries.len() > 10 {
        return false;
    }
    let mut previous: Option<[u8; 3]> = None;
    for code in countries.iter() {
        let value = code.to_array();
        if !value.iter().all(|b| b.is_ascii_uppercase()) || previous.is_some_and(|p| p >= value) {
            return false;
        }
        previous = Some(value);
    }
    true
}

pub fn validate_config(env: &Env, c: &Config) -> Result<(), GateError> {
    let now = env.ledger().timestamp();
    let testnet = env
        .crypto()
        .sha256(&Bytes::from_slice(
            env,
            b"Test SDF Network ; September 2015",
        ))
        .to_bytes();
    if c.network_id != testnet || c.network_id != env.ledger().network_id() {
        return Err(GateError::WrongNetwork);
    }
    let zero = BytesN::from_array(env, &[0; 32]);
    let count = 10
        + u32::from(!c.allowed_nationalities.is_empty())
        + u32::from(!c.allowed_issuers.is_empty())
        + u32::from(c.sanctions_root != zero);
    if !account(&c.provider)
        || !account(&c.bank_notary)
        || c.provider == c.bank_notary
        || c.token.executable() != Some(Executable::StellarAsset)
        || token::TokenClient::new(env, &c.token).decimals() != 7
        || c.certificate_root == zero
        || c.circuit_root == zero
        || c.domain.is_empty()
        || c.domain.len() > 253
        || c.scope.is_empty()
        || c.scope.len() > 128
        || c.min_age == 0
        || c.min_age > 120
        || !valid_countries(&c.allowed_nationalities)
        || !valid_countries(&c.allowed_issuers)
        || (c.sanctions_root == zero && c.sanctions_strict)
        || c.sanctions_root.to_array() >= FR_MODULUS
        || c.external_inputs != count
        || c.proof_bytes != if count == 10 { 9888 } else { 10240 }
        || c.max_proof_age == 0
        || c.max_proof_age > 3600
        || c.policy_valid_until <= now
        || c.policy_valid_until - now > 86400
        || c.max_order_lifetime == 0
        || c.max_order_lifetime > 86400
        || c.max_amount <= 0
        || c.max_try_minor == 0
    {
        return Err(GateError::InvalidConfig);
    }
    verifier_identity(env, c)
}
