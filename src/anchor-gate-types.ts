export interface GateTerms {
  direction: "deposit" | "withdrawal";
  bank_destination_hash: string;
  recipient: string;
  quote_hash: string;
  try_minor: string;
  amount: string;
  deadline: number;
  nonce: string;
}

export interface GateReceipt {
  bank_destination_hash: string;
  event_id: string;
  quote_hash: string;
  try_minor: string;
  received_at: number;
}

export interface GateConfiguration {
  contract: string;
  token: string;
  provider: string;
  bank_notary: string;
  domain: string;
  scope: string;
  policy: Record<string, unknown>;
  proof_bytes: number;
  external_inputs: number;
  max_order_lifetime: number;
  policy_valid_until: number;
  max_amount: string;
  max_try_minor: string;
  ledger_time: number;
}

export interface GateOrder extends GateTerms {
  id: string;
  created_at: number;
  confirmed_ledger: number;
  stage:
    | "created"
    | "eligible"
    | "funded"
    | "payout_authorized"
    | "paid"
    | "settled";
  escrowed: boolean;
  payout_authorized_at: number | null;
  challenge: string;
  eligibility_expires_at: number | null;
  receipt_id: string | null;
}

export type GateActionKind =
  "create" | "prove" | "authorize" | "receipt" | "settle";
export interface PreparedGateAction {
  transaction: string;
  hash: string;
  expires_at: number;
  min_time?: number;
}

export interface GateTransaction {
  status: "pending" | "success" | "failed";
  ledger: number | null;
}

export interface GateGateway {
  configuration(): Promise<GateConfiguration>;
  order(id: string): Promise<GateOrder | null>;
  prepareCreate(id: string, terms: GateTerms): Promise<PreparedGateAction>;
  prepareProof(
    id: string,
    recipient: string,
    proof: Buffer,
    publicInputs: Buffer
  ): Promise<PreparedGateAction>;
  prepareReceipt(id: string, receipt: GateReceipt): Promise<PreparedGateAction>;
  prepareAuthorization(id: string): Promise<PreparedGateAction>;
  prepareSettlement(id: string): Promise<PreparedGateAction>;
  submit(transaction: string): Promise<GateTransaction>;
  transaction(
    hash: string,
    bounds?: { min_time: number; expires_at: number }
  ): Promise<GateTransaction>;
}
