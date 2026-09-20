#![cfg_attr(not(feature = "std"), no_std)]
use anchor_policy::{account, check_eligibility, validate_config, verifier_identity};
pub use anchor_policy::{Config, Eligibility, GateError, VerificationProfile};
#[cfg(test)]
use soroban_sdk::Executable;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, xdr::ToXdr, Address, Bytes,
    BytesN, Env, IntoVal, String, Val, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Direction {
    Deposit,
    Withdrawal,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderTerms {
    pub subject: BytesN<32>,
    pub recipient: Address,
    pub refund_to: Address,
    pub direction: Direction,
    pub quote_hash: BytesN<32>,
    pub bank_destination_hash: BytesN<32>,
    pub try_minor: u64,
    pub amount: i128,
    pub deadline: u64,
    pub nonce: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BankReceipt {
    pub event_id: BytesN<32>,
    pub quote_hash: BytesN<32>,
    pub try_minor: u64,
    pub received_at: u64,
    pub bank_destination_hash: BytesN<32>,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(
    clippy::large_enum_variant,
    reason = "Keep the stable Soroban enum encoding without heap indirection."
)]
pub enum ReceiptState {
    None,
    Some(BankReceipt),
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PayoutState {
    None,
    Authorized(u64),
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Funding {
    pub operation_id: BytesN<32>,
    pub recorded_at: u64,
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FundingState {
    None,
    Some(Funding),
}
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub terms: OrderTerms,
    pub created_at: u64,
    pub receipt: ReceiptState,
    pub escrowed: bool,
    pub payout: PayoutState,
    pub funding: FundingState,
    pub settled_at: Option<u64>,
    pub refunded_at: Option<u64>,
    pub cancelled_at: Option<u64>,
}
#[contracttype]
#[derive(Clone)]
enum Key {
    Config,
    PolicyHash,
    TotalReserved,
    Eligibility(BytesN<32>),
    Order(BytesN<32>),
    Receipt(BytesN<32>),
    Funding(BytesN<32>),
}
#[contract]
pub struct SepAnchor;
#[contractimpl]
impl SepAnchor {
    pub fn __constructor(env: Env, config: Config) -> Result<(), GateError> {
        validate_config(&env, &config)?;
        let policy: Vec<Val> = vec![
            &env,
            String::from_str(&env, "stellar-sep-anchor-policy-v1").into_val(&env),
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
    pub fn get_config(env: Env) -> Result<Config, GateError> {
        config(&env)
    }
    pub fn cancel(env: Env, id: BytesN<32>) -> Result<Order, GateError> {
        let c = config(&env)?;
        c.provider.require_auth();
        c.bank_notary.require_auth();
        let mut order = load_order(&env, &id)?;
        if order.cancelled_at.is_some() {
            return Ok(order);
        }
        if order.terms.direction != Direction::Deposit
            || terminal(&order)
            || !order.escrowed
            || order.payout != PayoutState::None
            || order.receipt != ReceiptState::None
        {
            return Err(GateError::InvalidState);
        }
        order.cancelled_at = Some(env.ledger().timestamp());
        release(&env, &c, &id, &mut order, &c.provider)?;
        Ok(order)
    }
    pub fn refund(env: Env, id: BytesN<32>) -> Result<Order, GateError> {
        let c = config(&env)?;
        c.provider.require_auth();
        c.bank_notary.require_auth();
        let mut order = load_order(&env, &id)?;
        if order.refunded_at.is_some() {
            return Ok(order);
        }
        if order.terms.direction != Direction::Withdrawal
            || terminal(&order)
            || !order.escrowed
            || order.payout != PayoutState::None
            || order.receipt != ReceiptState::None
        {
            return Err(GateError::InvalidState);
        }
        order.refunded_at = Some(env.ledger().timestamp());
        let destination = order.terms.refund_to.clone();
        release(&env, &c, &id, &mut order, &destination)?;
        Ok(order)
    }
    pub fn authorize_payout(env: Env, id: BytesN<32>) -> Result<Order, GateError> {
        let c = config(&env)?;
        c.bank_notary.require_auth();
        let mut order = load_order(&env, &id)?;
        if order.terms.direction != Direction::Withdrawal {
            return Err(GateError::InvalidState);
        }
        if let PayoutState::Authorized(_) = order.payout {
            return Ok(order);
        }
        if terminal(&order) || !order.escrowed || order.receipt != ReceiptState::None {
            return Err(GateError::InvalidState);
        }
        let eligibility = active_eligibility(&env, &c, &order.terms.subject)?;
        let now = env.ledger().timestamp();
        if now >= order.terms.deadline || now >= eligibility.valid_until {
            return Err(GateError::Expired);
        }
        let total = reserved(&env)?;
        if total < order.terms.amount
            || token::TokenClient::new(&env, &c.token).balance(&env.current_contract_address())
                < total
        {
            return Err(GateError::InsufficientReserve);
        }
        // This records one durable bank obligation, not an asset transfer or bank receipt.
        order.payout = PayoutState::Authorized(now);
        save_order(&env, &id, &order);
        Ok(order)
    }
    pub fn fund_withdrawal(
        env: Env,
        id: BytesN<32>,
        operation_id: BytesN<32>,
    ) -> Result<Order, GateError> {
        let c = config(&env)?;
        c.provider.require_auth();
        c.bank_notary.require_auth();
        let mut order = load_order(&env, &id)?;
        if order.terms.direction != Direction::Withdrawal {
            return Err(GateError::InvalidState);
        }
        if let FundingState::Some(existing) = &order.funding {
            if existing.operation_id == operation_id {
                return Ok(order);
            }
            return Err(GateError::InvalidState);
        }
        if terminal(&order)
            || order.escrowed
            || order.payout != PayoutState::None
            || operation_id == BytesN::from_array(&env, &[0; 32])
        {
            return Err(GateError::InvalidState);
        }
        let key = Key::Funding(operation_id.clone());
        if env.storage().persistent().has(&key) {
            return Err(GateError::FundingUsed);
        }
        reserve_from(&env, &c, &c.provider, order.terms.amount)?;
        order.escrowed = true;
        order.funding = FundingState::Some(Funding {
            operation_id,
            recorded_at: env.ledger().timestamp(),
        });
        // The notary attributes the classic payment; this call verifies only the real custody sweep.
        env.storage().persistent().set(&key, &id);
        touch(&env, &key);
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
        if terminal(&order) || !order.escrowed {
            return Err(GateError::InvalidState);
        }
        let earliest_receipt = match order.terms.direction {
            Direction::Deposit => {
                if !env
                    .storage()
                    .persistent()
                    .has(&Key::Eligibility(order.terms.subject.clone()))
                {
                    return Err(GateError::EligibilityMissing);
                }
                order.created_at
            }
            Direction::Withdrawal => match order.payout {
                PayoutState::Authorized(at) => at,
                PayoutState::None => return Err(GateError::InvalidState),
            },
        };
        if receipt.event_id == BytesN::from_array(&env, &[0; 32])
            || receipt.quote_hash != order.terms.quote_hash
            || receipt.try_minor != order.terms.try_minor
            || receipt.bank_destination_hash != order.terms.bank_destination_hash
            || receipt.received_at < earliest_receipt
            || receipt.received_at > env.ledger().timestamp()
        {
            return Err(GateError::InvalidReceipt);
        }
        if env.storage().persistent().has(&receipt_key) {
            return Err(GateError::ReceiptUsed);
        }
        // Late evidence never creates eligibility or a new withdrawal obligation.
        env.storage().persistent().set(&receipt_key, &id);
        touch(&env, &receipt_key);
        order.receipt = ReceiptState::Some(receipt);
        save_order(&env, &id, &order);
        Ok(order)
    }
    pub fn settle(env: Env, id: BytesN<32>) -> Result<Order, GateError> {
        let c = config(&env)?;
        let mut order = load_order(&env, &id)?;
        if order.settled_at.is_some() {
            return Ok(order);
        }
        if terminal(&order) {
            return Err(GateError::InvalidState);
        }
        let ReceiptState::Some(receipt) = &order.receipt else {
            return Err(GateError::InvalidState);
        };
        if !order.escrowed {
            return Err(GateError::InvalidState);
        }
        let destination = match order.terms.direction {
            Direction::Deposit => {
                let eligibility = active_eligibility(&env, &c, &order.terms.subject)?;
                if env.ledger().timestamp() >= eligibility.valid_until
                    || env.ledger().timestamp() >= order.terms.deadline
                {
                    return Err(GateError::Expired);
                }
                order.terms.recipient.clone()
            }
            Direction::Withdrawal => {
                if !matches!(order.payout, PayoutState::Authorized(_)) {
                    return Err(GateError::InvalidState);
                }
                // Previously authorized bank obligations survive later policy expiry.
                c.provider.clone()
            }
        };
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
        order.settled_at = Some(env.ledger().timestamp());
        release(&env, &c, &id, &mut order, &destination)?;
        Ok(order)
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
        verifier_identity(&env, &c)?;
        let zero = BytesN::from_array(&env, &[0; 32]);
        if id == zero
            || terms.subject == zero
            || !account(&terms.refund_to)
            || terms.refund_to != terms.recipient
            || terms.subject != subject_hash(&env, &terms.recipient)?
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
            || (terms.direction == Direction::Deposit && terms.bank_destination_hash != zero)
            || (terms.direction == Direction::Withdrawal && terms.bank_destination_hash == zero)
        {
            return Err(GateError::InvalidTerms);
        }
        let escrowed = terms.direction == Direction::Deposit;
        if escrowed {
            reserve_from(&env, &c, &c.provider, terms.amount)?;
        }
        let order = Order {
            terms,
            created_at: now,
            receipt: ReceiptState::None,
            escrowed,
            payout: PayoutState::None,
            funding: FundingState::None,
            settled_at: None,
            refunded_at: None,
            cancelled_at: None,
        };
        env.storage().persistent().set(&key, &order);
        touch(&env, &key);
        Ok(order)
    }
    pub fn get_order(env: Env, id: BytesN<32>) -> Result<Option<Order>, GateError> {
        config(&env)?;
        let key = Key::Order(id);
        let value = env.storage().persistent().get(&key);
        if value.is_some() {
            touch(&env, &key);
        }
        Ok(value)
    }
    pub fn get_policy_hash(env: Env) -> Result<BytesN<32>, GateError> {
        config(&env)?;
        policy_hash(&env)
    }
    pub fn get_subject(env: Env, account: Address) -> Result<BytesN<32>, GateError> {
        config(&env)?;
        subject_hash(&env, &account)
    }
    pub fn get_challenge(env: Env, subject: BytesN<32>) -> Result<BytesN<32>, GateError> {
        let c = config(&env)?;
        challenge(&env, &c, &subject)
    }
    pub fn submit_eligibility(
        env: Env,
        subject: BytesN<32>,
        proof: Bytes,
        public_inputs: Bytes,
    ) -> Result<Eligibility, GateError> {
        let c = config(&env)?;
        current(&env, &c)?;
        verifier_identity(&env, &c)?;
        if proof.len() != c.proof_bytes || public_inputs.len() != c.external_inputs * 32 {
            return Err(GateError::InvalidProof);
        }
        let eligibility = check_eligibility(
            &env,
            &c,
            &challenge(&env, &c, &subject)?,
            0,
            c.policy_valid_until,
            &public_inputs,
        )?;
        let verified: bool = env.invoke_contract(
            &c.verifier,
            &symbol_short!("verify"),
            vec![&env, proof.into_val(&env), public_inputs.into_val(&env)],
        );
        if !verified {
            return Err(GateError::InvalidProof);
        }
        let key = Key::Eligibility(subject);
        let existing: Option<Eligibility> = env.storage().persistent().get(&key);
        if let Some(existing) = existing {
            if existing.proof_time >= eligibility.proof_time {
                touch(&env, &key);
                return Ok(existing);
            }
        }
        env.storage().persistent().set(&key, &eligibility);
        touch(&env, &key);
        Ok(eligibility)
    }
    pub fn get_eligibility(
        env: Env,
        subject: BytesN<32>,
    ) -> Result<Option<Eligibility>, GateError> {
        config(&env)?;
        let key = Key::Eligibility(subject);
        let value = env.storage().persistent().get(&key);
        if value.is_some() {
            touch(&env, &key);
        }
        Ok(value)
    }
    pub fn get_total_reserved(env: Env) -> Result<i128, GateError> {
        config(&env)?;
        reserved(&env)
    }
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
fn reserved(env: &Env) -> Result<i128, GateError> {
    env.storage()
        .persistent()
        .get(&Key::TotalReserved)
        .ok_or(GateError::ConfigMissing)
}
fn policy_hash(env: &Env) -> Result<BytesN<32>, GateError> {
    env.storage()
        .persistent()
        .get(&Key::PolicyHash)
        .ok_or(GateError::ConfigMissing)
}
fn terminal(order: &Order) -> bool {
    order.settled_at.is_some() || order.refunded_at.is_some() || order.cancelled_at.is_some()
}
fn release(
    env: &Env,
    c: &Config,
    id: &BytesN<32>,
    order: &mut Order,
    destination: &Address,
) -> Result<(), GateError> {
    let total = reserved(env)?;
    let token = token::TokenClient::new(env, &c.token);
    if total < order.terms.amount || token.balance(&env.current_contract_address()) < total {
        return Err(GateError::InsufficientReserve);
    }
    let remaining = total
        .checked_sub(order.terms.amount)
        .ok_or(GateError::Arithmetic)?;
    order.escrowed = false;
    save_order(env, id, order);
    env.storage()
        .persistent()
        .set(&Key::TotalReserved, &remaining);
    token.transfer(
        &env.current_contract_address(),
        destination,
        &order.terms.amount,
    );
    Ok(())
}
fn active_eligibility(
    env: &Env,
    c: &Config,
    subject: &BytesN<32>,
) -> Result<Eligibility, GateError> {
    current(env, c)?;
    verifier_identity(env, c)?;
    let key = Key::Eligibility(subject.clone());
    let grant: Eligibility = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(GateError::EligibilityMissing)?;
    if env.ledger().timestamp() >= grant.valid_until {
        return Err(GateError::Expired);
    }
    touch(env, &key);
    Ok(grant)
}
fn current(env: &Env, c: &Config) -> Result<(), GateError> {
    if env.ledger().timestamp() >= c.policy_valid_until {
        return Err(GateError::Expired);
    }
    Ok(())
}
fn challenge(env: &Env, c: &Config, subject: &BytesN<32>) -> Result<BytesN<32>, GateError> {
    if subject == &BytesN::from_array(env, &[0; 32]) {
        return Err(GateError::InvalidSubject);
    }
    let values: Vec<Val> = vec![
        env,
        String::from_str(env, "sep-anchor-eligibility-v1").into_val(env),
        c.network_id.clone().into_val(env),
        env.current_contract_address().into_val(env),
        subject.clone().into_val(env),
        policy_hash(env)?.into_val(env),
    ];
    Ok(env.crypto().sha256(&values.to_xdr(env)).to_bytes())
}
fn subject_hash(env: &Env, subject: &Address) -> Result<BytesN<32>, GateError> {
    if !account(subject) {
        return Err(GateError::InvalidTerms);
    }
    let values: Vec<Val> = vec![
        env,
        String::from_str(env, "sep-anchor-subject-v1").into_val(env),
        subject.to_string().into_val(env),
    ];
    Ok(env.crypto().sha256(&values.to_xdr(env)).to_bytes())
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

fn reserve_from(env: &Env, c: &Config, source: &Address, amount: i128) -> Result<(), GateError> {
    let total = reserved(env)?
        .checked_add(amount)
        .ok_or(GateError::Arithmetic)?;
    let token = token::TokenClient::new(env, &c.token);
    token.transfer(source, env.current_contract_address(), &amount);
    if token.balance(&env.current_contract_address()) < total {
        return Err(GateError::InsufficientReserve);
    }
    env.storage().persistent().set(&Key::TotalReserved, &total);
    Ok(())
}

fn save_order(env: &Env, id: &BytesN<32>, order: &Order) {
    let key = Key::Order(id.clone());
    env.storage().persistent().set(&key, order);
    touch(env, &key);
}
#[cfg(test)]
mod test;
