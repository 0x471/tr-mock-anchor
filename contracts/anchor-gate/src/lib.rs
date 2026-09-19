#![cfg_attr(not(feature = "std"), no_std)]

use soroban_sdk::Executable;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, vec, xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, String, Val, Vec,
};

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
pub struct OrderTerms {
    pub recipient: Address,
    pub quote_hash: BytesN<32>,
    pub try_minor: u64,
    pub amount: i128,
    pub deadline: u64,
    pub nonce: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Eligibility {
    pub proof_time: u64,
    pub valid_until: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BankReceipt {
    pub event_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub try_minor: u64,
    pub received_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EligibilityState {
    None,
    Some(Eligibility),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReceiptState {
    None,
    Some(BankReceipt),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub terms: OrderTerms,
    pub created_at: u64,
    pub eligibility: EligibilityState,
    pub receipt: ReceiptState,
    pub settled: bool,
}

#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    PolicyHash,
    TotalReserved,
    Order(BytesN<32>),
    Receipt(BytesN<32>),
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
}

#[contract]
pub struct AnchorGate;

#[contractimpl]
impl AnchorGate {
    pub fn __constructor(env: Env, config: Config) -> Result<(), GateError> {
        validate_config(&env, &config)?;
        let policy: Vec<Val> = vec![
            &env,
            String::from_str(&env, "stellar-anchor-policy-v1").into_val(&env),
            config.clone().into_val(&env),
        ];
        let hash = env.crypto().sha256(&policy.to_xdr(&env)).to_bytes();
        env.storage().persistent().set(&Key::Config, &config);
        env.storage().persistent().set(&Key::PolicyHash, &hash);
        env.storage().persistent().set(&Key::TotalReserved, &0i128);
        touch(&env, &Key::Config);
        touch(&env, &Key::PolicyHash);
        touch(&env, &Key::TotalReserved);
        Ok(())
    }

    pub fn create_order(env: Env, id: BytesN<32>, terms: OrderTerms) -> Result<Order, GateError> {
        let c = config(&env)?;
        c.provider.require_auth();
        let key = Key::Order(id.clone());
        if let Some(order) = env.storage().persistent().get::<_, Order>(&key) {
            if order.terms != terms {
                return Err(GateError::OrderConflict);
            }
            touch(&env, &key);
            return Ok(order);
        }
        let now = env.ledger().timestamp();
        current(&env, &c)?;
        let zero = BytesN::from_array(&env, &[0; 32]);
        if id == zero
            || terms.quote_hash == zero
            || terms.nonce == zero
            || !account(&terms.recipient)
            || terms.amount <= 0
            || terms.amount > c.max_amount
            || terms.try_minor == 0
            || terms.try_minor > c.max_try_minor
            || terms.deadline <= now
            || terms.deadline > c.policy_valid_until
            || terms.deadline - now > c.max_order_lifetime
        {
            return Err(GateError::InvalidTerms);
        }
        let total = reserved(&env)?
            .checked_add(terms.amount)
            .ok_or(GateError::Arithmetic)?;
        let token = token::TokenClient::new(&env, &c.token);
        token.transfer(&c.provider, &env.current_contract_address(), &terms.amount);
        if token.balance(&env.current_contract_address()) < total {
            return Err(GateError::InsufficientReserve);
        }
        let order = Order {
            terms,
            created_at: now,
            eligibility: EligibilityState::None,
            receipt: ReceiptState::None,
            settled: false,
        };
        env.storage().persistent().set(&key, &order);
        env.storage().persistent().set(&Key::TotalReserved, &total);
        touch(&env, &key);
        Ok(order)
    }

    pub fn prove_order(
        env: Env,
        id: BytesN<32>,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<Order, GateError> {
        let c = config(&env)?;
        current(&env, &c)?;
        let mut order = load_order(&env, &id)?;
        order.terms.recipient.require_auth();
        if order.settled {
            return Err(GateError::InvalidState);
        }
        let now = env.ledger().timestamp();
        if now >= order.terms.deadline {
            return Err(GateError::Expired);
        }
        verifier_identity(&env, &c)?;
        if proof.len() != c.proof_bytes || public_inputs.len() != c.external_inputs * 32 {
            return Err(GateError::InvalidProof);
        }
        let eligibility = check_policy(&env, &c, &id, &order, &public_inputs)?;
        let verified: bool = env.invoke_contract(
            &c.verifier,
            &symbol_short!("verify"),
            vec![&env, proof.into_val(&env), public_inputs.into_val(&env)],
        );
        if !verified {
            return Err(GateError::InvalidProof);
        }
        order.eligibility = EligibilityState::Some(eligibility);
        save_order(&env, &id, &order);
        Ok(order)
    }

    pub fn record_receipt(
        env: Env,
        id: BytesN<32>,
        receipt: BankReceipt,
    ) -> Result<Order, GateError> {
        let c = config(&env)?;
        c.bank_notary.require_auth();
        let mut order = load_order(&env, &id)?;
        let receipt_key = Key::Receipt(receipt.event_id.clone());
        if let ReceiptState::Some(existing) = &order.receipt {
            if existing == &receipt {
                touch(&env, &receipt_key);
                return Ok(order);
            }
            return Err(GateError::InvalidReceipt);
        }
        if order.settled || matches!(order.eligibility, EligibilityState::None) {
            return Err(GateError::InvalidState);
        }
        if receipt.event_id == BytesN::from_array(&env, &[0; 32])
            || receipt.quote_hash != order.terms.quote_hash
            || receipt.try_minor != order.terms.try_minor
            || receipt.received_at < order.created_at
            || receipt.received_at > env.ledger().timestamp()
        {
            return Err(GateError::InvalidReceipt);
        }
        if env.storage().persistent().has(&receipt_key) {
            return Err(GateError::ReceiptUsed);
        }
        // Late bank evidence is retained; it cannot refresh eligibility or release funds.
        env.storage().persistent().set(&receipt_key, &id);
        touch(&env, &receipt_key);
        order.receipt = ReceiptState::Some(receipt);
        save_order(&env, &id, &order);
        Ok(order)
    }

    pub fn settle(env: Env, id: BytesN<32>) -> Result<Order, GateError> {
        let c = config(&env)?;
        let mut order = load_order(&env, &id)?;
        if order.settled {
            return Ok(order);
        }
        current(&env, &c)?;
        verifier_identity(&env, &c)?;
        let EligibilityState::Some(eligibility) = &order.eligibility else {
            return Err(GateError::InvalidState);
        };
        let ReceiptState::Some(receipt) = &order.receipt else {
            return Err(GateError::InvalidState);
        };
        if env.ledger().timestamp() >= eligibility.valid_until
            || env.ledger().timestamp() >= order.terms.deadline
        {
            return Err(GateError::Expired);
        }
        let receipt_key = Key::Receipt(receipt.event_id.clone());
        if env
            .storage()
            .persistent()
            .get::<_, BytesN<32>>(&receipt_key)
            != Some(id.clone())
        {
            return Err(GateError::InvalidState);
        }
        touch(&env, &receipt_key);
        let total = reserved(&env)?;
        let token = token::TokenClient::new(&env, &c.token);
        if total < order.terms.amount || token.balance(&env.current_contract_address()) < total {
            return Err(GateError::InsufficientReserve);
        }
        let remaining = total
            .checked_sub(order.terms.amount)
            .ok_or(GateError::Arithmetic)?;
        order.settled = true;
        save_order(&env, &id, &order);
        env.storage()
            .persistent()
            .set(&Key::TotalReserved, &remaining);
        // The pinned SAC call is atomic with the terminal state and reserve update.
        token.transfer(
            &env.current_contract_address(),
            &order.terms.recipient,
            &order.terms.amount,
        );
        Ok(order)
    }

    pub fn get_challenge(env: Env, id: BytesN<32>) -> Result<BytesN<32>, GateError> {
        let c = config(&env)?;
        let order = load_order(&env, &id)?;
        challenge(&env, &c, &id, &order)
    }

    pub fn get_config(env: Env) -> Result<Config, GateError> {
        config(&env)
    }

    pub fn get_policy_hash(env: Env) -> Result<BytesN<32>, GateError> {
        config(&env)?;
        env.storage()
            .persistent()
            .get(&Key::PolicyHash)
            .ok_or(GateError::ConfigMissing)
    }

    pub fn get_total_reserved(env: Env) -> Result<i128, GateError> {
        config(&env)?;
        env.storage()
            .persistent()
            .get(&Key::TotalReserved)
            .ok_or(GateError::ConfigMissing)
    }

    pub fn get_order(env: Env, id: BytesN<32>) -> Result<Option<Order>, GateError> {
        config(&env)?;
        Ok(env.storage().persistent().get(&Key::Order(id)))
    }
}

fn load_order(env: &Env, id: &BytesN<32>) -> Result<Order, GateError> {
    let key = Key::Order(id.clone());
    let order = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(GateError::OrderMissing)?;
    touch(env, &key);
    Ok(order)
}

fn save_order(env: &Env, id: &BytesN<32>, order: &Order) {
    let key = Key::Order(id.clone());
    env.storage().persistent().set(&key, order);
    touch(env, &key);
}

fn challenge(
    env: &Env,
    c: &Config,
    id: &BytesN<32>,
    order: &Order,
) -> Result<BytesN<32>, GateError> {
    let hash: BytesN<32> = env
        .storage()
        .persistent()
        .get(&Key::PolicyHash)
        .ok_or(GateError::ConfigMissing)?;
    let values: Vec<Val> = vec![
        env,
        String::from_str(env, "stellar-anchor-intent-v1").into_val(env),
        c.network_id.clone().into_val(env),
        env.current_contract_address().into_val(env),
        order.terms.recipient.clone().into_val(env),
        id.clone().into_val(env),
        order.terms.quote_hash.clone().into_val(env),
        c.token.clone().into_val(env),
        order.terms.try_minor.into_val(env),
        (order.terms.amount as u128).into_val(env),
        order.created_at.into_val(env),
        order.terms.deadline.into_val(env),
        order.terms.nonce.clone().into_val(env),
        hash.into_val(env),
    ];
    Ok(env.crypto().sha256(&values.to_xdr(env)).to_bytes())
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

fn check_policy(
    env: &Env,
    c: &Config,
    id: &BytesN<32>,
    order: &Order,
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
    if proof_time < order.created_at || proof_time > now || now - proof_time >= c.max_proof_age {
        return Err(GateError::Expired);
    }
    let expected_age = h31(env, &Bytes::from_slice(env, &[1, 0, 2, c.min_age as u8, 0]));
    let expected_bind = bind_commitment(env, &challenge(env, c, id, order)?);
    let mut expected = vec![env, expected_age, expected_bind];
    if !c.allowed_nationalities.is_empty() {
        expected.push_back(country_commitment(env, 4, &c.allowed_nationalities));
    }
    if !c.allowed_issuers.is_empty() {
        expected.push_back(country_commitment(env, 6, &c.allowed_issuers));
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
        .min(order.terms.deadline)
        .min(c.policy_valid_until);
    Ok(Eligibility {
        proof_time,
        valid_until,
    })
}

fn reserved(env: &Env) -> Result<i128, GateError> {
    env.storage()
        .persistent()
        .get(&Key::TotalReserved)
        .ok_or(GateError::ConfigMissing)
}

fn current(env: &Env, c: &Config) -> Result<(), GateError> {
    if env.ledger().timestamp() >= c.policy_valid_until {
        return Err(GateError::Expired);
    }
    Ok(())
}

fn touch(env: &Env, key: &Key) {
    let ttl = env.storage().max_ttl().saturating_sub(1).min(120_000);
    if ttl > 0 {
        env.storage().persistent().extend_ttl(key, ttl / 2, ttl);
        env.storage().instance().extend_ttl(ttl / 2, ttl);
    }
}

fn config(env: &Env) -> Result<Config, GateError> {
    let c: Config = env
        .storage()
        .persistent()
        .get(&Key::Config)
        .ok_or(GateError::ConfigMissing)?;
    if c.network_id != env.ledger().network_id() {
        return Err(GateError::WrongNetwork);
    }
    touch(env, &Key::Config);
    touch(env, &Key::PolicyHash);
    touch(env, &Key::TotalReserved);
    Ok(c)
}

fn account(address: &Address) -> bool {
    matches!(address.executable(), Some(Executable::Account))
}

fn verifier_identity(env: &Env, c: &Config) -> Result<(), GateError> {
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

fn validate_config(env: &Env, c: &Config) -> Result<(), GateError> {
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
    let count = 10
        + u32::from(!c.allowed_nationalities.is_empty())
        + u32::from(!c.allowed_issuers.is_empty());
    let zero = BytesN::from_array(env, &[0; 32]);
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

#[cfg(test)]
mod test;
