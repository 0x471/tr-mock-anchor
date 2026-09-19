# Proof-gated mock anchor

A Testnet anchor exchanges simulated TRY receipts for a demo Stellar asset.
Document eligibility and settlement authorization are separate decisions.

## Language

**Order**:
A customer's fixed request to receive an exact asset amount at an exact wallet
in exchange for an exact simulated TRY amount before a deadline.
_Avoid_: Verification, payment

**Policy**:
The explicit document requirements and trust rules that an order must satisfy.
Nationality and document-issuing country are different policy attributes.
_Avoid_: KYC approval, country check without an attribute

**Proof**:
Cryptographic evidence for a document statement bound to a specific order.
A mathematically valid proof need not satisfy the order's policy.
_Avoid_: Approval

**Eligibility**:
Satisfaction of an order's document policy by its bound proof.
Eligibility alone does not establish that a bank transfer was received.
_Avoid_: Settlement, identity approval

**Mock-bank receipt**:
A uniquely identified attestation that the simulated TRY amount for an order
was received. It does not establish document eligibility or real fiat receipt.
_Avoid_: Proof

**Reservation**:
Demo assets set aside for one fixed order and unavailable to other orders.
_Avoid_: Payment, balance credit

**Settlement**:
The single asset transfer that fulfils an eligible, funded order to its bound
recipient. Retrying the same order must not create a second transfer.
_Avoid_: Verification, bank receipt

**Vault**:
The holder of reserved demo assets whose release requires the order's policy
and mock-bank receipt conditions.
_Avoid_: Treasury wallet
