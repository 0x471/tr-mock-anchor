import {
  Account,
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  inspectAuthEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.js";
import {
  createAnchorGateGateway,
  type AnchorGateRpc,
} from "./anchor-gate-rpc.js";
import type {
  SepAnchorGateway,
  SepChainAction,
  SepChainOrder,
  SepOrderTerms,
} from "./sep-anchor-types.js";
import type { GateReceipt } from "./anchor-gate-types.js";
import { ApiError } from "./errors.js";

const placeholder = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const bytes = (value: string) => {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new Error("Expected a 32-byte identifier");
  return xdr.ScVal.scvBytes(Buffer.from(value, "hex"));
};
const u64 = (value: number | string) =>
  nativeToScVal(BigInt(value), { type: "u64" });
const struct = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
  );
function record(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof Uint8Array
  )
    throw new Error("Unexpected contract record");
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (
    (typeof value !== "bigint" && typeof value !== "number") ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < 0
  )
    throw new Error("Unexpected contract timestamp");
  return Number(value);
}
function positive(value: unknown): string {
  if (typeof value !== "bigint" || value <= 0n)
    throw new Error("Unexpected contract amount");
  return value.toString();
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("Unexpected contract address");
  return value;
}
function hex(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.length !== 32)
    throw new Error("Unexpected contract digest");
  return Buffer.from(value).toString("hex");
}
function union(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value) && value.length === 1 && value[0] === "None")
    return null;
  if (Array.isArray(value) && value.length === 2 && value[0] === "Some")
    return record(value[1]);
  throw new Error("Unexpected contract state");
}
const optionalTime = (value: unknown) =>
  value === null || value === undefined ? null : integer(value);
function encodeTerms(t: SepOrderTerms) {
  return struct({
    subject: bytes(t.subject),
    refund_to: new Address(t.refund_to).toScVal(),
    direction: nativeToScVal([
      xdr.ScVal.scvSymbol(t.direction === "deposit" ? "Deposit" : "Withdrawal"),
    ]),
    recipient: new Address(t.recipient).toScVal(),
    quote_hash: bytes(t.quote_hash),
    bank_destination_hash: bytes(t.bank_destination_hash),
    try_minor: u64(t.try_minor),
    amount: nativeToScVal(BigInt(t.amount), { type: "i128" }),
    deadline: u64(t.deadline),
    nonce: bytes(t.nonce),
  });
}
function encodeReceipt(r: GateReceipt) {
  return struct({
    event_id: bytes(r.event_id),
    quote_hash: bytes(r.quote_hash),
    bank_destination_hash: bytes(r.bank_destination_hash),
    try_minor: u64(r.try_minor),
    received_at: u64(r.received_at),
  });
}

