import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb, type DB } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createFakeGateway } from "../src/stellar.js";
import {
  Asset,
  Account,
  Contract,
  Keypair,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  GateGateway,
  GateOrder,
  GateReceipt,
  GateTerms,
  PreparedGateAction,
} from "../src/anchor-gate-types.js";

const databases: DB[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
});

function fixture(anchorGate?: GateGateway) {
  const cfg = {
    ...config,
    anchorMode: "zkpassport" as const,
    publicUrl: "http://localhost:8787",
    stellarMode: "fake" as const,
    rateSource: "static" as const,
    staticUsdTry: "40.00",
    spreadBps: 50,
  };
  const db = openDb(":memory:");
  databases.push(db);
  const deps: Deps = {
    cfg,
    db,
    stellar: createFakeGateway(cfg),
    rates: createRateService(cfg),
    log: createLogger(true),
    anchorGate,
  };
  const app = createApp(deps);
  const authenticate = async (wallet = Keypair.random()) => {
    const ch = await app.request(`/auth?account=${wallet.publicKey()}`);
    const challenge = (await ch.json()) as { transaction: string };
    const signed = TransactionBuilder.fromXdr(
      challenge.transaction,
      Networks.TESTNET
    );
    signed.sign(wallet);
    const response = await app.request("/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: signed.toXdr() }),
    });
    const { token } = (await response.json()) as { token: string };
    return {
      wallet,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };
  };
  return { deps, app, authenticate };
}

