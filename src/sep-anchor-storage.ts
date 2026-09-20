import type { DB } from "./db.js";
import type {
  SepAnchorConfiguration,
  SepChainOrder,
  SepOrderTerms,
} from "./sep-anchor-types.js";
import type { readSepQuote } from "./sep-quotes.js";
import type { GateReceipt, PreparedGateAction } from "./anchor-gate-types.js";
import type { SepIncomingPayment } from "./sep-anchor-types.js";

export type SepQuote = ReturnType<typeof readSepQuote>;
export interface SepIntent {
  id: string;
  subject: string;
  customer_id: string;
  protocol: "sep6" | "sep24";
  direction: "deposit" | "withdrawal";
  requested_amount: string | null;
  requested_quote: string | null;
  requested_bank_destination: string | null;
  config: SepAnchorConfiguration;
  quote: SepQuote | null;
  terms: SepOrderTerms | null;
  bank_destination: string | null;
  bank_requested: boolean;
  chain: SepChainOrder | null;
  recovery_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SepAction extends PreparedGateAction {
  id: string;
  intent_id: string;
  kind: string;
  key: string;
  status: "prepared" | "pending" | "success" | "failed";
  ledger: number | null;
}

export interface SepPayment {
  payment: SepIncomingPayment;
  intent_id: string | null;
  status: "accepted" | "recovery";
  reason: string | null;
}

export function createSepAnchorStorage(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sep_anchor_intents (
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, customer_id TEXT NOT NULL,
      protocol TEXT NOT NULL, direction TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sep_anchor_owner ON sep_anchor_intents(subject,created_at,id);
    CREATE UNIQUE INDEX IF NOT EXISTS sep_anchor_requested_quote ON sep_anchor_intents(subject,protocol,json_extract(body,'$.requested_quote')) WHERE json_extract(body,'$.requested_quote') IS NOT NULL;
    CREATE TABLE IF NOT EXISTS sep_anchor_actions (
      id TEXT PRIMARY KEY, intent_id TEXT NOT NULL, action_key TEXT NOT NULL,
      tx_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sep_anchor_action_owner ON sep_anchor_actions(intent_id);
    CREATE TABLE IF NOT EXISTS sep_anchor_bank_events (intent_id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sep_anchor_payments (operation_id TEXT PRIMARY KEY,intent_id TEXT,body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS sep_anchor_bank_reference ON sep_anchor_bank_events(json_extract(body,'$.event_id'));
    CREATE INDEX IF NOT EXISTS sep_anchor_payment_hash ON sep_anchor_payments(json_extract(body,'$.payment.transaction_hash'));
  `);
  return {
    requested(
      subject: string,
      protocol: string,
      quote: string
    ): SepIntent | null {
      const row = db
        .prepare(
          "SELECT body FROM sep_anchor_intents WHERE subject=? AND protocol=? AND json_extract(body,'$.requested_quote')=?"
        )
        .get(subject, protocol, quote);
      return row ? (JSON.parse(String(row.body)) as SepIntent) : null;
    },
    findReference(input: {
      stellar_transaction_id?: string;
      external_transaction_id?: string;
    }): string | null {
      const row = input.stellar_transaction_id
        ? db
            .prepare(
              `SELECT intent_id FROM sep_anchor_actions WHERE tx_hash=? UNION SELECT intent_id FROM sep_anchor_payments WHERE json_extract(body,'$.payment.transaction_hash')=? LIMIT 1`
            )
            .get(input.stellar_transaction_id, input.stellar_transaction_id)
        : db
            .prepare(
              "SELECT intent_id FROM sep_anchor_bank_events WHERE json_extract(body,'$.event_id')=?"
            )
            .get(input.external_transaction_id ?? "");
      return row?.intent_id ? String(row.intent_id) : null;
    },
    actions(intentId?: string): SepAction[] {
      const rows =
        intentId === undefined
          ? db
              .prepare("SELECT body FROM sep_anchor_actions ORDER BY rowid")
              .all()
          : db
              .prepare(
                "SELECT body FROM sep_anchor_actions WHERE intent_id=? ORDER BY rowid"
              )
              .all(intentId);
      return rows.map((row) => JSON.parse(String(row.body)) as SepAction);
    },
    saveAction(action: SepAction) {
      db.prepare(
        `INSERT INTO sep_anchor_actions(id,intent_id,action_key,tx_hash,status,body) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,body=excluded.body`
      ).run(
        action.id,
        action.intent_id,
        action.key,
        action.hash,
        action.status,
        JSON.stringify(action)
      );
    },
    bankEvent(id: string): GateReceipt | null {
      const row = db
        .prepare("SELECT body FROM sep_anchor_bank_events WHERE intent_id=?")
        .get(id);
      return row ? (JSON.parse(String(row.body)) as GateReceipt) : null;
    },
    saveBankEvent(id: string, receipt: GateReceipt) {
      db.prepare(
        "INSERT INTO sep_anchor_bank_events(intent_id,body) VALUES (?,?)"
      ).run(id, JSON.stringify(receipt));
    },
    payment(id: string): SepPayment | null {
      const row = db
        .prepare("SELECT body FROM sep_anchor_payments WHERE operation_id=?")
        .get(id);
      return row ? (JSON.parse(String(row.body)) as SepPayment) : null;
    },
    payments(id: string): SepPayment[] {
      return db
        .prepare(
          "SELECT body FROM sep_anchor_payments WHERE intent_id=? ORDER BY rowid"
        )
        .all(id)
        .map((row) => JSON.parse(String(row.body)) as SepPayment);
    },
    savePayment(value: SepPayment) {
      db.prepare(
        "INSERT INTO sep_anchor_payments(operation_id,intent_id,body) VALUES (?,?,?)"
      ).run(value.payment.operation_id, value.intent_id, JSON.stringify(value));
    },
    get(id: string): SepIntent | null {
      const row = db
        .prepare("SELECT body FROM sep_anchor_intents WHERE id = ?")
        .get(id);
      return row ? (JSON.parse(String(row.body)) as SepIntent) : null;
    },
    save(intent: SepIntent) {
      db.prepare(
        `INSERT INTO sep_anchor_intents(id,subject,customer_id,protocol,direction,created_at,updated_at,body)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,body=excluded.body`
      ).run(
        intent.id,
        intent.subject,
        intent.customer_id,
        intent.protocol,
        intent.direction,
        intent.created_at,
        intent.updated_at,
        JSON.stringify(intent)
      );
    },
    all(subject?: string): SepIntent[] {
      const rows =
        subject === undefined
          ? db
              .prepare(
                "SELECT body FROM sep_anchor_intents ORDER BY created_at DESC,id DESC"
              )
              .all()
          : db
              .prepare(
                "SELECT body FROM sep_anchor_intents WHERE subject = ? ORDER BY created_at DESC,id DESC"
              )
              .all(subject);
      return rows.map((row) => JSON.parse(String(row.body)) as SepIntent);
    },
  };
}
