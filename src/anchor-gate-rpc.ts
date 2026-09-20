import { createHash } from "node:crypto";
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.js";
import type {
  GateConfiguration,
  GateGateway,
  GateOrder,
  GateReceipt,
  GateTerms,
  GateTransaction,
  PreparedGateAction,
} from "./anchor-gate-types.js";
import { ApiError } from "./errors.js";

export interface AnchorGateRpc {
  getNetwork(): Promise<{ passphrase: string }>;
  getLatestLedger(): Promise<{ sequence: number; closeTime: string }>;
  getAccount(address: string): Promise<Account>;
  simulateTransaction(
    transaction: Transaction
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(
    transaction: Transaction
  ): Promise<{ status: rpc.Api.SendTransactionStatus }>;
  getTransaction(hash: string): Promise<{
    status: "SUCCESS" | "FAILED" | "NOT_FOUND";
    ledger?: number;
    latestLedgerCloseTime: number;
    oldestLedgerCloseTime: number;
  }>;
}

const placeholder = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const bytes = (hex: string) => {
  if (!/^[0-9a-f]{64}$/.test(hex))
    throw new Error("Expected a 32-byte identifier");
  return xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
};
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
  );
const unsigned = (value: string | number) =>
  nativeToScVal(BigInt(value), { type: "u64" });
const record = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  )
    throw new Error("Unexpected contract record");
  return value as Record<string, unknown>;
};
const integer = (value: unknown): number => {
  if (
    (typeof value !== "number" && typeof value !== "bigint") ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new Error("Unexpected contract integer");
  return Number(value);
};
const decimal = (value: unknown): string => {
  if (typeof value !== "bigint" || value <= 0n)
    throw new Error("Unexpected contract amount");
  return value.toString();
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value)
    throw new Error("Unexpected contract string");
  return value;
};
const hex = (value: unknown, length = 32): string => {
  if (!(value instanceof Uint8Array) || value.length !== length)
    throw new Error("Unexpected contract bytes");
  return Buffer.from(value).toString("hex");
};
const countries = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error("Unexpected country policy");
  return value.map((item: unknown) => {
    const code = Buffer.from(hex(item, 3), "hex").toString("ascii");
    if (!/^[A-Z]{3}$/.test(code)) throw new Error("Unexpected country code");
    return code;
  });
};
const optional = (value: unknown): Record<string, unknown> | null => {
  if (!Array.isArray(value)) throw new Error("Unexpected contract union");
  if (value.length === 1 && value[0] === "None") return null;
  if (value.length === 2 && value[0] === "Some") return record(value[1]);
  throw new Error("Unexpected contract union");
};

