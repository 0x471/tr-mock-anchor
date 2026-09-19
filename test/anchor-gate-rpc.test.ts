import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  createAnchorGateGateway,
  type AnchorGateRpc,
} from "../src/anchor-gate-rpc.js";
import { config } from "../src/config.js";
import type { GateTerms } from "../src/anchor-gate-types.js";

function map(value: Record<string, xdr.ScVal>) {
  return xdr.ScVal.scvMap(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
  );
}
const u64 = (value: number) => nativeToScVal(BigInt(value), { type: "u64" });
const id = "a".repeat(64);
function fixture() {
  const provider = Keypair.random();
  const notary = Keypair.random();
  const recipient = Keypair.random();
  const cfg = {
    ...config,
    anchorMode: "zkpassport" as const,
    publicUrl: "http://localhost:8787",
    networkPassphrase: Networks.TESTNET,
    anchorGateContract: StrKey.encodeContract(Buffer.alloc(32, 7)),
    anchorGateProviderSecret: provider.secret(),
    anchorGateBankNotarySecret: notary.secret(),
    anchorGateMaxFeeStroops: "1000000",
  };
  const time = Math.floor(Date.now() / 1000);
  const terms: GateTerms = {
    recipient: recipient.publicKey(),
    quote_hash: "b".repeat(64),
    try_minor: "10000",
    amount: "25000000",
    deadline: time + 600,
    nonce: "c".repeat(64),
  };
  const termsValue = map({
    recipient: new Address(terms.recipient).toScVal(),
    quote_hash: xdr.ScVal.scvBytes(Buffer.from(terms.quote_hash, "hex")),
    try_minor: u64(10000),
    amount: nativeToScVal(25000000n, { type: "i128" }),
    deadline: u64(terms.deadline),
    nonce: xdr.ScVal.scvBytes(Buffer.from(terms.nonce, "hex")),
  });
  const configValue = map({
    provider: new Address(provider.publicKey()).toScVal(),
    bank_notary: new Address(notary.publicKey()).toScVal(),
    token: new Address(
      new Asset(cfg.usdcCode, cfg.usdcIssuer).contractId(Networks.TESTNET)
    ).toScVal(),
    verifier: new Address(StrKey.encodeContract(Buffer.alloc(32, 8))).toScVal(),
    verifier_wasm_hash: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)),
    verifier_vk_hash: xdr.ScVal.scvBytes(Buffer.alloc(32, 2)),
    certificate_root: xdr.ScVal.scvBytes(Buffer.alloc(32, 3)),
    circuit_root: xdr.ScVal.scvBytes(Buffer.alloc(32, 4)),
    network_id: xdr.ScVal.scvBytes(
      createHash("sha256").update(Networks.TESTNET).digest()
    ),
    domain: xdr.ScVal.scvString("localhost"),
    scope: xdr.ScVal.scvString("test-policy"),
    min_age: xdr.ScVal.scvU32(18),
    allowed_nationalities: nativeToScVal([Buffer.from("GBR")]),
    allowed_issuers: nativeToScVal([]),
    proof_bytes: xdr.ScVal.scvU32(10240),
    external_inputs: xdr.ScVal.scvU32(11),
    max_proof_age: u64(300),
    policy_valid_until: u64(time + 3600),
    max_order_lifetime: u64(1800),
    max_amount: nativeToScVal(1000000000n, { type: "i128" }),
    max_try_minor: u64(1000000),
  });
  const orderValue = map({
    terms: termsValue,
    created_at: u64(time - 30),
    eligibility: nativeToScVal([
      xdr.ScVal.scvSymbol("Some"),
      map({ proof_time: u64(time - 10), valid_until: u64(time + 290) }),
    ]),
    receipt: nativeToScVal([xdr.ScVal.scvSymbol("None")]),
    settled: xdr.ScVal.scvBool(false),
  });
  const state = {
    network: Networks.TESTNET,
    resourceFee: "1000",
    lookups: 0,
    sendStatus: "PENDING" as rpc.Api.SendTransactionStatus,
    status: "NOT_FOUND" as "NOT_FOUND" | "SUCCESS" | "FAILED",
    latest: time,
    oldest: time - 10000,
    calls: [] as Transaction[],
  };
  const external: AnchorGateRpc = {
    getNetwork: async () => ({ passphrase: state.network }),
    getLatestLedger: async () => ({
      sequence: 123,
      closeTime: String(state.latest),
    }),
    getAccount: async (address) => {
      state.lookups++;
      return new Account(address, "4");
    },
    simulateTransaction: async (transaction) => {
      state.calls.push(transaction);
      const op = transaction.operations[0];
      if (
        op?.type !== "invokeHostFunction" ||
        op.func.type !== "hostFunctionTypeInvokeContract"
      )
        throw new Error("Unexpected operation");
      const method = op.func.value.functionName.toString();
      const retval =
        method === "get_config"
          ? configValue
          : method === "get_challenge"
            ? xdr.ScVal.scvBytes(Buffer.alloc(32, 5))
            : orderValue;
      return {
        _parsed: true,
        id: "test",
        latestLedger: 123,
        events: [],
        transactionData: new SorobanDataBuilder().setResourceFee(
          state.resourceFee
        ),
        minResourceFee: state.resourceFee,
        result: { auth: [], retval },
      };
    },
    sendTransaction: async () => ({ status: state.sendStatus }),
    getTransaction: async () => ({
      status: state.status,
      ...(state.status === "NOT_FOUND" ? {} : { ledger: 124 }),
      latestLedgerCloseTime: state.latest,
      oldestLedgerCloseTime: state.oldest,
    }),
  };
  const gate = createAnchorGateGateway(cfg, external)!;
  return { cfg, gate, state, terms, provider, notary, recipient, time };
}