class FakeGate implements GateGateway {
  policyExpiry = Math.floor(Date.now() / 1000) + 3600;
  payouts = 0;
  orders = new Map<string, GateOrder>();
  prepared = new Map<string, () => void>();
  confirmed = new Set<string>();
  configuration = async () => ({
    contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
    token: new Asset(config.usdcCode, config.usdcIssuer).contractId(
      Networks.TESTNET
    ),
    provider: "test-provider",
    bank_notary: "test-notary",
    domain: "localhost",
    scope: "test-policy",
    policy: {},
    proof_bytes: 10240,
    external_inputs: 11,
    max_order_lifetime: 1800,
    policy_valid_until: this.policyExpiry,
    max_amount: "1000000000",
    max_try_minor: "1000000",
    ledger_time: Math.floor(Date.now() / 1000),
  });
  order = async (id: string) => this.orders.get(id) ?? null;
  async prepareCreate(
    id: string,
    terms: GateTerms
  ): Promise<PreparedGateAction> {
    const state: GateOrder = {
      ...terms,
      id,
      created_at: Math.floor(Date.now() / 1000),
      confirmed_ledger: 123,
      stage: "created",
      escrowed: terms.direction === "deposit",
      payout_authorized_at: null,
      challenge: "a".repeat(64),
      eligibility_expires_at: null,
      receipt_id: null,
    };
    const hash = id;
    this.prepared.set(hash, () => this.orders.set(id, state));
    return {
      transaction: hash,
      hash,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
  }
  async prepareProof(
    id: string,
    recipient: string,
    proof: Buffer,
    publicInputs: Buffer
  ): Promise<PreparedGateAction> {
    const transaction = new TransactionBuilder(new Account(recipient, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        new Contract((await this.configuration()).contract).call(
          "prove_order",
          xdr.ScVal.scvBytes(Buffer.from(id, "hex")),
          xdr.ScVal.scvBytes(proof),
          xdr.ScVal.scvBytes(publicInputs)
        )
      )
      .setTimeout(120)
      .build();
    const hash = Buffer.from(transaction.hash()).toString("hex");
    this.prepared.set(hash, () => {
      const state = this.orders.get(id)!;
      this.orders.set(id, {
        ...state,
        stage: "eligible",
        escrowed: true,
        eligibility_expires_at: Math.floor(Date.now() / 1000) + 300,
      });
    });
    return {
      transaction: transaction.toXdr(),
      hash,
      expires_at: Number(transaction.timeBounds!.maxTime),
    };
  }
  async prepareReceipt(
    id: string,
    receipt: GateReceipt
  ): Promise<PreparedGateAction> {
    const hash = createHash("sha256").update(`receipt:${id}`).digest("hex");
    this.prepared.set(hash, () =>
      this.orders.set(id, {
        ...this.orders.get(id)!,
        stage:
          this.orders.get(id)!.direction === "withdrawal" ? "paid" : "funded",
        receipt_id: receipt.event_id,
      })
    );
    return {
      transaction: hash,
      hash,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
  }
  async prepareSettlement(id: string): Promise<PreparedGateAction> {
    const hash = createHash("sha256").update(`settle:${id}`).digest("hex");
    this.prepared.set(hash, () => {
      if (this.orders.get(id)!.stage !== "settled") this.payouts++;
      this.orders.set(id, {
        ...this.orders.get(id)!,
        stage: "settled",
        escrowed: false,
      });
    });
    return {
      transaction: hash,
      hash,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
  }
  async prepareAuthorization(id: string): Promise<PreparedGateAction> {
    const hash = createHash("sha256").update(`authorize:${id}`).digest("hex");
    this.prepared.set(hash, () =>
      this.orders.set(id, {
        ...this.orders.get(id)!,
        stage: "payout_authorized",
        payout_authorized_at: Math.floor(Date.now() / 1000),
      })
    );
    return {
      transaction: hash,
      hash,
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
  }
  submit = async (envelope: string) => {
    const hash = this.prepared.has(envelope)
      ? envelope
      : Buffer.from(
          TransactionBuilder.fromXdr(envelope, Networks.TESTNET).hash()
        ).toString("hex");
    this.prepared.get(hash)?.();
    this.confirmed.add(hash);
    return { status: "success" as const, ledger: 123 };
  };
  transaction = async (hash: string) => ({
    status: this.confirmed.has(hash)
      ? ("success" as const)
      : ("pending" as const),
    ledger: this.confirmed.has(hash) ? 123 : null,
  });
}

async function checkout(
  gate = new FakeGate(),
  direction: "deposit" | "withdrawal" = "deposit"
) {
  const fixtureValue = fixture(gate);
  const { app, authenticate, deps } = fixtureValue;
  const user = await authenticate();
  const quote = (await (
    await app.request("/sep38/quote", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        sell_asset:
          direction === "deposit"
            ? "iso4217:TRY"
            : `stellar:USDC:${deps.cfg.usdcIssuer}`,
        buy_asset:
          direction === "deposit"
            ? `stellar:USDC:${deps.cfg.usdcIssuer}`
            : "iso4217:TRY",
        sell_amount: direction === "deposit" ? "200.00" : "5.0000000",
      }),
    })
  ).json()) as { id: string };
  const order = (await (
    await app.request("/anchor-gate/orders", {
      method: "POST",
      headers: { ...user.headers, "Idempotency-Key": "checkout" },
      body: JSON.stringify({
        quote_id: quote.id,
        direction,
        ...(direction === "withdrawal"
          ? { bank_destination: "demo:my-account" }
          : {}),
      }),
    })
  ).json()) as { id: string };
  return { ...fixtureValue, user, order, gate };
}

async function eligibleCheckout(
  direction: "deposit" | "withdrawal" = "deposit"
) {
  const current = await checkout(new FakeGate(), direction);
  const { app, user, order } = current;
  const path = `/anchor-gate/orders/${order.id}`;
  const prepared = (await (
    await app.request(`${path}/prepare-proof`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        proof: "00".repeat(10240),
        public_inputs: "00".repeat(352),
      }),
    })
  ).json()) as { action_id: string; transaction: string };
  const signed = TransactionBuilder.fromXdr(
    prepared.transaction,
    Networks.TESTNET
  );
  signed.sign(user.wallet);
  expect(
    (
      await app.request(`${path}/submit`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          action_id: prepared.action_id,
          signed_transaction: signed.toXdr(),
        }),
      })
    ).status
  ).toBe(200);
  return current;
}