export function createAnchorGateGateway(
  cfg: Config,
  dependency?: AnchorGateRpc
): GateGateway | undefined {
  if (!cfg.anchorGateContract) return undefined;
  const hostname = new URL(cfg.publicUrl).hostname;
  if (
    cfg.anchorGateAllowedWallets.some(
      (wallet) => !StrKey.isValidEd25519PublicKey(wallet)
    ) ||
    (!["localhost", "127.0.0.1", "[::1]"].includes(hostname) &&
      cfg.anchorGateAllowedWallets.length === 0)
  )
    throw new Error(
      "A hosted gate requires an explicit nonempty list of valid admitted G wallets"
    );
  if (
    cfg.anchorMode !== "zkpassport" ||
    cfg.networkPassphrase !== Networks.TESTNET ||
    !StrKey.isValidContract(cfg.anchorGateContract)
  )
    throw new Error(
      "Anchor gate requires a valid Testnet contract in zkpassport mode"
    );
  if (!cfg.anchorGateProviderSecret || !cfg.anchorGateBankNotarySecret)
    throw new Error(
      "Anchor gate requires separate provider and mock-bank notary credentials"
    );
  if (
    !/^[1-9][0-9]*$/.test(cfg.anchorGateMaxFeeStroops) ||
    BigInt(cfg.anchorGateMaxFeeStroops) > 4294967295n
  )
    throw new Error(
      "Anchor gate fee cap must be a positive uint32 stroop amount"
    );
  const server: AnchorGateRpc =
    dependency ??
    new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15_000,
    });
  const contract = new Contract(cfg.anchorGateContract);
  const now = () => Math.floor(Date.now() / 1000);
  async function network() {
    if ((await server.getNetwork()).passphrase !== Networks.TESTNET)
      throw new Error("RPC network is not Testnet");
  }
  function raw(
    source: Account,
    method: string,
    args: xdr.ScVal[],
    deadline = now() + 120
  ) {
    return new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(contract.call(method, ...args))
      .setTimebounds(Math.max(0, now() - 5), deadline)
      .build();
  }
  async function readContract(method: string, args: xdr.ScVal[] = []) {
    const result = await server.simulateTransaction(
      raw(new Account(placeholder, "0"), method, args)
    );
    if (
      rpc.Api.isSimulationRestore(result) ||
      !rpc.Api.isSimulationSuccess(result) ||
      !result.result
    )
      throw new Error(
        "Contract read could not be confirmed without restoration"
      );
    return {
      value: scValToNative(result.result.retval) as unknown,
      ledger: result.latestLedger,
    };
  }
  async function configuration(): Promise<GateConfiguration> {
    await network();
    const [configRead, latestLedger] = await Promise.all([
      readContract("get_config"),
      server.getLatestLedger(),
    ]);
    const response = record(configRead.value);
    const provider = Keypair.fromSecret(
      cfg.anchorGateProviderSecret
    ).publicKey();
    const notary = Keypair.fromSecret(
      cfg.anchorGateBankNotarySecret
    ).publicKey();
    const token = new Asset(cfg.usdcCode, cfg.usdcIssuer).contractId(
      Networks.TESTNET
    );
    const networkId = createHash("sha256")
      .update(Networks.TESTNET)
      .digest("hex");
    if (
      response.provider !== provider ||
      response.bank_notary !== notary ||
      provider === notary ||
      response.token !== token ||
      hex(response.network_id) !== networkId ||
      response.domain !== new URL(cfg.publicUrl).hostname
    )
      throw new Error(
        "Immutable gate configuration does not match this server"
      );
    const ledger =
      latestLedger.sequence >= configRead.ledger
        ? latestLedger
        : await server.getLatestLedger();
    const ledgerTime = Number(ledger.closeTime);
    if (
      !Number.isSafeInteger(ledger.sequence) ||
      ledger.sequence < configRead.ledger ||
      !Number.isSafeInteger(ledgerTime) ||
      ledgerTime > now() + 30 ||
      ledgerTime < now() - 120
    )
      throw new Error("RPC ledger clock is stale or invalid");
    return {
      contract: cfg.anchorGateContract,
      token,
      provider,
      bank_notary: notary,
      domain: text(response.domain),
      scope: text(response.scope),
      policy: {
        min_age: integer(response.min_age),
        allowed_nationalities: countries(response.allowed_nationalities),
        allowed_issuers: countries(response.allowed_issuers),
        mock_only: true,
        max_proof_age: integer(response.max_proof_age),
        verifier: text(response.verifier),
        verifier_wasm_hash: hex(response.verifier_wasm_hash),
        verifier_vk_hash: hex(response.verifier_vk_hash),
        certificate_root: hex(response.certificate_root),
        circuit_root: hex(response.circuit_root),
      },
      proof_bytes: integer(response.proof_bytes),
      external_inputs: integer(response.external_inputs),
      max_order_lifetime: integer(response.max_order_lifetime),
      policy_valid_until: integer(response.policy_valid_until),
      max_amount: decimal(response.max_amount),
      max_try_minor: decimal(response.max_try_minor),
      ledger_time: ledgerTime,
    };
  }
  async function order(id: string): Promise<GateOrder | null> {
    const args = [bytes(id)];
    await network();
    const [orderRead, challengeRead] = await Promise.allSettled([
      readContract("get_order", args),
      readContract("get_challenge", args),
    ]);
    if (orderRead.status === "rejected") throw orderRead.reason;
    const result = orderRead.value;
    if (result.value === null || result.value === undefined) return null;
    if (challengeRead.status === "rejected") throw challengeRead.reason;
    const value = record(result.value);
    const terms = record(value.terms);
    const eligibility = optional(value.eligibility);
    const receipt = optional(value.receipt);
    if (
      !Array.isArray(terms.direction) ||
      terms.direction.length !== 1 ||
      !["Deposit", "Withdrawal"].includes(String(terms.direction[0]))
    )
      throw new Error("Unexpected order direction");
    const direction =
      terms.direction[0] === "Deposit" ? "deposit" : "withdrawal";
    const bankDestinationHash = hex(terms.bank_destination_hash);
    if (
      !Array.isArray(value.payout) ||
      !(
        (value.payout.length === 1 && value.payout[0] === "None") ||
        (value.payout.length === 2 && value.payout[0] === "Authorized")
      ) ||
      typeof value.escrowed !== "boolean"
    )
      throw new Error("Unexpected payout state");
    const payoutTime =
      value.payout[0] === "Authorized" ? integer(value.payout[1]) : null;
    if (typeof value.settled !== "boolean")
      throw new Error("Unexpected settlement state");
    const quoteHash = hex(terms.quote_hash);
    const tryMinor = decimal(terms.try_minor);
    if (
      receipt &&
      (hex(receipt.quote_hash) !== quoteHash ||
        decimal(receipt.try_minor) !== tryMinor ||
        hex(receipt.bank_destination_hash) !== bankDestinationHash)
    )
      throw new Error("Receipt terms differ from order");
    return {
      id,
      direction,
      bank_destination_hash: bankDestinationHash,
      escrowed: value.escrowed,
      payout_authorized_at: payoutTime,
      recipient: text(terms.recipient),
      quote_hash: quoteHash,
      try_minor: tryMinor,
      amount: decimal(terms.amount),
      deadline: integer(terms.deadline),
      nonce: hex(terms.nonce),
      created_at: integer(value.created_at),
      confirmed_ledger: result.ledger,
      stage: value.settled
        ? "settled"
        : receipt
          ? direction === "withdrawal"
            ? "paid"
            : "funded"
          : payoutTime !== null
            ? "payout_authorized"
            : eligibility
              ? "eligible"
              : "created",
      challenge: hex(challengeRead.value.value),
      eligibility_expires_at: eligibility
        ? integer(eligibility.valid_until)
        : null,
      receipt_id: receipt ? hex(receipt.event_id) : null,
    };
  }
  async function prepare(
    method: string,
    args: xdr.ScVal[],
    source: string,
    signer?: Keypair,
    deadline = now() + 120
  ): Promise<PreparedGateAction> {
    await network();
    const transaction = raw(
      await server.getAccount(source),
      method,
      args,
      deadline
    );
    const simulation = await server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationRestore(simulation))
      throw new ApiError(
        409,
        "gate_restore_required",
        "Restore archived contract state before retrying; no transaction was submitted."
      );
    if (!rpc.Api.isSimulationSuccess(simulation))
      throw new ApiError(
        422,
        "gate_simulation_rejected",
        "The onchain gate rejected this transaction during simulation; no transaction was submitted."
      );
    const assembled = rpc.assembleTransaction(transaction, simulation).build();
    if (BigInt(assembled.fee) > BigInt(cfg.anchorGateMaxFeeStroops))
      throw new ApiError(
        422,
        "gate_fee_limit",
        "The simulated transaction exceeds the configured Testnet fee cap."
      );
    const operation = assembled.operations[0];
    if (
      operation?.type !== "invokeHostFunction" ||
      operation.auth?.some(
        (entry) => entry.credentials.type !== "sorobanCredentialsSourceAccount"
      )
    )
      throw new Error("Unexpected additional Soroban authorization");
    if (signer) assembled.sign(signer);
    return {
      transaction: assembled.toXdr(),
      hash: Buffer.from(assembled.hash()).toString("hex"),
      expires_at: Number(assembled.timeBounds!.maxTime),
      min_time: Number(assembled.timeBounds!.minTime),
    };
  }
  async function transaction(
    hash: string,
    bounds?: { min_time: number; expires_at: number }
  ): Promise<GateTransaction> {
    await network();
    const result = await server.getTransaction(hash);
    if (result.status === "SUCCESS" || result.status === "FAILED")
      return {
        status: result.status === "SUCCESS" ? "success" : "failed",
        ledger: result.ledger ?? null,
      };
    const expiredWithinHistory =
      bounds &&
      result.latestLedgerCloseTime > bounds.expires_at &&
      result.oldestLedgerCloseTime <= bounds.min_time;
    return {
      status: expiredWithinHistory ? "failed" : "pending",
      ledger: null,
    };
  }
  return {
    configuration,
    order,
    transaction,
    async prepareCreate(id: string, terms: GateTerms) {
      const config = await configuration();
      const signer = Keypair.fromSecret(cfg.anchorGateProviderSecret);
      return prepare(
        "create_order",
        [
          bytes(id),
          struct({
            direction: nativeToScVal([
              xdr.ScVal.scvSymbol(
                terms.direction === "deposit" ? "Deposit" : "Withdrawal"
              ),
            ]),
            bank_destination_hash: bytes(terms.bank_destination_hash),
            recipient: Address.fromString(terms.recipient).toScVal(),
            quote_hash: bytes(terms.quote_hash),
            try_minor: unsigned(terms.try_minor),
            amount: nativeToScVal(BigInt(terms.amount), { type: "i128" }),
            deadline: unsigned(terms.deadline),
            nonce: bytes(terms.nonce),
          }),
        ],
        config.provider,
        signer,
        Math.min(now() + 120, terms.deadline)
      );
    },
    async prepareProof(id, recipient, proof, publicInputs) {
      const config = await configuration();
      const state = await order(id);
      if (
        !state ||
        state.recipient !== recipient ||
        proof.length !== config.proof_bytes ||
        publicInputs.length !== config.external_inputs * 32
      )
        throw new Error("Proof request does not match immutable order");
      return prepare(
        "prove_order",
        [
          bytes(id),
          xdr.ScVal.scvBytes(proof),
          xdr.ScVal.scvBytes(publicInputs),
        ],
        recipient,
        undefined,
        Math.min(now() + 120, state.deadline)
      );
    },
    async prepareReceipt(id, receipt: GateReceipt) {
      const config = await configuration();
      for (
        let attempt = 0;
        Number((await server.getLatestLedger()).closeTime) <
        receipt.received_at;
        attempt++
      ) {
        if (attempt >= 10)
          throw new ApiError(
            409,
            "receipt_clock_pending",
            "The mock receipt is recorded locally; retry after the ledger clock catches up."
          );
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
      return prepare(
        "record_receipt",
        [
          bytes(id),
          struct({
            bank_destination_hash: bytes(receipt.bank_destination_hash),
            event_id: bytes(receipt.event_id),
            quote_hash: bytes(receipt.quote_hash),
            try_minor: unsigned(receipt.try_minor),
            received_at: unsigned(receipt.received_at),
          }),
        ],
        config.bank_notary,
        Keypair.fromSecret(cfg.anchorGateBankNotarySecret)
      );
    },
    async prepareSettlement(id) {
      const config = await configuration();
      return prepare(
        "settle",
        [bytes(id)],
        config.provider,
        Keypair.fromSecret(cfg.anchorGateProviderSecret)
      );
    },
    async prepareAuthorization(id) {
      const config = await configuration();
      return prepare(
        "authorize_payout",
        [bytes(id)],
        config.bank_notary,
        Keypair.fromSecret(cfg.anchorGateBankNotarySecret)
      );
    },
    async submit(envelope) {
      await network();
      const prepared = TransactionBuilder.fromXdr(envelope, Networks.TESTNET);
      if (
        !(prepared instanceof Transaction) ||
        BigInt(prepared.fee) > BigInt(cfg.anchorGateMaxFeeStroops)
      )
        throw new Error("Unsupported transaction envelope");
      await server.sendTransaction(prepared);
      const result = await transaction(
        Buffer.from(prepared.hash()).toString("hex")
      );
      return result;
    },
  };
}
