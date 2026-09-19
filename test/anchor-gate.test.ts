import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb, type DB } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createFakeGateway } from "../src/stellar.js";
import {
  Asset,
  Keypair,
  Networks,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type {
  GateGateway,
  GateOrder,
  GateTerms,
  PreparedGateAction,
} from "../src/anchor-gate-types.js";

const databases: DB[] = [];
afterEach(() => {
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
  orders = new Map<string, GateOrder>();
  configuration = async () => ({
    contract: "test-vault",
    token: new Asset(config.usdcCode, config.usdcIssuer).contractId(
      Networks.TESTNET
    ),
    provider: "test-provider",
    bank_notary: "test-notary",
    domain: "localhost",
    scope: "test-policy",
    policy: {},
    proof_bytes: 9888,
    external_inputs: 11,
    max_order_lifetime: 1800,
    policy_valid_until: Math.floor(Date.now() / 1000) + 3600,
    max_amount: "1000000000",
    max_try_minor: "1000000",
  });
  order = async (id: string) => this.orders.get(id) ?? null;
  async prepareCreate(
    id: string,
    terms: GateTerms
  ): Promise<PreparedGateAction> {
    this.orders.set(id, {
      ...terms,
      id,
      stage: "created",
      challenge: "a".repeat(64),
      eligibility_expires_at: null,
      receipt_id: null,
    });
    return {
      transaction: "create",
      hash: "b".repeat(64),
      expires_at: Math.floor(Date.now() / 1000) + 60,
    };
  }
  async prepareProof(): Promise<PreparedGateAction> {
    throw new Error("not implemented");
  }
  async prepareReceipt(): Promise<PreparedGateAction> {
    throw new Error("not implemented");
  }
  async prepareSettlement(): Promise<PreparedGateAction> {
    throw new Error("not implemented");
  }
  submit = async () => ({ status: "success" as const, ledger: 123 });
  transaction = async () => ({ status: "success" as const, ledger: 123 });
}

describe("gated onramp HTTP interface", () => {
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
    const created = (await response.json()) as { id: string };
    expect(created).toMatchObject({
      recipient: user.wallet.publicKey(),
      amount_try: "200.00",
      amount_token: "4.9751243",
      stage: "created",
    });
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
