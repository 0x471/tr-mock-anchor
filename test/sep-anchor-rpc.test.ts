import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  buildAuthorizationEntryPreimage,
  hash,
  inspectAuthEntry,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { config } from "../src/config.js";
import type { AnchorGateRpc } from "../src/anchor-gate-rpc.js";
import { createSepAnchorGateway } from "../src/sep-anchor-rpc.js";

const id = "a".repeat(64);
const operation = "b".repeat(64);
const u64 = (value: number) => nativeToScVal(BigInt(value), { type: "u64" });
const bytes = (value: number) => xdr.ScVal.scvBytes(Buffer.alloc(32, value));
const map = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.entries(fields)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(
        ([key, val]) =>
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val })
      )
  );

function fixture(legacy = false) {
  const provider = Keypair.random();
  const notary = Keypair.random();
  const recipient = Keypair.random();
  const cfg = {
    ...config,
    anchorMode: "zkpassport" as const,
    publicUrl: "http://localhost:8787",
    networkPassphrase: Networks.TESTNET,
    sepAnchorContract: StrKey.encodeContract(Buffer.alloc(32, 7)),
    sepAnchorProviderSecret: provider.secret(),
    sepAnchorBankNotarySecret: notary.secret(),
    anchorGateMaxFeeStroops: "1000000",
    anchorGateAllowedWallets: [],
  };
  const token = new Asset(cfg.usdcCode, cfg.usdcIssuer).contractId(
    Networks.TESTNET
  );
  const time = Math.floor(Date.now() / 1000);
  const state = { mutation: "", sends: 0 };
  const configValue = map({
    provider: new Address(provider.publicKey()).toScVal(),
    bank_notary: new Address(notary.publicKey()).toScVal(),
    token: new Address(token).toScVal(),
    verifier: new Address(StrKey.encodeContract(Buffer.alloc(32, 8))).toScVal(),
    verifier_wasm_hash: bytes(1),
    verifier_vk_hash: bytes(2),
    certificate_root: bytes(3),
    circuit_root: bytes(4),
    network_id: xdr.ScVal.scvBytes(
      createHash("sha256").update(Networks.TESTNET).digest()
    ),
    domain: xdr.ScVal.scvString("localhost"),
    scope: xdr.ScVal.scvString("test-policy"),
    min_age: xdr.ScVal.scvU32(18),
    allowed_nationalities: nativeToScVal([Buffer.from("ZKR")]),
    allowed_issuers: nativeToScVal([Buffer.from("ZKR")]),
    sanctions_root: bytes(5),
    sanctions_strict: nativeToScVal(true),
    proof_bytes: xdr.ScVal.scvU32(10240),
    external_inputs: xdr.ScVal.scvU32(13),
    max_proof_age: u64(300),
    policy_valid_until: u64(time + 3600),
    max_order_lifetime: u64(1800),
    max_amount: nativeToScVal(1_000_000n, { type: "i128" }),
    max_try_minor: u64(1_000_000),
  });
  const orderValue = map({
    terms: map({
      subject: bytes(9),
      recipient: new Address(recipient.publicKey()).toScVal(),
      refund_to: new Address(recipient.publicKey()).toScVal(),
      direction: nativeToScVal([xdr.ScVal.scvSymbol("Withdrawal")]),
      quote_hash: bytes(10),
      bank_destination_hash: bytes(11),
      try_minor: u64(1000),
      amount: nativeToScVal(500n, { type: "i128" }),
      deadline: u64(time + 600),
      nonce: bytes(12),
    }),
    created_at: u64(time - 30),
    escrowed: nativeToScVal(false),
    funding: nativeToScVal([xdr.ScVal.scvSymbol("None")]),
    receipt: nativeToScVal([xdr.ScVal.scvSymbol("None")]),
    payout: nativeToScVal([xdr.ScVal.scvSymbol("None")]),
    settled_at: xdr.ScVal.scvVoid(),
    refunded_at: xdr.ScVal.scvVoid(),
    cancelled_at: xdr.ScVal.scvVoid(),
  });
  const invocation = (
    contract: string,
    name: string,
    args: xdr.ScVal[],
    children: xdr.SorobanAuthorizedInvocation[] = []
  ) =>
    new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(contract).toScAddress(),
            functionName: name,
            args,
          })
        ),
      subInvocations: children,
    });
  const external: AnchorGateRpc = {
    getNetwork: async () => ({ passphrase: Networks.TESTNET }),
    getLatestLedger: async () => ({ sequence: 123, closeTime: String(time) }),
    getAccount: async (account) => new Account(account, "4"),
    simulateTransaction: async (transaction) => {
      const op = transaction.operations[0];
      if (
        op?.type !== "invokeHostFunction" ||
        op.func.type !== "hostFunctionTypeInvokeContract"
      )
        throw new Error("Unexpected test call");
      const fn = op.func.value;
      const method = fn.functionName.toString();
      const auth: xdr.SorobanAuthorizationEntry[] = [];
      if (method === "fund_withdrawal") {
        const debit = invocation(token, "transfer", [
          new Address(provider.publicKey()).toScVal(),
          new Address(cfg.sepAnchorContract).toScVal(),
          nativeToScVal(state.mutation === "amount" ? 501n : 500n, {
            type: "i128",
          }),
        ]);
        auth.push(
          new xdr.SorobanAuthorizationEntry({
            credentials:
              xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
            rootInvocation: invocation(cfg.sepAnchorContract, method, fn.args, [
              debit,
            ]),
          })
        );
        const credentials = new xdr.SorobanAddressCredentials({
          address: new Address(
            state.mutation === "signer"
              ? recipient.publicKey()
              : notary.publicKey()
          ).toScAddress(),
          nonce: xdr.Int64.fromString("1234"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        });
        auth.push(
          new xdr.SorobanAuthorizationEntry({
            credentials:
              state.mutation === "delegates"
                ? xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
                    new xdr.SorobanAddressCredentialsWithDelegates({
                      addressCredentials: credentials,
                      delegates: [],
                    })
                  )
                : legacy
                  ? xdr.SorobanCredentials.sorobanCredentialsAddress(
                      credentials
                    )
                  : xdr.SorobanCredentials.sorobanCredentialsAddressV2(
                      credentials
                    ),
            rootInvocation: invocation(
              state.mutation === "contract" ? token : cfg.sepAnchorContract,
              state.mutation === "method" ? "refund" : method,
              state.mutation === "order" ? [bytes(1), fn.args[1]!] : fn.args,
              state.mutation === "notary_debit" ? [debit] : []
            ),
          })
        );
      }
      return {
        _parsed: true,
        id: "test",
        latestLedger: 123,
        events: [],
        transactionData: new SorobanDataBuilder().setResourceFee("1000"),
        minResourceFee: "1000",
        result: {
          auth,
          retval:
            method === "get_config"
              ? configValue
              : method === "get_policy_hash"
                ? bytes(6)
                : orderValue,
        },
      };
    },
    sendTransaction: async () => {
      state.sends++;
      return { status: "PENDING" };
    },
    getTransaction: async () => ({
      status: "NOT_FOUND",
      latestLedgerCloseTime: time,
      oldestLedgerCloseTime: time - 10000,
    }),
  };
  return {
    gateway: createSepAnchorGateway(cfg, external)!,
    provider,
    notary,
    state,
    cfg,
    token,
  };
}