describe("gate contract RPC boundary", () => {
  it("maps immutable config and explicit Soroban state unions without disclosing credential secrets", async () => {
    const { gate, cfg, time } = fixture();
    const policy = await gate.configuration();
    expect(policy).toMatchObject({
      ledger_time: time,
      proof_bytes: 10240,
      external_inputs: 11,
      policy: {
        min_age: 18,
        allowed_nationalities: ["GBR"],
        allowed_issuers: [],
        mock_only: true,
      },
    });
    expect(JSON.stringify(policy)).not.toContain(cfg.anchorGateProviderSecret);
    expect(await gate.order(id)).toMatchObject({
      id,
      stage: "eligible",
      receipt_id: null,
      confirmed_ledger: 123,
      created_at: time - 30,
      challenge: "05".repeat(32),
    });
  });
  it("prepares an unsigned recipient proof call and signed exact provider/notary calls", async () => {
    const { gate, terms, provider, notary, recipient, time } = fixture();
    const create = new Transaction(
      (await gate.prepareCreate(id, terms)).transaction,
      Networks.TESTNET
    );
    expect(create.source).toBe(provider.publicKey());
    expect(
      provider.verify(create.hash(), create.signatures[0]!.signature)
    ).toBe(true);
    const op = create.operations[0]!;
    if (
      op.type !== "invokeHostFunction" ||
      op.func.type !== "hostFunctionTypeInvokeContract"
    )
      throw new Error("Wrong call");
    expect(op.func.value.functionName.toString()).toBe("create_order");
    expect(scValToNative(op.func.value.args[1]!)).toMatchObject({
      recipient: recipient.publicKey(),
      try_minor: 10000n,
      amount: 25000000n,
    });
    const proof = new Transaction(
      (
        await gate.prepareProof(
          id,
          recipient.publicKey(),
          Buffer.alloc(10240),
          Buffer.alloc(352)
        )
      ).transaction,
      Networks.TESTNET
    );
    expect(proof.source).toBe(recipient.publicKey());
    expect(proof.signatures).toHaveLength(0);
    const receipt = new Transaction(
      (
        await gate.prepareReceipt(id, {
          event_id: "d".repeat(64),
          quote_hash: terms.quote_hash,
          try_minor: terms.try_minor,
          received_at: time,
        })
      ).transaction,
      Networks.TESTNET
    );
    expect(receipt.source).toBe(notary.publicKey());
    expect(
      notary.verify(receipt.hash(), receipt.signatures[0]!.signature)
    ).toBe(true);
  });
  it("does not prepare or sign when the RPC endpoint reports another network", async () => {
    const { gate, state, terms } = fixture();
    state.network = Networks.PUBLIC;
    await expect(gate.prepareCreate(id, terms)).rejects.toThrow("not Testnet");
    expect(state.lookups).toBe(0);
    expect(state.calls).toHaveLength(0);
  });
  it("enforces the total prepared fee cap", async () => {
    const { gate, state, terms } = fixture();
    state.resourceFee = "1000001";
    await expect(gate.prepareCreate(id, terms)).rejects.toMatchObject({
      code: "gate_fee_limit",
    });
  });
  it("does not mistake a retry admission error for proof of historical non-inclusion", async () => {
    const { gate, state, terms, time } = fixture();
    const prepared = await gate.prepareCreate(id, terms);
    state.sendStatus = "ERROR";
    expect(await gate.submit(prepared.transaction)).toEqual({
      status: "pending",
      ledger: null,
    });
    state.latest = time + 500;
    expect(
      await gate.transaction(prepared.hash, {
        created_at: time,
        expires_at: time + 120,
      })
    ).toEqual({ status: "failed", ledger: null });
    state.oldest = time + 1;
    expect(
      await gate.transaction(prepared.hash, {
        created_at: time,
        expires_at: time + 120,
      })
    ).toEqual({ status: "pending", ledger: null });
    state.status = "SUCCESS";
    expect(await gate.transaction(prepared.hash)).toEqual({
      status: "success",
      ledger: 124,
    });
  });
});