export function createSepAnchorGateway(
  cfg: Config,
  dependency?: AnchorGateRpc
): SepAnchorGateway | undefined {
  if (!cfg.sepAnchorContract) return undefined;
  const mapped: Config = {
    ...cfg,
    anchorGateContract: cfg.sepAnchorContract,
    anchorGateProviderSecret: cfg.sepAnchorProviderSecret,
    anchorGateBankNotarySecret: cfg.sepAnchorBankNotarySecret,
  };
  const server: AnchorGateRpc =
    dependency ??
    new rpc.Server(cfg.rpcUrl, {
      allowHttp: cfg.rpcUrl.startsWith("http://"),
      timeout: 15_000,
    });
  const base = createAnchorGateGateway(mapped, server)!;
  const contract = new Contract(cfg.sepAnchorContract);
  const provider = Keypair.fromSecret(cfg.sepAnchorProviderSecret);
  const notary = Keypair.fromSecret(cfg.sepAnchorBankNotarySecret);
  const now = () => Math.floor(Date.now() / 1000);
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
  async function read(method: string, args: xdr.ScVal[] = []) {
    if ((await server.getNetwork()).passphrase !== Networks.TESTNET)
      throw new Error("RPC network is not Testnet");
    const response = await server.simulateTransaction(
      raw(new Account(placeholder, "0"), method, args)
    );
    if (
      rpc.Api.isSimulationRestore(response) ||
      !rpc.Api.isSimulationSuccess(response) ||
      !response.result
    )
      throw new Error("SEP contract state could not be confirmed");
    return {
      value: scValToNative(response.result.retval) as unknown,
      ledger: response.latestLedger,
    };
  }
  async function configuration() {
    const [value, policy] = await Promise.all([
      base.configuration(),
      read("get_policy_hash"),
    ]);
    return { ...value, policy_hash: hex(policy.value) };
  }
  async function order(id: string): Promise<SepChainOrder | null> {
    const [result, config] = await Promise.all([
      read("get_order", [bytes(id)]),
      configuration(),
    ]);
    if (result.value === null || result.value === undefined) return null;
    const value = record(result.value);
    const t = record(value.terms);
    const funding = union(value.funding);
    const r = union(value.receipt);
    if (
      !Array.isArray(t.direction) ||
      t.direction.length !== 1 ||
      !["Deposit", "Withdrawal"].includes(String(t.direction[0])) ||
      typeof value.escrowed !== "boolean"
    )
      throw new Error("Unexpected SEP order state");
    if (
      !Array.isArray(value.payout) ||
      !(
        (value.payout.length === 1 && value.payout[0] === "None") ||
        (value.payout.length === 2 && value.payout[0] === "Authorized")
      )
    )
      throw new Error("Unexpected SEP payout state");
    const receipt: GateReceipt | null = r
      ? {
          event_id: hex(r.event_id),
          quote_hash: hex(r.quote_hash),
          bank_destination_hash: hex(r.bank_destination_hash),
          try_minor: positive(r.try_minor),
          received_at: integer(r.received_at),
        }
      : null;
    const resultOrder: SepChainOrder = {
      id,
      subject: hex(t.subject),
      refund_to: text(t.refund_to),
      recipient: text(t.recipient),
      direction: t.direction[0] === "Deposit" ? "deposit" : "withdrawal",
      quote_hash: hex(t.quote_hash),
      bank_destination_hash: hex(t.bank_destination_hash),
      try_minor: positive(t.try_minor),
      amount: positive(t.amount),
      deadline: integer(t.deadline),
      nonce: hex(t.nonce),
      policy_hash: config.policy_hash,
      created_at: integer(value.created_at),
      confirmed_ledger: result.ledger,
      escrowed: value.escrowed,
      funding_id: funding ? hex(funding.operation_id) : null,
      receipt,
      payout_authorized_at:
        value.payout[0] === "Authorized" ? integer(value.payout[1]) : null,
      settled_at: optionalTime(value.settled_at),
      refunded_at: optionalTime(value.refunded_at),
      cancelled_at: optionalTime(value.cancelled_at),
    };
    if (
      receipt &&
      (receipt.quote_hash !== resultOrder.quote_hash ||
        receipt.try_minor !== resultOrder.try_minor ||
        receipt.bank_destination_hash !== resultOrder.bank_destination_hash)
    )
      throw new Error("Receipt does not match the immutable order");
    return resultOrder;
  }
  async function prepare(action: SepChainAction) {
    const config = await configuration();
    let method: string;
    let args: xdr.ScVal[];
    let depositAmount: string | null = null;
    let deadline = now() + 120;
    switch (action.kind) {
      case "eligibility":
        if (
          action.proof.length !== config.proof_bytes ||
          action.public_inputs.length !== config.external_inputs * 32
        )
          throw new ApiError(
            400,
            "invalid_proof_length",
            "Proof does not match the pinned verification profile."
          );
        method = "submit_eligibility";
        args = [
          bytes(action.subject),
          xdr.ScVal.scvBytes(action.proof),
          xdr.ScVal.scvBytes(action.public_inputs),
        ];
        break;
      case "create":
        method = "create_order";
        args = [bytes(action.id), encodeTerms(action.terms)];
        deadline = Math.min(deadline, action.terms.deadline);
        depositAmount =
          action.terms.direction === "deposit" ? action.terms.amount : null;
        break;
      case "fund": {
        method = "fund_withdrawal";
        args = [bytes(action.id), bytes(action.operation_id)];
        const state = await order(action.id);
        if (!state || state.direction !== "withdrawal")
          throw new Error("Withdrawal order missing");
        depositAmount = state.amount;
        break;
      }
      case "receipt":
        method = "record_receipt";
        args = [bytes(action.id), encodeReceipt(action.receipt)];
        break;
      case "authorize":
        method = "authorize_payout";
        args = [bytes(action.id)];
        break;
      default:
        method = action.kind;
        args = [bytes(action.id)];
    }
    const draft = raw(
      await server.getAccount(provider.publicKey()),
      method,
      args,
      deadline
    );
    const simulation = await server.simulateTransaction(draft);
    if (rpc.Api.isSimulationRestore(simulation))
      throw new ApiError(
        409,
        "gate_restore_required",
        "Restore archived contract state before retrying."
      );
    if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result)
      throw new ApiError(
        422,
        "gate_simulation_rejected",
        "The native contract rejected this action. No transaction was submitted."
      );
    const auth = [];
    for (const entry of simulation.result.auth) {
      const info = inspectAuthEntry(entry);
      const signerAddress = info.address ?? provider.publicKey();
      if (
        info.credentialType !== "sourceAccount" &&
        info.credentialType !== "address" &&
        info.credentialType !== "addressV2"
      )
        throw new Error("Unsupported authorization credentials");
      if (
        signerAddress !== provider.publicKey() &&
        signerAddress !== notary.publicKey()
      )
        throw new Error("Unexpected authorization signer");
      const root = entry.rootInvocation;
      const fn = root.function;
      if (
        fn.type !== "sorobanAuthorizedFunctionTypeContractFn" ||
        Address.fromScAddress(fn.value.contractAddress).toString() !==
          config.contract ||
        fn.value.functionName.toString() !== method ||
        fn.value.args.length !== args.length ||
        fn.value.args.some(
          (a, i) => a.toXdr("base64") !== args[i]!.toXdr("base64")
        )
      )
        throw new Error("Unexpected authorization invocation");
      if (
        root.subInvocations.length >
        (signerAddress === provider.publicKey() && depositAmount ? 1 : 0)
      )
        throw new Error("Unexpected nested authorization");
      for (const child of root.subInvocations) {
        const transfer = child.function;
        const expected = [
          new Address(provider.publicKey()).toScVal(),
          new Address(config.contract).toScVal(),
          nativeToScVal(BigInt(depositAmount!), { type: "i128" }),
        ];
        if (
          child.subInvocations.length ||
          transfer.type !== "sorobanAuthorizedFunctionTypeContractFn" ||
          Address.fromScAddress(transfer.value.contractAddress).toString() !==
            config.token ||
          transfer.value.functionName.toString() !== "transfer" ||
          transfer.value.args.length !== 3 ||
          transfer.value.args.some(
            (a, i) => a.toXdr("base64") !== expected[i]!.toXdr("base64")
          )
        )
          throw new Error("Unexpected token debit authorization");
      }
      auth.push(
        info.address
          ? await authorizeEntry(
              entry,
              signerAddress === provider.publicKey() ? provider : notary,
              simulation.latestLedger + 30,
              Networks.TESTNET
            )
          : entry
      );
    }
    const op = draft.operations[0];
    if (op?.type !== "invokeHostFunction")
      throw new Error("Unexpected contract operation");
    const assembled = rpc
      .assembleTransaction(draft, simulation)
      .clearOperations()
      .addOperation(Operation.invokeHostFunction({ func: op.func, auth }))
      .build();
    if (BigInt(assembled.fee) > BigInt(cfg.anchorGateMaxFeeStroops))
      throw new ApiError(
        422,
        "gate_fee_limit",
        "The transaction exceeds the Testnet fee cap."
      );
    assembled.sign(provider);
    return {
      transaction: assembled.toXdr(),
      hash: Buffer.from(assembled.hash()).toString("hex"),
      min_time: Number(assembled.timeBounds!.minTime),
      expires_at: Number(assembled.timeBounds!.maxTime),
    };
  }
  return {
    configuration,
    order,
    prepare,
    async challenge(subject) {
      return hex((await read("get_challenge", [bytes(subject)])).value);
    },
    async eligibility(subject) {
      const result = await read("get_eligibility", [bytes(subject)]);
      if (result.value === null || result.value === undefined) return null;
      const value = record(result.value);
      return {
        proof_time: integer(value.proof_time),
        valid_until: integer(value.valid_until),
        confirmed_ledger: result.ledger,
      };
    },
    transaction: base.transaction,
    async submit(envelope) {
      const transaction = TransactionBuilder.fromXdr(
        envelope,
        Networks.TESTNET
      );
      if (
        !(transaction instanceof Transaction) ||
        transaction.source !== provider.publicKey() ||
        transaction.operations.length !== 1 ||
        !transaction.signatures.some((s) =>
          provider.verify(transaction.hash(), s.signature)
        )
      )
        throw new Error("Unexpected provider envelope");
      const op = transaction.operations[0];
      if (
        op?.type !== "invokeHostFunction" ||
        op.func.type !== "hostFunctionTypeInvokeContract" ||
        Address.fromScAddress(op.func.value.contractAddress).toString() !==
          cfg.sepAnchorContract
      )
        throw new Error("Unexpected settlement contract");
      return base.submit(envelope);
    },
  };
}
