# Proof-gated mock anchor

A Testnet anchor exchanges simulated TRY for a demo Stellar asset in either direction.
Document eligibility and settlement authorization are separate decisions.

## Language

**Order**:
A customer's fixed exchange request with exact token and simulated TRY amounts,
a direction, a wallet and, for withdrawals, a fixed simulated bank destination.
_Avoid_: Verification, payment

**Deposit**:
An exchange of simulated TRY received by the anchor for tokens paid to the
customer's bound wallet.
_Avoid_: Wallet funding without an exchange

**Withdrawal**:
An exchange of the customer's escrowed tokens for simulated TRY paid to the
customer's bound bank destination.
_Avoid_: Provider reclaim, refund

**Policy**:
The explicit document requirements and trust rules that an order must satisfy.
Nationality and document-issuing country are different policy attributes.
_Avoid_: KYC approval, country check without an attribute

**Proof**:
Cryptographic evidence for a document statement bound to an explicit request.
A mathematically valid proof need not satisfy the order's policy.
_Avoid_: Approval

**Eligibility**:
Satisfaction of the document policy by a correctly bound proof.
Eligibility alone does not establish that a bank transfer was received.
_Avoid_: Settlement, identity approval

**Eligibility grant**:
A time-limited eligibility decision for one wallet and one policy, reusable
across that wallet's orders while it remains current.
_Avoid_: Permanent approval, bank-account ownership

**Custody payment**:
The customer's token transfer to the anchor, attributed to an exact withdrawal.
Receipt by the anchor is distinct from reserving those tokens for settlement.
_Avoid_: Proof, completed withdrawal

**Mock-bank receipt**:
A uniquely identified attestation that an order's simulated TRY was received
for a deposit or paid for a withdrawal. It is not evidence of real fiat movement.
_Avoid_: Proof

**Reservation**:
Demo assets set aside for one fixed order and unavailable to other orders.
_Avoid_: Payment, balance credit

**Payout authorization**:
An irreversible obligation to pay one eligible, escrowed withdrawal's exact
simulated TRY amount to its fixed bank destination.
_Avoid_: Bank receipt, reusable identity approval

**Settlement**:
The single token transfer that completes an order: to the customer for a
deposit, or to the provider after a withdrawal's simulated bank payment.
_Avoid_: Verification, bank receipt

**Vault**:
The holder of reserved demo assets whose release requires the order's policy
and mock-bank receipt conditions.
_Avoid_: Treasury wallet