it("prepares the live Testnet V2 notary authorization without changing the exact custody debit", async () => {
  const f = fixture();
  const prepared = await f.gateway.prepare({
    kind: "fund",
    id,
    operation_id: operation,
  });
  const transaction = TransactionBuilder.fromXdr(
    prepared.transaction,
    Networks.TESTNET
  );
  if (!(transaction instanceof Transaction))
    throw new Error("Expected ordinary transaction");
  const op = transaction.operations[0];
  if (op?.type !== "invokeHostFunction")
    throw new Error("Expected contract invocation");
  expect(op.auth).toHaveLength(2);
  const entry = op.auth![1]!;
  const info = inspectAuthEntry(entry);
  expect(info).toMatchObject({
    credentialType: "addressV2",
    address: f.notary.publicKey(),
    signatureExpirationLedger: 153,
    signed: true,
  });
  const signature = info.signers[0]!.signatures![0]!.signature;
  expect(
    f.notary.verify(
      hash(
        buildAuthorizationEntryPreimage(entry, 153, Networks.TESTNET).toXdr()
      ),
      signature
    )
  ).toBe(true);
  expect(
    f.notary.verify(
      hash(
        buildAuthorizationEntryPreimage(entry, 153, Networks.PUBLIC).toXdr()
      ),
      signature
    )
  ).toBe(false);
  const child = op.auth![0]!.rootInvocation.subInvocations[0]!.function;
  if (child.type !== "sorobanAuthorizedFunctionTypeContractFn")
    throw new Error("Expected exact SAC debit");
  expect(child.value.args.map(scValToNative)).toEqual([
    f.provider.publicKey(),
    f.cfg.sepAnchorContract,
    500n,
  ]);
  expect(
    transaction.signatures.some((s) =>
      f.provider.verify(transaction.hash(), s.signature)
    )
  ).toBe(true);
  expect(f.state.sends).toBe(0);
});

it("retains legacy notary authorization compatibility", async () => {
  const f = fixture(true);
  const prepared = await f.gateway.prepare({
    kind: "fund",
    id,
    operation_id: operation,
  });
  const transaction = TransactionBuilder.fromXdr(
    prepared.transaction,
    Networks.TESTNET
  );
  if (!(transaction instanceof Transaction))
    throw new Error("Expected ordinary transaction");
  const op = transaction.operations[0];
  if (op?.type !== "invokeHostFunction")
    throw new Error("Expected contract invocation");
  expect(inspectAuthEntry(op.auth![1]!)).toMatchObject({
    credentialType: "address",
    address: f.notary.publicKey(),
    signed: true,
  });
});

it.each([
  ["signer", "Unexpected authorization signer"],
  ["contract", "Unexpected authorization invocation"],
  ["method", "Unexpected authorization invocation"],
  ["order", "Unexpected authorization invocation"],
  ["amount", "Unexpected token debit authorization"],
  ["notary_debit", "Unexpected nested authorization"],
  ["delegates", "Unsupported authorization credentials"],
])(
  "rejects malicious %s authorization before submission",
  async (mutation, message) => {
    const f = fixture();
    f.state.mutation = mutation;
    await expect(
      f.gateway.prepare({ kind: "fund", id, operation_id: operation })
    ).rejects.toThrow(message);
    expect(f.state.sends).toBe(0);
  }
);