describe("gated anchor HTTP interface", () => {
  it("waits for the local bank clock before freezing a future-ledger payout receipt", async () => {
    const { app, user, order, gate } = await eligibleCheckout("withdrawal");
    const path = `/anchor-gate/orders/${order.id}`;
    const post = (action: string) =>
      app.request(`${path}/${action}`, {
        method: "POST",
        headers: user.headers,
        body: "{}",
      });
    expect((await post("authorize-payout")).status).toBe(200);
    gate.orders.get(order.id)!.payout_authorized_at =
      Math.floor(Date.now() / 1000) + 10;
    const early = await post("simulate-bank");
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({
      error: { code: "bank_clock_pending" },
    });
    expect(
      await (await app.request(path, { headers: user.headers })).json()
    ).toMatchObject({ mock_bank_credit: null, stage: "payout_authorized" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11000);
    expect(await (await post("simulate-bank")).json()).toMatchObject({
      stage: "paid",
      mock_bank_credit: { amount_try: "199.00" },
    });
  });
  it("completes an authorized withdrawal after proof, policy and order expiry without crediting twice", async () => {
    const { app, user, order, gate } = await eligibleCheckout("withdrawal");
    const path = `/anchor-gate/orders/${order.id}`;
    const post = (action: string) =>
      app.request(`${path}/${action}`, {
        method: "POST",
        headers: user.headers,
        body: "{}",
      });
    expect((await post("authorize-payout")).status).toBe(200);
    expect(
      (await app.request(`${path}/proof-request`, { headers: user.headers }))
        .status
    ).toBe(409);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4000000);
    const submit = gate.submit;
    gate.submit = async () => {
      throw new Error("receipt response lost");
    };
    const delayed = await post("simulate-bank");
    expect(delayed.status).toBe(200);
    const pending = (await delayed.json()) as { mock_bank_credit: unknown };
    expect(pending).toMatchObject({
      stage: "payout_authorized",
      completed: false,
      mock_bank_credit: {
        destination: "demo:my-account",
        amount_try: "199.00",
      },
    });
    gate.submit = submit;
    const paid = (await (await post("simulate-bank")).json()) as {
      mock_bank_credit: unknown;
    };
    expect(paid.mock_bank_credit).toEqual(pending.mock_bank_credit);
    expect(paid).toMatchObject({ stage: "paid", expired: true });
    expect(await (await post("settle")).json()).toMatchObject({
      completed: true,
      expired: true,
    });
    expect(gate.payouts).toBe(1);
  });
  it("rejects real-bank destination text and locks the synthetic beneficiary under the creation key", async () => {
    const { app, user, order } = await checkout(new FakeGate(), "withdrawal");
    const existing = (await (
      await app.request(`/anchor-gate/orders/${order.id}`, {
        headers: user.headers,
      })
    ).json()) as { quote_id: string };
    const request = (bank_destination: string) =>
      app.request("/anchor-gate/orders", {
        method: "POST",
        headers: { ...user.headers, "Idempotency-Key": "checkout" },
        body: JSON.stringify({
          quote_id: existing.quote_id,
          direction: "withdrawal",
          bank_destination,
        }),
      });
    expect((await request("TR120006200001234567890123")).status).toBe(400);
    expect((await request("demo:other-account")).status).toBe(409);
    expect(await (await request("demo:my-account")).json()).toMatchObject({
      id: order.id,
      bank_destination: "demo:my-account",
    });
  });
  it("escrows a withdrawal before authorizing and recording exactly one simulated bank credit", async () => {
    const { app, user, order, gate } = await eligibleCheckout("withdrawal");
    const path = `/anchor-gate/orders/${order.id}`;
    const post = (action: string) =>
      app.request(`${path}/${action}`, {
        method: "POST",
        headers: user.headers,
        body: "{}",
      });
    expect(
      await (await app.request(path, { headers: user.headers })).json()
    ).toMatchObject({
      direction: "withdrawal",
      stage: "eligible",
      escrowed: true,
      bank_destination: "demo:my-account",
      amount_token: "5.0000000",
      amount_try: "199.00",
    });
    expect((await post("simulate-bank")).status).toBe(409);
    const authorized = await post("authorize-payout");
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      stage: "payout_authorized",
    });
    expect(await (await post("simulate-bank")).json()).toMatchObject({
      stage: "paid",
      mock_bank_credit: {
        amount_try: "199.00",
        destination: "demo:my-account",
      },
      completed: false,
    });
    expect(await (await post("simulate-bank")).json()).toMatchObject({
      stage: "paid",
    });
    expect(await (await post("settle")).json()).toMatchObject({
      completed: true,
      stage: "settled",
    });
    expect(gate.payouts).toBe(1);
  });
  it("does not route an existing order into a replacement vault", async () => {
    const { app, user, order, gate } = await checkout();
    const original = await gate.configuration();
    gate.configuration = async () => ({
      ...original,
      contract: StrKey.encodeContract(Buffer.alloc(32, 9)),
    });
    const response = await app.request(`/anchor-gate/orders/${order.id}`, {
      headers: user.headers,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "gate_deployment_changed" },
    });
  });
  it("recognizes a proof confirmed after a lost response even when its envelope is now expired", async () => {
    const { app, user, order, gate } = await checkout();
    const path = `/anchor-gate/orders/${order.id}`;
    const prepared = (await (
      await app.request(`${path}/prepare-proof`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          proof: "00".repeat(10240),
          public_inputs: "00".repeat(352),
        }),
      })
    ).json()) as { action_id: string; transaction: string };
    const signed = TransactionBuilder.fromXdr(
      prepared.transaction,
      Networks.TESTNET
    );
    signed.sign(user.wallet);
    await gate.submit(signed.toXdr());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 180000);
    const response = await app.request(`${path}/submit`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        action_id: prepared.action_id,
        signed_transaction: signed.toXdr(),
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ stage: "eligible" });
  });
  it("rejects concurrent duplicate proof preparation without losing the first action", async () => {
    const { app, user, order } = await checkout();
    const request = () =>
      app.request(`/anchor-gate/orders/${order.id}/prepare-proof`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          proof: "00".repeat(10240),
          public_inputs: "00".repeat(352),
        }),
      });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
  });
  it("keeps early or expired bank actions and settlement blocked", async () => {
    const initial = await checkout();
    const path = `/anchor-gate/orders/${initial.order.id}`;
    const post = (action: string) =>
      initial.app.request(`${path}/${action}`, {
        method: "POST",
        headers: initial.user.headers,
        body: "{}",
      });
    expect((await post("simulate-bank")).status).toBe(409);
    expect((await post("settle")).status).toBe(409);
    const other = await initial.authenticate();
    expect(
      (
        await initial.app.request(`${path}/simulate-bank`, {
          method: "POST",
          headers: other.headers,
          body: "{}",
        })
      ).status
    ).toBe(404);
    const current = await eligibleCheckout();
    const fundedPath = `/anchor-gate/orders/${current.order.id}`;
    expect(
      (
        await current.app.request(`${fundedPath}/simulate-bank`, {
          method: "POST",
          headers: current.user.headers,
          body: "{}",
        })
      ).status
    ).toBe(200);
    current.gate.orders.get(current.order.id)!.eligibility_expires_at =
      Math.floor(Date.now() / 1000) - 1;
    const expired = await current.app.request(`${fundedPath}/settle`, {
      method: "POST",
      headers: current.user.headers,
      body: "{}",
    });
    expect(expired.status).toBe(409);
    expect(current.gate.payouts).toBe(0);
  });
  it("recognizes externally settled immutable contract state without local settlement receipts", async () => {
    const { app, user, order, gate } = await eligibleCheckout();
    const state = gate.orders.get(order.id)!;
    gate.orders.set(order.id, {
      ...state,
      stage: "settled",
      receipt_id: "c".repeat(64),
      confirmed_ledger: 124,
    });
    expect(
      await (
        await app.request(`/anchor-gate/orders/${order.id}`, {
          headers: user.headers,
        })
      ).json()
    ).toMatchObject({
      completed: true,
      stage: "settled",
      confirmed_ledger: 124,
    });
  });
  it("records one owner-authorized mock receipt and completes only from settled contract state", async () => {
    const { app, user, order, gate } = await eligibleCheckout();
    const path = `/anchor-gate/orders/${order.id}`;
    const send = (action: string) =>
      app.request(`${path}/${action}`, {
        method: "POST",
        headers: user.headers,
        body: "{}",
      });
    const receipt = await send("simulate-bank");
    expect(receipt.status).toBe(200);
    const funded = await receipt.json();
    expect(funded).toMatchObject({ stage: "funded", completed: false });
    expect(await (await send("simulate-bank")).json()).toEqual(funded);
    expect(await (await send("settle")).json()).toMatchObject({
      stage: "settled",
      completed: true,
    });
    expect(await (await send("settle")).json()).toMatchObject({
      stage: "settled",
      completed: true,
    });
    expect(gate.payouts).toBe(1);
  });
  for (const alteration of ["fee", "method", "signer", "network"] as const) {
    it(`rejects proof transaction ${alteration} substitution`, async () => {
      const { app, user, order } = await checkout();
      const path = `/anchor-gate/orders/${order.id}`;
      const response = await app.request(`${path}/prepare-proof`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          proof: "00".repeat(10240),
          public_inputs: "00".repeat(352),
        }),
      });
      const prepared = (await response.json()) as {
        action_id: string;
        transaction: string;
      };
      let transaction = new Transaction(
        prepared.transaction,
        alteration === "network" ? Networks.PUBLIC : Networks.TESTNET
      );
      if (alteration === "fee")
        transaction = TransactionBuilder.cloneFrom(transaction, {
          fee: "200",
        }).build();
      if (alteration === "method")
        transaction = TransactionBuilder.cloneFrom(transaction)
          .clearOperations()
          .addOperation(
            new Contract(StrKey.encodeContract(Buffer.alloc(32, 7))).call(
              "settle",
              xdr.ScVal.scvBytes(Buffer.from(order.id, "hex"))
            )
          )
          .build();
      transaction.sign(
        alteration === "signer" ? Keypair.random() : user.wallet
      );
      const result = await app.request(`${path}/submit`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          action_id: prepared.action_id,
          signed_transaction: transaction.toXdr(),
        }),
      });
      expect(result.status).toBe(422);
      expect(await result.json()).toMatchObject({
        error: { code: "invalid_signed_transaction" },
      });
      expect(
        await (await app.request(path, { headers: user.headers })).json()
      ).toMatchObject({ stage: "created", bank_instructions: null });
    });
  }
  it("keeps a submitted proof pending until its contract state is confirmed", async () => {
    const { app, user, order, gate } = await checkout();
    const path = `/anchor-gate/orders/${order.id}`;
    const response = await app.request(`${path}/prepare-proof`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        proof: "00".repeat(10240),
        public_inputs: "00".repeat(352),
      }),
    });
    const prepared = (await response.json()) as {
      action_id: string;
      transaction: string;
    };
    const transaction = TransactionBuilder.fromXdr(
      prepared.transaction,
      Networks.TESTNET
    );
    transaction.sign(user.wallet);
    const submit = gate.submit;
    gate.submit = async () => {
      throw new Error("RPC timeout");
    };
    const pending = await app.request(`${path}/submit`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        action_id: prepared.action_id,
        signed_transaction: transaction.toXdr(),
      }),
    });
    expect(await pending.json()).toMatchObject({
      stage: "created",
      bank_instructions: null,
    });
    gate.submit = submit;
    const retry = await app.request(`${path}/submit`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        action_id: prepared.action_id,
        signed_transaction: transaction.toXdr(),
      }),
    });
    expect(await retry.json()).toMatchObject({ stage: "eligible" });
  });
  it("rejects a proof with the wrong profile before preparing a transaction", async () => {
    const { app, user, order } = await checkout();
    const response = await app.request(
      `/anchor-gate/orders/${order.id}/prepare-proof`,
      {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          proof: "00".repeat(10240),
          public_inputs: "00".repeat(320),
        }),
      }
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "proof_length" },
    });
  });
  it("requires the wallet to sign the exact prepared proof transaction before releasing bank instructions", async () => {
    const { app, user, order } = await checkout();
    const path = `/anchor-gate/orders/${order.id}`;
    const intent = await app.request(`${path}/proof-request`, {
      headers: user.headers,
    });
    expect(intent.status).toBe(200);
    expect(await intent.json()).toMatchObject({
      custom_data: "a".repeat(64),
      nullifier_type: 2,
      dev_mode: true,
      proof_type: "compressed-evm",
    });
    const response = await app.request(`${path}/prepare-proof`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        proof: "00".repeat(10240),
        public_inputs: "00".repeat(352),
      }),
    });
    expect(response.status).toBe(200);
    const prepared = (await response.json()) as {
      action_id: string;
      transaction: string;
      hash: string;
    };
    expect(
      await (await app.request(path, { headers: user.headers })).json()
    ).toMatchObject({ stage: "created", bank_instructions: null });
    const unsigned = await app.request(`${path}/submit`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        action_id: prepared.action_id,
        signed_transaction: prepared.transaction,
      }),
    });
    expect(unsigned.status).toBe(422);
    const transaction = TransactionBuilder.fromXdr(
      prepared.transaction,
      Networks.TESTNET
    );
    transaction.sign(user.wallet);
    const submitted = await app.request(`${path}/submit`, {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        action_id: prepared.action_id,
        signed_transaction: transaction.toXdr(),
      }),
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      stage: "eligible",
      bank_instructions: { simulated: true, reference: order.id },
    });
  });
  it("does not reinterpret an existing quote when the configured issuer changes", async () => {
    const gate = new FakeGate();
    const { app, authenticate, deps } = fixture(gate);
    const user = await authenticate();
    const quote = (await (
      await app.request("/sep38/quote", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({
          sell_asset: "iso4217:TRY",
          buy_asset: `stellar:USDC:${deps.cfg.usdcIssuer}`,
          sell_amount: "200.00",
        }),
      })
    ).json()) as { id: string };
    deps.cfg.usdcIssuer = Keypair.random().publicKey();
    const previous = await gate.configuration();
    gate.configuration = async () => ({
      ...previous,
      token: new Asset("USDC", deps.cfg.usdcIssuer).contractId(
        Networks.TESTNET
      ),
    });
    const response = await app.request("/anchor-gate/orders", {
      method: "POST",
      headers: { ...user.headers, "Idempotency-Key": "issuer-change" },
      body: JSON.stringify({ quote_id: quote.id }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "quote_asset_mismatch" },
    });
  });
  it("keeps the gate inactive until explicitly configured", async () => {
    const { app } = fixture();
    const info = await app.request("/anchor-gate/info");
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({
      enabled: false,
      network: "testnet",
    });
    const order = await app.request("/anchor-gate/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote_id: "unknown" }),
    });
    expect(order.status).toBe(503);
    expect(await order.json()).toMatchObject({
      error: { code: "gate_unavailable" },
    });
  });
  it("creates one owned fixed-quote order after real SEP-10 challenge signing", async () => {
    const { app, authenticate, deps } = fixture(new FakeGate());
    const user = await authenticate();
    const quoteResponse = await app.request("/sep38/quote", {
      method: "POST",
      headers: user.headers,
      body: JSON.stringify({
        sell_asset: "iso4217:TRY",
        buy_asset: `stellar:USDC:${deps.cfg.usdcIssuer}`,
        sell_amount: "200.00",
      }),
    });
    const quote = (await quoteResponse.json()) as { id: string };
    const request = () =>
      app.request("/anchor-gate/orders", {
        method: "POST",
        headers: { ...user.headers, "Idempotency-Key": "checkout-1" },
        body: JSON.stringify({ quote_id: quote.id }),
      });
    const response = await request();
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; deadline: number };
    expect(created).toMatchObject({
      recipient: user.wallet.publicKey(),
      amount_try: "200.00",
      amount_token: "4.9751243",
      stage: "created",
    });
    expect(created.deadline).toBeGreaterThan(
      Math.floor(Date.now() / 1000) + 1700
    );
    expect(await (await request()).json()).toMatchObject({ id: created.id });
    const other = await authenticate();
    expect(
      (
        await app.request(`/anchor-gate/orders/${created.id}`, {
          headers: other.headers,
        })
      ).status
    ).toBe(404);
    expect(
      (await app.request(`/anchor-gate/orders/${created.id}`)).status
    ).toBe(403);
  });
});
