import type {
  GateConfiguration,
  GateReceipt,
  GateTerms,
  GateTransaction,
  PreparedGateAction,
} from "./anchor-gate-types.js";

export interface SepAnchorConfiguration extends GateConfiguration {
  policy_hash: string;
}

export interface SepEligibility {
  proof_time: number;
  valid_until: number;
  confirmed_ledger: number;
}

export interface SepOrderTerms extends GateTerms {
  subject: string;
  refund_to: string;
}

export interface SepChainOrder extends SepOrderTerms {
  id: string;
  policy_hash: string;
  created_at: number;
  confirmed_ledger: number;
  escrowed: boolean;
  funding_id: string | null;
  receipt: GateReceipt | null;
  payout_authorized_at: number | null;
  settled_at: number | null;
  refunded_at: number | null;
  cancelled_at: number | null;
}

export type SepChainAction =
  | {
      kind: "eligibility";
      subject: string;
      proof: Buffer;
      public_inputs: Buffer;
    }
  | { kind: "create"; id: string; terms: SepOrderTerms }
  | { kind: "fund"; id: string; operation_id: string }
  | { kind: "receipt"; id: string; receipt: GateReceipt }
  | { kind: "authorize" | "settle" | "refund" | "cancel"; id: string };

export interface SepAnchorGateway {
  configuration(): Promise<SepAnchorConfiguration>;
  challenge(subject: string): Promise<string>;
  eligibility(subject: string): Promise<SepEligibility | null>;
  order(id: string): Promise<SepChainOrder | null>;
  prepare(action: SepChainAction): Promise<PreparedGateAction>;
  submit(transaction: string): Promise<GateTransaction>;
  transaction(
    hash: string,
    bounds?: { min_time: number; expires_at: number }
  ): Promise<GateTransaction>;
}

export interface SepIncomingPayment {
  operation_id: string;
  transaction_hash: string;
  from: string;
  to: string;
  asset: string;
  amount: string;
  memo_type: string;
  memo: string | null;
  created_at: string;
  paging_token: string;
}

export interface SepAnchorIngress {
  readonly account: string;
  readonly asset: string;
  recipientStatus(
    account: string,
    amount: string
  ): Promise<
    | "ready"
    | "missing_account"
    | "missing_trustline"
    | "unauthorized"
    | "insufficient_limit"
  >;
  payments(cursor?: string): Promise<{
    payments: SepIncomingPayment[];
    cursor: string | undefined;
  }>;
}
