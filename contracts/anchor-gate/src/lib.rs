#![cfg_attr(not(feature = "std"), no_std)]

#[cfg(test)]
use soroban_sdk::Executable;
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, vec, xdr::ToXdr, Address, Bytes,
    BytesN, Env, IntoVal, String, Val, Vec,
};

use anchor_policy::{account, check_eligibility, validate_config, verifier_identity};
pub use anchor_policy::{Config, Eligibility, GateError, VerificationProfile};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Direction {
    Deposit,
    Withdrawal,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OrderTerms {
    pub direction: Direction,
    pub bank_destination_hash: BytesN<32>,
    pub recipient: Address,
    pub quote_hash: BytesN<32>,
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
pub enum PayoutState {
    None,
    Authorized(u64),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Order {
    pub terms: OrderTerms,
    pub created_at: u64,
    pub eligibility: EligibilityState,
    pub receipt: ReceiptState,
    pub escrowed: bool,
    pub payout: PayoutState,
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
            eligibility: EligibilityState::None,
            receipt: ReceiptState::None,
            escrowed,
            payout: PayoutState::None,
            settled: false,
        };
        env.storage().persistent().set(&key, &order);
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
        if order.settled || order.payout != PayoutState::None {
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
        if order.terms.direction == Direction::Withdrawal && !order.escrowed {
            reserve_from(&env, &c, &order.terms.recipient, order.terms.amount)?;
            order.escrowed = true;
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
        if order.settled || !order.escrowed || matches!(order.eligibility, EligibilityState::None) {
            return Err(GateError::InvalidState);
        }
        let earliest_receipt = match order.terms.direction {
            Direction::Deposit => order.created_at,
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
        if order.settled || !order.escrowed || order.receipt != ReceiptState::None {
            return Err(GateError::InvalidState);
        }
        let EligibilityState::Some(eligibility) = &order.eligibility else {
            return Err(GateError::InvalidState);
        };
        current(&env, &c)?;
        verifier_identity(&env, &c)?;
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

    pub fn settle(env: Env, id: BytesN<32>) -> Result<Order, GateError> {
        let c = config(&env)?;
        let mut order = load_order(&env, &id)?;
        if order.settled {
            return Ok(order);
        }
        let EligibilityState::Some(eligibility) = &order.eligibility else {
            return Err(GateError::InvalidState);
        };
        let ReceiptState::Some(receipt) = &order.receipt else {
            return Err(GateError::InvalidState);
        };
        if !order.escrowed {
            return Err(GateError::InvalidState);
        }
        let destination = match order.terms.direction {
            Direction::Deposit => {
                current(&env, &c)?;
                verifier_identity(&env, &c)?;
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
        let total = reserved(&env)?;
        let token = token::TokenClient::new(&env, &c.token);
        if total < order.terms.amount || token.balance(&env.current_contract_address()) < total {
            return Err(GateError::InsufficientReserve);
        }
        let remaining = total
            .checked_sub(order.terms.amount)
            .ok_or(GateError::Arithmetic)?;
        order.settled = true;
        order.escrowed = false;
        save_order(&env, &id, &order);
        env.storage()
            .persistent()
            .set(&Key::TotalReserved, &remaining);
        // The pinned SAC call is atomic with the terminal state and reserve update.
        token.transfer(
            &env.current_contract_address(),
            &destination,
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

fn reserve_from(env: &Env, c: &Config, source: &Address, amount: i128) -> Result<(), GateError> {
    let total = reserved(env)?
        .checked_add(amount)
        .ok_or(GateError::Arithmetic)?;
    let token = token::TokenClient::new(env, &c.token);
    token.transfer(source, &env.current_contract_address(), &amount);
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
        String::from_str(env, "stellar-anchor-intent-v2").into_val(env),
        c.network_id.clone().into_val(env),
        env.current_contract_address().into_val(env),
        order.terms.recipient.clone().into_val(env),
        id.clone().into_val(env),
        order.terms.quote_hash.clone().into_val(env),
        c.token.clone().into_val(env),
        order.terms.direction.clone().into_val(env),
        order.terms.bank_destination_hash.clone().into_val(env),
        order.terms.try_minor.into_val(env),
        (order.terms.amount as u128).into_val(env),
        order.created_at.into_val(env),
        order.terms.deadline.into_val(env),
        order.terms.nonce.clone().into_val(env),
        hash.into_val(env),
    ];
    Ok(env.crypto().sha256(&values.to_xdr(env)).to_bytes())
}

fn check_policy(
    env: &Env,
    c: &Config,
    id: &BytesN<32>,
    order: &Order,
    inputs: &Bytes,
) -> Result<Eligibility, GateError> {
    check_eligibility(
        env,
        c,
        &challenge(env, c, id, order)?,
        order.created_at,
        order.terms.deadline,
        inputs,
    )
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

#[cfg(test)]
mod test;
