import type { Deps } from "./context.js";
import type {
  SepAnchorConfiguration,
  SepAnchorGateway,
  SepEligibility,
  SepChainAction,
  SepChainOrder,
} from "./sep-anchor-types.js";
import {
  Asset,
  Networks,
  StrKey,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "./errors.js";
import { nowIso, tx, kvGet, kvSet } from "./db.js";
import { TRY_ASSET, usdcAsset } from "./core/sep.js";
import {
  createSepAnchorStorage,
  type SepIntent,
  type SepAction,
} from "./sep-anchor-storage.js";
import { createSepQuote, readSepQuote } from "./sep-quotes.js";
import { parseTry, parseUsdc, fmtUsdc } from "./money.js";

export interface SepAnchorInput {
  account?: string;
  amount?: string;
  quote_id?: string;
  bank_destination?: string;
}

export interface SepAnchorView {
  id: string;
  kind: "deposit" | "withdrawal";
  protocol: "sep6" | "sep24";
  status:
    | "incomplete"
    | "pending_customer_info_update"
    | "pending_trust"
    | "pending_user"
    | "pending_user_transfer_start"
    | "pending_anchor"
    | "pending_stellar"
    | "pending_external"
    | "completed"
    | "refunded"
    | "expired"
    | "error";
  required_customer_info_updates: string[];
  more_info_url: string;
  message: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  quote_id: string | null;
  requested_amount: string | null;
  requested_quote_id: string | null;
  amount_in: string | null;
  amount_in_asset: string;
  amount_out: string | null;
  amount_out_asset: string;
  amount_fee: string | null;
  amount_fee_asset: string;
  from: string | null;
  to: string | null;
  wallet: string;
  contract: string;
  policy: SepAnchorConfiguration["policy"];
  order_id: string | null;
  native: {
    eligible: boolean;
    valid_until: number | null;
    confirmed_ledger: number | null;
  };
  ready_for_payment: boolean;
  escrowed: boolean;
  payout_authorized: boolean;
  can_refund: boolean;
  recovery_required: boolean;
  payment_recovery_required: boolean;
  stellar_transaction_id: string | null;
  external_transaction_id: string | null;
  withdraw_anchor_account: string | null;
  withdraw_memo: string | null;
  withdraw_memo_type: "hash" | null;
  instructions: Record<string, { value: string; description: string }> | null;
  refunded: boolean;
  refunds: {
    amount_refunded: string;
    amount_fee: string;
    payments: { id: string; id_type: "stellar"; amount: string; fee: string }[];
  } | null;
  actions: {
    kind: string;
    transaction_hash: string;
    status: string;
    ledger: number | null;
  }[];
}

export interface SepAnchorProofRequest {
  domain: string;
  scope: string;
  custom_data: string;
  policy: SepAnchorConfiguration["policy"];
  expires_at: number;
  proof_bytes: number;
  external_inputs: number;
  dev_mode: true;
  proof_type: "compressed-evm";
  nullifier_type: 2;
}

export function createSepAnchor(deps: Deps, gateway: SepAnchorGateway) {
  const store = createSepAnchorStorage(deps.db);
  const hash = (input: unknown) =>
    createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const subjectHash = (subject: string) =>
    createHash("sha256")
      .update(
        xdr.ScVal.scvVec([
          nativeToScVal("sep-anchor-subject-v1", { type: "string" }),
          nativeToScVal(subject, { type: "string" }),
        ]).toXdr()
      )
      .digest("hex");
  const asset = usdcAsset(deps.cfg.usdcCode, deps.cfg.usdcIssuer);
  let queue = Promise.resolve();
  const locked = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(work);
    queue = result.then(
      () => {},
      () => {}
    );
    return result;
  };
  const owned = (subject: string, id: string) => {
    const row = store.get(id);
    if (!row || row.subject !== subject)
      throw new ApiError(
        404,
        "transaction_not_found",
        "Transaction not found."
      );
    return row;
  };
  async function eligibility(subject: string) {
    const grant = await gateway.eligibility(subjectHash(subject));
    const now = Math.floor(Date.now() / 1000);
    return grant &&
      grant.confirmed_ledger > 0 &&
      grant.proof_time <= now &&
      grant.valid_until > now
      ? grant
      : null;
  }
  function save(row: SepIntent) {
    row.updated_at = nowIso();
    store.save(row);
  }
  function sameConfig(a: SepAnchorConfiguration, b: SepAnchorConfiguration) {
    return (
      a.contract === b.contract &&
      a.policy_hash === b.policy_hash &&
      a.token === b.token &&
      a.provider === b.provider &&
      a.bank_notary === b.bank_notary
    );
  }
  async function configuration(row: SepIntent) {
    const current = await gateway.configuration();
    if (!sameConfig(row.config, current))
      throw new ApiError(
        409,
        "anchor_configuration_changed",
        "This order belongs to a different native deployment or policy. Do not replace it; contact the demo operator."
      );
    return current;
  }
  function validateIngress(row: SepIntent) {
    const ingress = deps.sepAnchorIngress;
    if (
      !ingress ||
      ingress.account !== row.config.provider ||
      ingress.asset !== asset
    )
      throw new ApiError(
        503,
        "withdrawal_ingress_unavailable",
        "The exact dedicated Testnet payment receiver is not configured."
      );
    return ingress;
  }
  async function recipientReady(row: SepIntent) {
    if (row.direction !== "deposit" || !row.terms || terminal(row)) return true;
    return (
      (await validateIngress(row).recipientStatus(
        row.subject,
        row.terms.amount
      )) === "ready"
    );
  }
  function checkChain(row: SepIntent, chain: SepChainOrder) {
    if (
      !row.terms ||
      chain.id !== row.id ||
      chain.policy_hash !== row.config.policy_hash ||
      chain.confirmed_ledger <= 0 ||
      Object.entries(row.terms).some(
        ([key, value]) => chain[key as keyof SepChainOrder] !== value
      )
    )
      throw new ApiError(
        409,
        "native_order_mismatch",
        "The confirmed native order does not match the accepted terms."
      );
    const floor = Math.max(
      row.chain?.confirmed_ledger ?? 0,
      ...store
        .actions(row.id)
        .filter((action) => action.status === "success")
        .map((action) => action.ledger ?? 0)
    );
    if (chain.confirmed_ledger < floor)
      throw new ApiError(
        503,
        "native_order_stale",
        "Wait for a current ledger before continuing this exact order."
      );
  }
  async function sync(row: SepIntent) {
    await configuration(row);
    const chain = await gateway.order(row.id);
    if (chain) {
      checkChain(row, chain);
      row.chain = chain;
      save(row);
    } else if (row.chain)
      throw new ApiError(
        503,
        "native_order_unavailable",
        "A previously confirmed order could not be read. Do not send funds or replace it."
      );
  }
  async function reconcileAction(action: SepAction, replay = true) {
    if (action.status === "success" || action.status === "failed") return;
    const state = await gateway.transaction(action.hash, {
      min_time: action.min_time ?? 0,
      expires_at: action.expires_at,
    });
    if (state.status === "pending" && replay) {
      try {
        const submitted = await gateway.submit(action.transaction);
        action.status = submitted.status;
        action.ledger = submitted.ledger;
      } catch {
        action.status = "pending";
      }
    } else {
      action.status = state.status;
      action.ledger = state.ledger;
    }
    store.saveAction(action);
  }
  async function perform(row: SepIntent, key: string, action: SepChainAction) {
    for (const pending of store
      .actions()
      .filter(
        (item) => item.status === "prepared" || item.status === "pending"
      ))
      await reconcileAction(pending);
    const previous = store
      .actions(row.id)
      .filter((item) => item.key === key)
      .at(-1);
    if (previous?.status === "success") return true;
    if (
      store
        .actions()
        .some((item) => item.status === "prepared" || item.status === "pending")
    )
      return false;
    const prepared = await gateway.prepare(action);
    if (
      !/^[0-9a-f]{64}$/.test(prepared.hash) ||
      !Number.isSafeInteger(prepared.expires_at) ||
      prepared.expires_at <= Math.floor(Date.now() / 1000)
    )
      throw new ApiError(
        503,
        "invalid_prepared_action",
        "The native action could not be safely prepared."
      );
    const pending: SepAction = {
      ...prepared,
      id: randomBytes(16).toString("hex"),
      intent_id: row.id,
      kind: action.kind,
      key,
      status: "prepared",
      ledger: null,
    };
    store.saveAction(pending);
    try {
      const result = await gateway.submit(pending.transaction);
      pending.status = result.status;
      pending.ledger = result.ledger;
    } catch {
      pending.status = "pending";
    }
    store.saveAction(pending);
    return pending.status === "success";
  }
  const terminal = (row: SepIntent) =>
    !!(
      row.chain?.settled_at ||
      row.chain?.refunded_at ||
      row.chain?.cancelled_at
    );
  async function ingest() {
    const ingress = deps.sepAnchorIngress;
    if (!ingress) return;
    const config = await gateway.configuration();
    if (ingress.account !== config.provider || ingress.asset !== asset)
      throw new ApiError(
        503,
        "withdrawal_ingress_unavailable",
        "The configured withdrawal receiver does not match the native provider."
      );
    const cursorKey = `sep-anchor-ingress:${config.contract}:${ingress.account}:${ingress.asset}`;
    const page = await ingress.payments(kvGet(deps.db, cursorKey) ?? undefined);
    tx(deps.db, () => {
      for (const payment of page.payments) {
        if (
          !/^\d+$/.test(payment.operation_id) ||
          !/^\d+$/.test(payment.paging_token) ||
          !/^[a-f0-9]{64}$/.test(payment.transaction_hash)
        )
          throw new Error("Invalid confirmed payment identity");
        if (store.payment(payment.operation_id)) continue;
        const decoded =
          payment.memo_type === "hash" && payment.memo
            ? Buffer.from(payment.memo, "base64")
            : null;
        const id =
          decoded?.length === 32 && decoded.toString("base64") === payment.memo
            ? decoded.toString("hex")
            : null;
        const row = id ? store.get(id) : null;
        const receivedAt = Date.parse(payment.created_at) / 1000;
        let reason: string | null = null;
        if (!row || !row.terms || !row.chain || row.direction !== "withdrawal")
          reason =
            "Payment does not identify a confirmed withdrawal order. Operator recovery is required.";
        else if (
          row.config.contract !== config.contract ||
          payment.from !== row.subject ||
          payment.to !== ingress.account ||
          payment.asset !== ingress.asset
        )
          reason =
            "Payment sender, receiver, asset or deployment does not match the exact withdrawal. Operator recovery is required.";
        else if (
          !/^\d+$/.test(payment.amount) ||
          BigInt(payment.amount) !== BigInt(row.terms.amount)
        )
          reason =
            "Payment amount does not match the accepted quote. No repricing or automatic refund will occur.";
        else if (
          !Number.isFinite(receivedAt) ||
          receivedAt < row.chain.created_at ||
          receivedAt >= row.terms.deadline ||
          terminal(row)
        )
          reason =
            "Payment was received outside the valid native order window. Operator recovery is required.";
        else if (
          store.payments(row.id).some((item) => item.status === "accepted") ||
          row.chain.funding_id
        )
          reason =
            "An additional payment was received for an already funded withdrawal. Operator recovery is required.";
        store.savePayment({
          payment,
          intent_id: row?.id ?? null,
          status: reason ? "recovery" : "accepted",
          reason,
        });
        const canonical =
          !!row &&
          (store.payments(row.id).some((item) => item.status === "accepted") ||
            !!row.chain?.funding_id ||
            terminal(row));
        if (
          row &&
          reason &&
          !canonical &&
          payment.from === row.subject &&
          payment.to === ingress.account &&
          payment.asset === ingress.asset
        ) {
          row.recovery_reason = reason;
          save(row);
        }
      }
      if (page.cursor !== undefined) {
        if (!/^\d+$/.test(page.cursor))
          throw new Error("Invalid payment cursor");
        kvSet(deps.db, cursorKey, page.cursor);
      }
    });
  }
  async function advance(row: SepIntent) {
    const actions = store.actions(row.id);
    if (!row.terms && !row.chain && actions.length === 0) return;
    for (const action of actions) await reconcileAction(action);
    await sync(row);
    if (terminal(row) || row.recovery_reason || !row.terms) return;
    const grant = await eligibility(row.subject);
    if (
      !row.chain &&
      grant &&
      row.terms.deadline > Math.floor(Date.now() / 1000)
    ) {
      await perform(row, "create", {
        kind: "create",
        id: row.id,
        terms: row.terms,
      });
      await sync(row);
    }
    if (
      row.chain &&
      row.direction === "withdrawal" &&
      !row.chain.escrowed &&
      !row.chain.funding_id
    ) {
      const paid = store
        .payments(row.id)
        .find((item) => item.status === "accepted");
      if (paid) {
        await perform(row, "fund", {
          kind: "fund",
          id: row.id,
          operation_id: hash([
            "sep-anchor-payment-v1",
            paid.payment.operation_id,
          ]),
        });
        await sync(row);
      }
    }
    if (
      row.bank_requested &&
      row.chain?.escrowed &&
      row.direction === "withdrawal" &&
      row.chain.payout_authorized_at === null &&
      grant &&
      row.chain.deadline > Math.floor(Date.now() / 1000)
    ) {
      await perform(row, "authorize", { kind: "authorize", id: row.id });
      await sync(row);
    }
    if (
      row.bank_requested &&
      row.chain &&
      !store.bankEvent(row.id) &&
      (row.direction === "withdrawal"
        ? row.chain.payout_authorized_at !== null
        : !!grant &&
          row.chain.deadline > Math.floor(Date.now() / 1000) &&
          (await recipientReady(row)))
    ) {
      const current = await configuration(row);
      const earliest = row.chain.payout_authorized_at ?? row.chain.created_at;
      if (current.ledger_time >= earliest)
        store.saveBankEvent(row.id, {
          event_id: randomBytes(32).toString("hex"),
          quote_hash: row.chain.quote_hash,
          try_minor: row.chain.try_minor,
          bank_destination_hash: row.chain.bank_destination_hash,
          received_at: current.ledger_time,
        });
    }
    const event = store.bankEvent(row.id);
    if (row.chain && event && !row.chain.receipt) {
      await perform(row, "receipt", {
        kind: "receipt",
        id: row.id,
        receipt: event,
      });
      await sync(row);
    }
    if (
      row.chain?.receipt &&
      row.chain.escrowed &&
      (row.direction === "withdrawal"
        ? row.chain.payout_authorized_at !== null
        : !!grant &&
          row.chain.deadline > Math.floor(Date.now() / 1000) &&
          (await recipientReady(row)))
    ) {
      await perform(row, "settle", { kind: "settle", id: row.id });
      await sync(row);
    }
  }
  async function view(row: SepIntent): Promise<SepAnchorView> {
    const grant = await eligibility(row.subject);
    const chain = row.chain;
    const received = store
      .payments(row.id)
      .find((item) => item.status === "accepted");
    const recipient = await recipientReady(row);
    const paymentCandidate =
      !!chain &&
      !!grant &&
      recipient &&
      !terminal(row) &&
      !row.recovery_reason &&
      chain.deadline > Math.floor(Date.now() / 1000) &&
      !chain.receipt &&
      !store.bankEvent(row.id) &&
      (row.direction === "deposit" || (!chain.escrowed && !received));
    const receiverReady =
      !paymentCandidate ||
      row.direction !== "withdrawal" ||
      (await validateIngress(row).recipientStatus(
        row.config.provider,
        chain.amount
      )) === "ready";
    const ready = paymentCandidate && receiverReady;
    const actions = store.actions(row.id);
    const pending = actions.some(
      (action) => action.status === "pending" || action.status === "prepared"
    );
    const refundHash = actions.find(
      (action) => action.kind === "refund" && action.status === "success"
    )?.hash;
    const expired =
      !!row.terms && row.terms.deadline <= Math.floor(Date.now() / 1000);
    const lateDeposit =
      row.direction === "deposit" &&
      expired &&
      !!(chain?.receipt || store.bankEvent(row.id)) &&
      !chain?.settled_at;
    const status: SepAnchorView["status"] = chain?.settled_at
      ? "completed"
      : chain?.refunded_at
        ? "refunded"
        : chain?.cancelled_at
          ? "expired"
          : row.recovery_reason || lateDeposit
            ? "error"
            : pending
              ? "pending_stellar"
              : received && !chain?.escrowed
                ? "pending_anchor"
                : expired && !chain?.escrowed
                  ? "expired"
                  : !recipient
                    ? "pending_trust"
                    : !receiverReady
                      ? "pending_anchor"
                      : ready
                        ? "pending_user_transfer_start"
                        : chain?.escrowed &&
                            (row.direction === "withdrawal" || expired)
                          ? "pending_user"
                          : row.protocol === "sep6" && !grant
                            ? "pending_customer_info_update"
                            : row.terms && grant && !chain
                              ? "pending_anchor"
                              : "incomplete";
    const message =
      row.recovery_reason ??
      (!receiverReady
        ? "The anchor's Testnet receiving account cannot accept this amount yet. Do not send tokens; status updates automatically."
        : lateDeposit
          ? "The funded deposit deadline passed before native settlement. Operator recovery is required; no automatic refund or replacement is available."
          : status === "completed"
            ? "The exact exchange is confirmed on Testnet."
            : status === "refunded"
              ? "The exact token refund is confirmed on Testnet."
              : status === "expired"
                ? "This order cannot accept payment. No expiry is an automatic refund."
                : status === "pending_trust"
                  ? "Your Testnet account needs the exact demo token trustline, authorization and enough receiving capacity before any simulated bank deposit."
                  : status === "pending_user"
                    ? expired
                      ? "The payment window is closed. Exact escrow may be refunded or the unused deposit reservation cancelled before any bank obligation."
                      : "Tokens are escrowed. Authorize the simulated TRY payout, or request an exact token refund before authorization."
                    : status === "pending_user_transfer_start"
                      ? "Native eligibility and exact payment instructions are confirmed. Send only the stated demo amount."
                      : pending
                        ? "A native transaction is pending. Reconciliation will check its exact hash; do not send another payment."
                        : "Accept a firm quote and prove eligibility with a synthetic document.");
    return {
      id: row.id,
      kind: row.direction,
      protocol: row.protocol,
      status,
      required_customer_info_updates:
        status === "pending_customer_info_update" ? ["zkpassport_proof"] : [],
      more_info_url: `${deps.cfg.publicUrl}/sep24/interactive/${row.id}`,
      message,
      started_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: chain?.settled_at
        ? new Date(chain.settled_at * 1000).toISOString()
        : chain?.refunded_at
          ? new Date(chain.refunded_at * 1000).toISOString()
          : null,
      quote_id: row.quote?.id ?? null,
      requested_amount: row.requested_amount,
      requested_quote_id: row.requested_quote,
      amount_in: row.quote?.sell_amount ?? null,
      amount_in_asset: row.direction === "deposit" ? TRY_ASSET : asset,
      amount_out: row.quote?.buy_amount ?? null,
      amount_out_asset: row.direction === "deposit" ? asset : TRY_ASSET,
      amount_fee: row.quote?.fee.total ?? null,
      amount_fee_asset: row.direction === "deposit" ? TRY_ASSET : asset,
      from: row.direction === "withdrawal" ? row.subject : null,
      to: row.direction === "deposit" ? row.subject : row.bank_destination,
      wallet: row.subject,
      contract: row.config.contract,
      policy: row.config.policy,
      order_id: row.chain?.id ?? null,
      native: {
        eligible: !!grant,
        valid_until: grant?.valid_until ?? null,
        confirmed_ledger: grant?.confirmed_ledger ?? null,
      },
      ready_for_payment: ready,
      recovery_required: !!row.recovery_reason || lateDeposit,
      stellar_transaction_id:
        row.direction === "withdrawal"
          ? (store.payments(row.id).find((item) => item.status === "accepted")
              ?.payment.transaction_hash ?? null)
          : (actions.find(
              (action) =>
                action.kind === "settle" && action.status === "success"
            )?.hash ?? null),
      external_transaction_id: store.bankEvent(row.id)?.event_id ?? null,
      payment_recovery_required: store
        .payments(row.id)
        .some(
          (item) =>
            item.status === "recovery" && item.payment.from === row.subject
        ),
      escrowed: !!chain?.escrowed,
      payout_authorized: chain?.payout_authorized_at != null,
      can_refund:
        !!chain?.escrowed &&
        !terminal(row) &&
        !row.recovery_reason &&
        !store.bankEvent(row.id) &&
        chain.payout_authorized_at === null &&
        !chain.receipt &&
        !pending,
      withdraw_anchor_account:
        ready && row.direction === "withdrawal" ? row.config.provider : null,
      withdraw_memo:
        ready && row.direction === "withdrawal"
          ? Buffer.from(row.id, "hex").toString("base64")
          : null,
      withdraw_memo_type:
        ready && row.direction === "withdrawal" ? "hash" : null,
      instructions:
        ready && row.direction === "deposit"
          ? {
              reference: {
                value: row.id,
                description:
                  "Synthetic bank reference. Use the explicit mock-bank action; do not send real money.",
              },
              amount: {
                value: row.quote!.sell_amount,
                description: "Exact simulated TRY amount.",
              },
            }
          : null,
      refunded: !!chain?.refunded_at,
      refunds: chain?.refunded_at
        ? {
            amount_refunded: fmtUsdc(BigInt(chain.amount)),
            amount_fee: "0.0000000",
            payments: refundHash
              ? [
                  {
                    id: refundHash,
                    id_type: "stellar",
                    amount: fmtUsdc(BigInt(chain.amount)),
                    fee: "0.0000000",
                  },
                ]
              : [],
          }
        : null,
      actions: actions.map((action) => ({
        kind: action.kind,
        transaction_hash: action.hash,
        status: action.status,
        ledger: action.ledger,
      })),
    };
  }
  return {
    async configuration() {
      const result = await gateway.configuration();
      if (
        result.token !==
          new Asset(deps.cfg.usdcCode, deps.cfg.usdcIssuer).contractId(
            Networks.TESTNET
          ) ||
        result.policy_valid_until <= Math.floor(Date.now() / 1000)
      )
        throw new ApiError(
          503,
          "native_configuration_unavailable",
          "The exact native Testnet asset and current policy must be confirmed."
        );
      return result;
    },
    async begin(
      subject: string,
      customerId: string,
      protocol: "sep6" | "sep24",
      direction: "deposit" | "withdrawal",
      input: SepAnchorInput = {}
    ): Promise<SepAnchorView> {
      return locked(async () => {
        if (
          !StrKey.isValidEd25519PublicKey(subject) ||
          (input.account !== undefined && input.account !== subject)
        )
          throw new ApiError(
            400,
            "unsupported_account",
            "Use the authenticated plain G account as the destination."
          );
        const customer = deps.db
          .prepare("SELECT external_id FROM customers WHERE id = ?")
          .get(customerId);
        if (customer?.external_id !== subject)
          throw new ApiError(
            403,
            "customer_mismatch",
            "The customer does not own this account."
          );
        if (input.quote_id) {
          const previous = store.requested(subject, protocol, input.quote_id);
          if (previous) {
            if (
              previous.direction !== direction ||
              previous.customer_id !== customerId ||
              previous.requested_amount !== (input.amount ?? null) ||
              previous.requested_bank_destination !==
                (input.bank_destination ?? null)
            )
              throw new ApiError(
                409,
                "initiation_conflict",
                "This quote already identifies a transaction with different requested terms."
              );
            await advance(previous);
            return view(previous);
          }
        }
        if (
          deps.cfg.anchorGateAllowedWallets.length &&
          !deps.cfg.anchorGateAllowedWallets.includes(subject)
        )
          throw new ApiError(
            403,
            "wallet_not_admitted",
            "This wallet is not admitted for new demo transactions."
          );
        if (deps.cfg.anchorGateOfacEnabled) {
          const screening = await deps.ofac?.check(subject);
          if (screening?.status === "match")
            throw new ApiError(
              403,
              "ofac_precheck_match",
              "This wallet matches a listed OFAC digital-currency address."
            );
          if (screening?.status !== "no_match")
            throw new ApiError(
              503,
              "ofac_precheck_unavailable",
              "New transactions are paused until wallet screening is available."
            );
        }
        const configuration = await gateway.configuration();
        if (
          configuration.token !==
          new Asset(deps.cfg.usdcCode, deps.cfg.usdcIssuer).contractId(
            Networks.TESTNET
          )
        )
          throw new ApiError(
            503,
            "anchor_asset_mismatch",
            "The configured asset does not match the native vault."
          );
        if (configuration.policy_valid_until <= Math.floor(Date.now() / 1000))
          throw new ApiError(
            503,
            "policy_expired",
            "The native policy has expired."
          );
        const created = nowIso();
        const row: SepIntent = {
          id: randomBytes(32).toString("hex"),
          subject,
          customer_id: customerId,
          protocol,
          direction,
          requested_amount: input.amount ?? null,
          requested_quote: input.quote_id ?? null,
          requested_bank_destination: input.bank_destination ?? null,
          config: configuration,
          quote: null,
          terms: null,
          bank_destination: input.bank_destination ?? null,
          bank_requested: false,
          chain: null,
          recovery_reason: null,
          created_at: created,
          updated_at: created,
        };
        store.save(row);
        return view(row);
      });
    },
    async get(subject: string, id: string): Promise<SepAnchorView> {
      return locked(async () => {
        const row = owned(subject, id);
        await advance(row);
        return view(row);
      });
    },
    async find(
      subject: string,
      input: {
        id?: string;
        stellar_transaction_id?: string;
        external_transaction_id?: string;
      }
    ): Promise<SepAnchorView> {
      return locked(async () => {
        const id = input.id ?? store.findReference(input);
        if (!id)
          throw new ApiError(
            404,
            "transaction_not_found",
            "Transaction not found."
          );
        const row = owned(subject, id);
        await advance(row);
        return view(row);
      });
    },
    async list(
      subject: string,
      options: {
        kind?: "deposit" | "withdrawal";
        limit?: number;
        no_older_than?: string;
        paging_id?: string;
      } = {}
    ): Promise<SepAnchorView[]> {
      return locked(async () => {
        let rows = store.all(subject);
        if (options.kind)
          rows = rows.filter((row) => row.direction === options.kind);
        if (options.no_older_than)
          rows = rows.filter((row) => row.created_at >= options.no_older_than!);
        if (options.paging_id) {
          const cursor = owned(subject, options.paging_id);
          rows = rows.filter(
            (row) =>
              row.created_at < cursor.created_at ||
              (row.created_at === cursor.created_at && row.id < cursor.id)
          );
        }
        const selected = rows.slice(
          0,
          Math.min(100, Math.max(1, options.limit ?? 10))
        );
        for (const row of selected) await advance(row);
        return Promise.all(selected.map(view));
      });
    },
    async quote(
      subject: string,
      id: string,
      input: { sell_amount?: string; buy_amount?: string }
    ) {
      return locked(async () => {
        const row = owned(subject, id);
        if (row.quote)
          throw new ApiError(
            409,
            "quote_already_accepted",
            "This transaction already has an accepted quote."
          );
        let current: SepAnchorConfiguration;
        try {
          current = await configuration(row);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(
            503,
            "native_configuration_unavailable",
            "Current native quote limits could not be confirmed."
          );
        }
        return createSepQuote(
          deps,
          row.customer_id,
          {
            ...input,
            sell_asset: row.direction === "deposit" ? TRY_ASSET : asset,
            buy_asset: row.direction === "deposit" ? asset : TRY_ASSET,
            context: row.protocol,
          },
          current
        );
      });
    },
    async readQuote(subject: string, id: string, quoteId: string) {
      const row = owned(subject, id);
      return readSepQuote(deps, row.customer_id, quoteId);
    },
    async accept(
      subject: string,
      id: string,
      quoteId: string,
      bankDestination?: string
    ): Promise<SepAnchorView> {
      return locked(async () => {
        const row = owned(subject, id);
        if (row.quote) {
          if (
            row.quote.id !== quoteId ||
            row.bank_destination !== (bankDestination ?? null)
          )
            throw new ApiError(
              409,
              "accepted_terms_conflict",
              "This transaction already has different accepted terms."
            );
          await advance(row);
          return view(row);
        }
        if (
          row.direction === "withdrawal"
            ? !bankDestination ||
              !/^demo:[A-Za-z0-9_-]{1,64}$/.test(bankDestination)
            : bankDestination !== undefined
        )
          throw new ApiError(
            400,
            "invalid_bank_destination",
            "Withdrawals require a synthetic demo:<reference>; deposits must not provide a bank destination."
          );
        const current = await configuration(row);
        const quote = readSepQuote(deps, row.customer_id, quoteId);
        if (
          quote.sell_asset !==
            (row.direction === "deposit" ? TRY_ASSET : asset) ||
          quote.buy_asset !== (row.direction === "deposit" ? asset : TRY_ASSET)
        )
          throw new ApiError(
            400,
            "quote_asset_mismatch",
            "The quote does not match the exact transaction direction and token issuer."
          );
        if (Date.parse(quote.expires_at) <= Date.now())
          throw new ApiError(
            409,
            "quote_expired",
            "Obtain a fresh firm quote before acceptance."
          );
        if (row.requested_amount !== null) {
          const expected = quote.sell_amount;
          const parser = row.direction === "deposit" ? parseTry : parseUsdc;
          if (parser(row.requested_amount) !== parser(expected))
            throw new ApiError(
              409,
              "quote_amount_mismatch",
              "The firm quote does not match the requested amount."
            );
        }
        const amount = parseUsdc(
          row.direction === "deposit" ? quote.buy_amount : quote.sell_amount
        );
        const minor = parseTry(
          row.direction === "deposit" ? quote.sell_amount : quote.buy_amount
        );
        if (
          amount <= 0n ||
          amount > BigInt(current.max_amount) ||
          minor <= 0n ||
          minor > BigInt(current.max_try_minor)
        )
          throw new ApiError(
            400,
            "quote_limits",
            "The quote exceeds the native demo limits."
          );
        const deadline = Math.min(
          current.ledger_time + current.max_order_lifetime,
          current.policy_valid_until
        );
        if (deadline <= Math.floor(Date.now() / 1000))
          throw new ApiError(
            409,
            "policy_expired",
            "The native policy must be renewed."
          );
        row.quote = quote;
        row.bank_destination = bankDestination ?? null;
        row.terms = {
          subject: subjectHash(subject),
          recipient: subject,
          refund_to: subject,
          direction: row.direction,
          quote_hash: hash([
            "sep-anchor-quote-v1",
            row.id,
            quote,
            current.contract,
            current.policy_hash,
          ]),
          bank_destination_hash: bankDestination
            ? hash(["sep-anchor-bank-destination-v1", subject, bankDestination])
            : "0".repeat(64),
          amount: String(amount),
          try_minor: String(minor),
          deadline,
          nonce: randomBytes(32).toString("hex"),
        };
        tx(deps.db, () => {
          const consumed = deps.db
            .prepare(
              "UPDATE quotes SET consumed_by=? WHERE id=? AND customer_id=? AND consumed_by IS NULL"
            )
            .run(row.id, quoteId, row.customer_id);
          if (consumed.changes !== 1)
            throw new ApiError(
              409,
              "quote_consumed",
              "This quote is already reserved by another transaction."
            );
          save(row);
        });
        await advance(row);
        return view(row);
      });
    },
    async customer(subject: string): Promise<{
      status: "ACCEPTED" | "NEEDS_INFO";
      eligibility: SepEligibility | null;
    }> {
      const grant = await eligibility(subject);
      return { status: grant ? "ACCEPTED" : "NEEDS_INFO", eligibility: grant };
    },
    async proofRequest(
      subject: string,
      id: string
    ): Promise<SepAnchorProofRequest> {
      return locked(async () => {
        const row = owned(subject, id);
        const current = await configuration(row);
        if (terminal(row))
          throw new ApiError(
            409,
            "terminal_transaction",
            "This transaction is already closed."
          );
        return {
          domain: current.domain,
          scope: current.scope,
          custom_data: await gateway.challenge(subjectHash(subject)),
          policy: current.policy,
          expires_at: Math.min(
            current.policy_valid_until,
            Math.floor(Date.now() / 1000) + 600
          ),
          proof_bytes: current.proof_bytes,
          external_inputs: current.external_inputs,
          dev_mode: true,
          proof_type: "compressed-evm",
          nullifier_type: 2,
        };
      });
    },
    async submitProof(
      subject: string,
      id: string,
      proof: Buffer,
      inputs: Buffer
    ): Promise<SepAnchorView> {
      return locked(async () => {
        const row = owned(subject, id);
        await configuration(row);
        if (terminal(row))
          throw new ApiError(
            409,
            "terminal_transaction",
            "This transaction is already closed."
          );
        if (
          proof.length !== row.config.proof_bytes ||
          inputs.length !== row.config.external_inputs * 32
        )
          throw new ApiError(
            400,
            "invalid_proof_length",
            "The proof does not match the pinned native verifier profile."
          );
        const key = createHash("sha256")
          .update(proof)
          .update(inputs)
          .digest("hex");
        await perform(row, `eligibility:${key}`, {
          kind: "eligibility",
          subject: subjectHash(subject),
          proof,
          public_inputs: inputs,
        });
        await advance(row);
        return view(row);
      });
    },
    async simulateBank(subject: string, id: string): Promise<SepAnchorView> {
      return locked(async () => {
        const row = owned(subject, id);
        await advance(row);
        if (store.bankEvent(id)) return view(row);
        if (
          terminal(row) ||
          row.recovery_reason ||
          !row.chain ||
          !row.quote ||
          !row.chain.escrowed
        )
          throw new ApiError(
            409,
            "payment_not_ready",
            "The exact native order and escrow must be confirmed before a simulated bank transfer."
          );
        if (
          row.direction === "deposit" &&
          (!(await eligibility(subject)) ||
            row.chain.deadline <= Math.floor(Date.now() / 1000))
        )
          throw new ApiError(
            409,
            "eligibility_required",
            "A current native grant is required before the simulated deposit."
          );
        if (!(await recipientReady(row)))
          throw new ApiError(
            409,
            "trustline_required",
            "Set up the exact authorized Testnet token trustline with enough receiving capacity before the simulated bank deposit."
          );
        if (
          row.direction === "withdrawal" &&
          row.chain.payout_authorized_at === null &&
          (!(await eligibility(subject)) ||
            row.chain.deadline <= Math.floor(Date.now() / 1000))
        )
          throw new ApiError(
            409,
            "eligibility_required",
            "A current native grant is required before simulated payout authorization."
          );
        row.bank_requested = true;
        save(row);
        await advance(row);
        return view(row);
      });
    },
    async refund(subject: string, id: string): Promise<SepAnchorView> {
      return locked(async () => {
        const row = owned(subject, id);
        for (const action of store.actions(id))
          await reconcileAction(action, false);
        await sync(row);
        if (row.chain?.refunded_at || row.chain?.cancelled_at) return view(row);
        if (
          row.recovery_reason ||
          store.bankEvent(id) ||
          !row.chain?.escrowed ||
          terminal(row) ||
          row.chain.payout_authorized_at !== null ||
          row.chain.receipt ||
          store
            .actions(id)
            .some(
              (action) =>
                action.status === "pending" || action.status === "prepared"
            )
        )
          throw new ApiError(
            409,
            "refund_not_available",
            "Automatic refund is available only for exact escrow before simulated payout authorization. Anomalous payments require operator recovery."
          );
        row.bank_requested = false;
        save(row);
        const kind = row.direction === "withdrawal" ? "refund" : "cancel";
        await perform(row, kind, { kind, id });
        await sync(row);
        return view(row);
      });
    },
    async tick(): Promise<void> {
      return locked(async () => {
        try {
          await ingest();
        } catch {
          deps.log.warn(
            "SEP payment ingestion deferred; confirmed native obligations will still reconcile."
          );
        }
        for (const row of store.all()) {
          try {
            await advance(row);
          } catch (error) {
            deps.log.warn("SEP transaction reconciliation deferred", {
              id: row.id,
              error:
                error instanceof ApiError ? error.code : "native_unavailable",
            });
          }
        }
      });
    },
  };
}

export type SepAnchor = ReturnType<typeof createSepAnchor>;
