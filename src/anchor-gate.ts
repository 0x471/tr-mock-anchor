import { createHash, randomBytes } from "node:crypto";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Deps } from "./context.js";
import { nowIso, tx } from "./db.js";
import { ApiError } from "./errors.js";
import { fmtTry, fmtUsdc, parseTry, parseUsdc } from "./money.js";
import type { QuoteRow } from "./core/types.js";
import type {
  GateActionKind,
  GateConfiguration,
  GateGateway,
  GateOrder,
  GateReceipt,
  GateTerms,
  PreparedGateAction,
} from "./anchor-gate-types.js";

interface OrderRow {
  id: string;
  customer_id: string;
  subject: string;
  quote_id: string;
  idempotency_key: string;
  request_hash: string;
  terms_json: string;
  config_json: string;
  amount_try: string;
  amount_token: string;
  chain_json: string | null;
  receipt_json: string | null;
}

interface ActionRow {
  id: string;
  order_id: string;
  kind: GateActionKind;
  transaction_hash: string;
  operator_envelope: string | null;
  expires_at: number;
  status: "prepared" | "pending" | "success" | "failed";
  ledger: number | null;
  created_at: string;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const unavailable = () =>
  new ApiError(
    503,
    "gate_unavailable",
    "The contract could not be confirmed. Retry reconciliation before another action."
  );

export function createGatedOnramp(deps: Deps, gate: GateGateway) {
  const { db, cfg } = deps;
  const now = () => Math.floor(Date.now() / 1000);
  function owned(id: string, subject: string): OrderRow {
    const row = db
      .prepare("SELECT * FROM anchor_gate_orders WHERE id = ? AND subject = ?")
      .get(id, subject) as unknown as OrderRow | undefined;
    if (!row) throw new ApiError(404, "order_not_found", "Order not found.");
    return row;
  }
  async function chainOrder(row: OrderRow): Promise<GateOrder | null> {
    const state = await gate.order(row.id).catch(() => {
      throw unavailable();
    });
    if (state) {
      const terms = JSON.parse(row.terms_json) as GateTerms;
      if (
        state.id !== row.id ||
        Object.entries(terms).some(
          ([key, value]) => state[key as keyof GateTerms] !== value
        )
      ) {
        throw new ApiError(
          503,
          "gate_state_mismatch",
          "Contract terms differ from the reserved order."
        );
      }
      db.prepare(
        "UPDATE anchor_gate_orders SET chain_json = ?, updated_at = ? WHERE id = ?"
      ).run(JSON.stringify(state), nowIso(), row.id);
    }
    return state;
  }
  async function reconcile(row: OrderRow) {
    const pending = db
      .prepare(
        "SELECT * FROM anchor_gate_actions WHERE order_id = ? AND status IN ('prepared','pending')"
      )
      .all(row.id) as unknown as ActionRow[];
    for (const action of pending) {
      const result = await gate
        .transaction(action.transaction_hash, {
          created_at: Math.floor(Date.parse(action.created_at) / 1000),
          expires_at: action.expires_at,
        })
        .catch(() => {
          throw unavailable();
        });
      db.prepare(
        "UPDATE anchor_gate_actions SET status = ?, ledger = ? WHERE id = ?"
      ).run(result.status, result.ledger, action.id);
    }
    return chainOrder(row);
  }
  function view(row: OrderRow, state: GateOrder | null) {
    const terms = JSON.parse(row.terms_json) as GateTerms;
    const config = JSON.parse(row.config_json) as GateConfiguration;
    const actions = db
      .prepare(
        "SELECT id, kind, transaction_hash, status, ledger, expires_at FROM anchor_gate_actions WHERE order_id = ? ORDER BY rowid"
      )
      .all(row.id);
    const stage = state?.stage ?? "registering";
    const expired = terms.deadline <= now();
    const eligible =
      !!state?.eligibility_expires_at &&
      state.eligibility_expires_at > now() &&
      !expired;
    return {
      id: row.id,
      quote_id: row.quote_id,
      recipient: terms.recipient,
      amount_try: row.amount_try,
      amount_token: row.amount_token,
      source_asset: "iso4217:TRY",
      token: config.token,
      contract: config.contract,
      stage,
      expired,
      deadline: terms.deadline,
      network: "testnet",
      created_at: state?.created_at ?? null,
      confirmed_ledger: state?.confirmed_ledger ?? null,
      eligibility_expires_at: state?.eligibility_expires_at ?? null,
      receipt_id: state?.receipt_id ?? null,
      bank_instructions:
        stage === "eligible" && eligible
          ? { simulated: true, amount_try: row.amount_try, reference: row.id }
          : null,
      completed: stage === "settled",
      actions,
    };
  }
  function saveAction(
    row: OrderRow,
    kind: GateActionKind,
    prepared: PreparedGateAction
  ): ActionRow {
    const id = randomBytes(16).toString("hex");
    const envelope = kind === "prove" ? null : prepared.transaction;
    db.prepare(
      "INSERT INTO anchor_gate_actions(id, order_id, kind, transaction_hash, operator_envelope, expires_at, status, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(
      id,
      row.id,
      kind,
      prepared.hash,
      envelope,
      prepared.expires_at,
      "prepared",
      nowIso()
    );
    return {
      id,
      order_id: row.id,
      kind,
      transaction_hash: prepared.hash,
      operator_envelope: envelope,
      expires_at: prepared.expires_at,
      status: "prepared",
      ledger: null,
      created_at: nowIso(),
    };
  }
  async function operatorAction(
    row: OrderRow,
    kind: Exclude<GateActionKind, "prove">,
    prepare: () => Promise<PreparedGateAction>
  ) {
    let action = db
      .prepare(
        "SELECT * FROM anchor_gate_actions WHERE order_id = ? AND kind = ? AND status IN ('prepared','pending') ORDER BY rowid DESC LIMIT 1"
      )
      .get(row.id, kind) as unknown as ActionRow | undefined;
    if (!action)
      action = saveAction(
        row,
        kind,
        await prepare().catch(() => {
          throw unavailable();
        })
      );
    if (!action.operator_envelope) throw unavailable();
    const result = await gate
      .submit(action.operator_envelope)
      .catch(() => ({ status: "pending" as const, ledger: null }));
    db.prepare(
      "UPDATE anchor_gate_actions SET status = ?, ledger = ? WHERE id = ?"
    ).run(result.status, result.ledger, action.id);
    return chainOrder(row);
  }
  function live(state: GateOrder | null): asserts state is GateOrder {
    if (!state)
      throw new ApiError(
        409,
        "order_pending",
        "Wait for confirmed onchain order creation."
      );
    if (state.stage === "settled")
      throw new ApiError(
        409,
        "order_settled",
        "This order is already settled."
      );
    if (state.deadline <= now())
      throw new ApiError(
        409,
        "order_expired",
        "The original order deadline has passed; its reservation remains held."
      );
  }
  function proofTransaction(
    row: OrderRow,
    envelope: string,
    expectedHash: string,
    expiresAt: number,
    signed: boolean
  ): Transaction {
    try {
      const transaction = TransactionBuilder.fromXdr(
        envelope,
        Networks.TESTNET
      );
      const contract = JSON.parse(row.config_json) as GateConfiguration;
      if (
        !(transaction instanceof Transaction) ||
        Buffer.from(transaction.hash()).toString("hex") !== expectedHash ||
        transaction.source !== row.subject ||
        BigInt(transaction.fee) > BigInt(cfg.anchorGateMaxFeeStroops) ||
        transaction.operations.length !== 1 ||
        Number(transaction.timeBounds?.maxTime) !== expiresAt ||
        expiresAt <= now()
      )
        throw new Error("transaction mismatch");
      const operation = transaction.operations[0]!;
      if (
        operation.type !== "invokeHostFunction" ||
        (operation.source && operation.source !== row.subject) ||
        operation.func.type !== "hostFunctionTypeInvokeContract"
      )
        throw new Error("unexpected operation");
      const invocation = operation.func.value;
      if (
        Address.fromScAddress(invocation.contractAddress).toString() !==
          contract.contract ||
        invocation.functionName.toString() !== "prove_order" ||
        invocation.args.length !== 3 ||
        Buffer.from(scValToNative(invocation.args[0]!) as Uint8Array).toString(
          "hex"
        ) !== row.id
      )
        throw new Error("unexpected proof call");
      if (
        signed &&
        !transaction.signatures.some((signature) =>
          Keypair.fromPublicKey(row.subject).verify(
            transaction.hash(),
            signature.signature
          )
        )
      )
        throw new Error("recipient signature absent");
      return transaction;
    } catch {
      throw new ApiError(
        422,
        "invalid_signed_transaction",
        "Sign the exact prepared Testnet proof transaction with the recipient account key; do not change its fee, operation, source or time bounds."
      );
    }
  }
  return {
    async create(
      subject: string,
      customerId: string,
      quoteId: string,
      key: string
    ) {
      const requestHash = hash(JSON.stringify(["gate-create-v1", quoteId]));
      let row = db
        .prepare(
          "SELECT * FROM anchor_gate_orders WHERE subject = ? AND idempotency_key = ?"
        )
        .get(subject, key) as unknown as OrderRow | undefined;
      if (row && row.request_hash !== requestHash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "This idempotency key already describes a different order."
        );
      if (!row) {
        const contract = await gate.configuration().catch(() => {
          throw unavailable();
        });
        if (
          contract.token !==
          new Asset(cfg.usdcCode, cfg.usdcIssuer).contractId(Networks.TESTNET)
        )
          throw new ApiError(
            503,
            "gate_asset_mismatch",
            "The configured quote asset is not the vault token."
          );
        row = tx(db, () => {
          const existing = db
            .prepare(
              "SELECT * FROM anchor_gate_orders WHERE subject = ? AND idempotency_key = ?"
            )
            .get(subject, key) as unknown as OrderRow | undefined;
          if (existing) {
            if (existing.request_hash !== requestHash)
              throw new ApiError(
                409,
                "idempotency_conflict",
                "This idempotency key already describes a different order."
              );
            return existing;
          }
          const quote = db
            .prepare("SELECT * FROM quotes WHERE id = ? AND customer_id = ?")
            .get(quoteId, customerId) as unknown as QuoteRow | undefined;
          if (!quote)
            throw new ApiError(
              404,
              "quote_not_found",
              "Quote not found for this wallet."
            );
          if (quote.consumed_by)
            throw new ApiError(
              409,
              "quote_consumed",
              "Quote already reserved."
            );
          const assets = db
            .prepare(
              "SELECT sell_asset, buy_asset FROM quote_assets WHERE quote_id = ?"
            )
            .get(quote.id);
          if (
            !assets ||
            assets.sell_asset !== "iso4217:TRY" ||
            assets.buy_asset !== `stellar:${cfg.usdcCode}:${cfg.usdcIssuer}`
          )
            throw new ApiError(
              422,
              "quote_asset_mismatch",
              "A new quote with the exact vault asset is required."
            );
          const deadline = Math.min(
            now() + contract.max_order_lifetime,
            contract.policy_valid_until
          );
          if (
            !Number.isSafeInteger(deadline) ||
            deadline <= now() ||
            !Number.isFinite(Date.parse(quote.expires_at)) ||
            Date.parse(quote.expires_at) <= Date.now()
          )
            throw new ApiError(
              409,
              "quote_expired",
              "A fresh quote is required."
            );
          if (
            quote.side !== "buy" ||
            quote.source_currency !== "TRY" ||
            quote.destination_currency !== cfg.usdcCode
          )
            throw new ApiError(
              422,
              "quote_pair",
              "The gate only supports the exact TRY-to-token quote."
            );
          const tryMinor = parseTry(quote.source_amount);
          const amount = parseUsdc(quote.destination_amount);
          if (
            tryMinor <= 0n ||
            amount <= 0n ||
            tryMinor > BigInt(contract.max_try_minor) ||
            amount > BigInt(contract.max_amount)
          )
            throw new ApiError(
              422,
              "quote_limits",
              "Quote exceeds the immutable vault limits."
            );
          const id = randomBytes(32).toString("hex");
          const quoteHash = hash(
            JSON.stringify([
              "anchor-quote-v1",
              Networks.TESTNET,
              contract.contract,
              contract.token,
              cfg.usdcCode,
              cfg.usdcIssuer,
              subject,
              quote.id,
              quote.source_currency,
              tryMinor.toString(),
              quote.destination_currency,
              amount.toString(),
              quote.rate,
              quote.mid_rate,
              quote.spread_bps,
              quote.rate_source,
              quote.expires_at,
            ])
          );
          const terms: GateTerms = {
            recipient: subject,
            quote_hash: quoteHash,
            try_minor: tryMinor.toString(),
            amount: amount.toString(),
            deadline,
            nonce: randomBytes(32).toString("hex"),
          };
          const changed = db
            .prepare(
              "UPDATE quotes SET consumed_by = ? WHERE id = ? AND consumed_by IS NULL"
            )
            .run(id, quote.id);
          if (changed.changes !== 1)
            throw new ApiError(
              409,
              "quote_consumed",
              "Quote already reserved."
            );
          db.prepare(
            "INSERT INTO anchor_gate_orders(id, customer_id, subject, quote_id, idempotency_key, request_hash, terms_json, config_json, amount_try, amount_token, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
          ).run(
            id,
            customerId,
            subject,
            quoteId,
            key,
            requestHash,
            JSON.stringify(terms),
            JSON.stringify(contract),
            fmtTry(tryMinor),
            fmtUsdc(amount),
            nowIso(),
            nowIso()
          );
          return owned(id, subject);
        });
      }
      let state = await reconcile(row);
      if (!state)
        state = await operatorAction(row, "create", () =>
          gate.prepareCreate(row!.id, JSON.parse(row!.terms_json) as GateTerms)
        );
      return view(row, state);
    },
    async get(id: string, subject: string) {
      const row = owned(id, subject);
      return view(row, await reconcile(row));
    },
    async proofRequest(id: string, subject: string) {
      const row = owned(id, subject);
      const state = await reconcile(row);
      live(state);
      const config = JSON.parse(row.config_json) as GateConfiguration;
      return {
        domain: config.domain,
        scope: config.scope,
        custom_data: state.challenge,
        policy: config.policy,
        expires_at: state.deadline,
        created_at: state.created_at,
        proof_bytes: config.proof_bytes,
        external_inputs: config.external_inputs,
        dev_mode: true,
        proof_type: "compressed-evm",
        nullifier_type: 2,
      };
    },
    async prepareProof(
      id: string,
      subject: string,
      proof: Buffer,
      publicInputs: Buffer
    ) {
      const row = owned(id, subject);
      live(await reconcile(row));
      const config = JSON.parse(row.config_json) as GateConfiguration;
      if (
        proof.length !== config.proof_bytes ||
        publicInputs.length !== config.external_inputs * 32
      )
        throw new ApiError(
          422,
          "proof_length",
          "Proof and public-input lengths must match the immutable verifier profile."
        );
      if (
        db
          .prepare(
            "SELECT id FROM anchor_gate_actions WHERE order_id = ? AND kind = 'prove' AND status IN ('prepared','pending')"
          )
          .get(id)
      )
        throw new ApiError(
          409,
          "proof_action_pending",
          "Reconcile or submit the existing prepared proof transaction before preparing another."
        );
      const prepared = await gate
        .prepareProof(id, subject, proof, publicInputs)
        .catch(() => {
          throw unavailable();
        });
      proofTransaction(
        row,
        prepared.transaction,
        prepared.hash,
        prepared.expires_at,
        false
      );
      const action = saveAction(row, "prove", prepared);
      return {
        action_id: action.id,
        ...prepared,
        network_passphrase: Networks.TESTNET,
      };
    },
    async submitProof(
      id: string,
      subject: string,
      actionId: string,
      envelope: string
    ) {
      const row = owned(id, subject);
      const action = db
        .prepare(
          "SELECT * FROM anchor_gate_actions WHERE id = ? AND order_id = ? AND kind = 'prove'"
        )
        .get(actionId, id) as unknown as ActionRow | undefined;
      if (!action)
        throw new ApiError(
          404,
          "action_not_found",
          "Prepared proof action not found."
        );
      const state = await reconcile(row);
      if (state?.stage === "settled" || action.status === "success")
        return view(row, state);
      live(state);
      proofTransaction(
        row,
        envelope,
        action.transaction_hash,
        action.expires_at,
        true
      );
      const result = await gate
        .submit(envelope)
        .catch(() => ({ status: "pending" as const, ledger: null }));
      db.prepare(
        "UPDATE anchor_gate_actions SET status = ?, ledger = ? WHERE id = ?"
      ).run(result.status, result.ledger, action.id);
      return view(row, await chainOrder(row));
    },
    async simulateBank(id: string, subject: string) {
      const row = owned(id, subject);
      let state = await reconcile(row);
      if (state?.receipt_id || state?.stage === "settled")
        return view(row, state);
      if (!row.receipt_json) {
        live(state);
        if (
          !state.eligibility_expires_at ||
          state.eligibility_expires_at <= now()
        )
          throw new ApiError(
            409,
            "eligibility_required",
            "The contract must confirm current eligibility before a mock deposit."
          );
        const receipt: GateReceipt = {
          event_id: hash(
            JSON.stringify([
              "anchor-mock-bank-v1",
              (JSON.parse(row.config_json) as GateConfiguration).contract,
              id,
            ])
          ),
          quote_hash: state.quote_hash,
          try_minor: state.try_minor,
          received_at: now(),
        };
        db.prepare(
          "UPDATE anchor_gate_orders SET receipt_json = ?, updated_at = ? WHERE id = ? AND receipt_json IS NULL"
        ).run(JSON.stringify(receipt), nowIso(), id);
        row.receipt_json = owned(id, subject).receipt_json;
      }
      const receipt = JSON.parse(row.receipt_json!) as GateReceipt;
      state = await operatorAction(row, "receipt", () =>
        gate.prepareReceipt(id, receipt)
      );
      return view(row, state);
    },
    async settle(id: string, subject: string) {
      const row = owned(id, subject);
      let state = await reconcile(row);
      if (state?.stage === "settled") return view(row, state);
      live(state);
      if (!state.receipt_id)
        throw new ApiError(
          409,
          "receipt_required",
          "The contract must confirm the exact mock-bank receipt before settlement."
        );
      if (
        !state.eligibility_expires_at ||
        state.eligibility_expires_at <= now()
      )
        throw new ApiError(
          409,
          "eligibility_required",
          "Refresh eligibility before settlement without changing the original deadline."
        );
      state = await operatorAction(row, "settle", () =>
        gate.prepareSettlement(id)
      );
      return view(row, state);
    },
  };
}
