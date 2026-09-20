import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  WebAuth,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnchorGateBrowser } from "../scripts/build-anchor-gate.js";
import { anchorGateBrowserRoutes } from "../src/anchor-gate-browser.js";
import {
  createAnchorGateFlow,
  type PhoneEvents,
} from "../web/anchor-gate-flow.js";

function browserHarness(
  direction: "deposit" | "withdrawal" = "deposit",
  options: {
    clockOffset?: number;
    policyLifetime?: number;
    externalInputs?: number;
    loseFirstReservationResponse?: boolean;
    reservationRejection?: { status: 400 | 409 | 503; code: string };
  } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  let clockNow = now + (options.clockOffset ?? 0);
  const wallet = Keypair.random();
  const anchor = Keypair.random();
  const contract = StrKey.encodeContract(new Uint8Array(32).fill(7));
  const token = new Asset("USDC", anchor.publicKey()).contractId(
    Networks.TESTNET
  );
  const policy = {
    min_age: 18,
    allowed_nationalities: ["GBR", "USA"],
    allowed_issuers: new Array<string>(),
    mock_only: true,
    max_proof_age: 600,
    verifier_vk_hash:
      "25de0e8ba3d6b6346c1ef7530adfb51a653f91a330a177ce734b1ec5121074a6",
  };
  const order = {
    id: "11".repeat(32),
    quote_id: "qt_demo",
    recipient: wallet.publicKey(),
    amount_try: "100.00",
    amount_token: "2.5000000",
    source_asset:
      direction === "deposit"
        ? "iso4217:TRY"
        : `stellar:USDC:${anchor.publicKey()}`,
    direction,
    bank_destination:
      direction === "withdrawal" ? "demo:synthetic-account" : null,
    bank_destination_hash:
      direction === "withdrawal" ? "33".repeat(32) : "00".repeat(32),
    escrowed: false,
    payout_authorized_at: null,
    mock_bank_credit: null,
    token,
    contract,
    stage: "created",
    expired: false,
    created_at: now - 31,
    deadline: now + 600,
    network: "testnet",
    eligibility_expires_at: null,
    receipt_id: null,
    bank_instructions: null,
    completed: false,
    confirmed_ledger: 42,
    actions: [],
  };
  const app = new Hono();
  let events: PhoneEvents | undefined;
  let uploads = 0;
  let prepared: unknown;
  let lostReservationResponse = false;
  const reservationRequests: { key: string | null; body: unknown }[] = [];
  app.get("/.well-known/stellar.toml", (c) =>
    c.text(
      `NETWORK_PASSPHRASE="${Networks.TESTNET}"\nSIGNING_KEY="${anchor.publicKey()}"\nWEB_AUTH_ENDPOINT="http://localhost:8787/auth"`
    )
  );
  app.get("/auth", (c) =>
    c.json({
      transaction: WebAuth.buildChallengeTx(
        anchor,
        wallet.publicKey(),
        "localhost:8787",
        300,
        Networks.TESTNET,
        "localhost:8787"
      ),
      network_passphrase: Networks.TESTNET,
    })
  );
  app.post("/auth", async (c) => {
    WebAuth.verifyChallengeTxSigners(
      (await c.req.json()).transaction,
      anchor.publicKey(),
      Networks.TESTNET,
      [wallet.publicKey()],
      "localhost:8787",
      "localhost:8787"
    );
    return c.json({ token: "synthetic-http-session-token" });
  });
  app.get("/anchor-gate/info", (c) =>
    c.json({
      enabled: true,
      network: "testnet",
      network_passphrase: Networks.TESTNET,
      buy_asset: `stellar:USDC:${anchor.publicKey()}`,
      sell_asset: "iso4217:TRY",
      max_fee_stroops: "1000000",
      config: {
        contract,
        token,
        provider: anchor.publicKey(),
        bank_notary: wallet.publicKey(),
        domain: "localhost",
        scope: "test-policy",
        policy,
        proof_bytes: 10240,
        external_inputs: options.externalInputs ?? 11,
        max_order_lifetime: 600,
        policy_valid_until: now + (options.policyLifetime ?? 3600),
        max_amount: "1000000000",
        max_try_minor: "100000",
      },
    })
  );
  app.post("/sep38/quote", async (c) => {
    const request = await c.req.json();
    if (direction === "withdrawal") {
      if (
        request.sell_asset !== `stellar:USDC:${anchor.publicKey()}` ||
        request.buy_asset !== "iso4217:TRY" ||
        request.sell_amount !== "2.5"
      )
        return c.json({ error: "wrong withdrawal quote" }, 400);
      return c.json({
        id: "qt_demo",
        sell_asset: `stellar:USDC:${anchor.publicKey()}`,
        buy_asset: "iso4217:TRY",
        sell_amount: "2.5000000",
        buy_amount: "100.00",
        expires_at: new Date((now + 600) * 1000).toISOString(),
        fee: {
          total: "0.0500000",
          asset: `stellar:USDC:${anchor.publicKey()}`,
        },
      });
    }
    return c.json({
      id: "qt_demo",
      sell_asset: "iso4217:TRY",
      buy_asset: `stellar:USDC:${anchor.publicKey()}`,
      sell_amount: "100.00",
      buy_amount: "2.5000000",
      expires_at: new Date((now + 600) * 1000).toISOString(),
      fee: { total: "1.00", asset: "iso4217:TRY" },
    });
  });
  app.post("/anchor-gate/orders", async (c) => {
    if (options.reservationRejection)
      return c.json(
        { error: { code: options.reservationRejection.code } },
        options.reservationRejection.status
      );
    const request = await c.req.json();
    if (
      direction === "withdrawal" &&
      (request.direction !== "withdrawal" ||
        request.bank_destination !== "demo:synthetic-account")
    )
      return c.json({ error: "wrong withdrawal terms" }, 400);
    return c.json(order);
  });
  app.get("/anchor-gate/orders/:id", (c) => c.json(order));
  app.post("/anchor-gate/orders/:id/authorize-payout", (c) => {
    if (
      order.direction !== "withdrawal" ||
      order.stage !== "eligible" ||
      !order.escrowed
    )
      return c.json({ error: "not eligible" }, 409);
    Object.assign(order, {
      stage: "payout_authorized",
      payout_authorized_at: clockNow,
    });
    return c.json(order);
  });
  app.post("/anchor-gate/orders/:id/simulate-bank", (c) => {
    if (order.direction !== "withdrawal" || order.stage !== "payout_authorized")
      return c.json({ error: "not authorized" }, 409);
    Object.assign(order, { stage: "paid", receipt_id: "mock-receipt-1" });
    return c.json(order);
  });
  app.post("/anchor-gate/orders/:id/settle", (c) => {
    if (order.direction !== "withdrawal" || order.stage !== "paid")
      return c.json({ error: "not paid" }, 409);
    Object.assign(order, {
      stage: "settled",
      completed: true,
      escrowed: false,
    });
    return c.json(order);
  });
  app.get("/anchor-gate/orders/:id/proof-request", (c) =>
    c.json({
      domain: "localhost",
      scope: "test-policy",
      custom_data: "22".repeat(32),
      policy,
      created_at: order.created_at,
      expires_at: order.deadline,
      proof_bytes: 10240,
      external_inputs: 11,
      dev_mode: true,
      proof_type: "compressed-evm",
      nullifier_type: 2,
    })
  );
  app.post("/anchor-gate/orders/:id/prepare-proof", (c) => {
    uploads++;
    return prepared
      ? c.json(prepared as object)
      : c.json(
          {
            error:
              "No native cryptography is simulated by this browser fixture.",
          },
          503
        );
  });
  app.post("/anchor-gate/orders/:id/submit", async (c) => {
    const body = await c.req.json();
    const transaction = TransactionBuilder.fromXdr(
      body.signed_transaction,
      Networks.TESTNET
    );
    if (
      !transaction.signatures.some((signature) =>
        wallet.verify(transaction.hash(), signature.signature)
      )
    )
      return c.json({ error: "invalid wallet signature" }, 403);
    Object.assign(order, {
      stage: "eligible",
      escrowed: direction === "withdrawal",
      eligibility_expires_at: order.deadline,
    });
    return c.json(order);
  });
  const flow = createAnchorGateFlow({
    origin: "http://localhost:8787",
    fetch: async (input, init) => {
      const response = await app.request(String(input), init);
      if (
        new URL(String(input)).pathname === "/anchor-gate/orders" &&
        init?.method === "POST"
      ) {
        reservationRequests.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          body: JSON.parse(String(init.body)),
        });
        if (options.loseFirstReservationResponse && !lostReservationResponse) {
          lostReservationResponse = true;
          throw new Error(
            "Reservation response was lost after server acceptance."
          );
        }
      }
      return response;
    },
    wallet: {
      connect: async () => wallet.publicKey(),
      current: async () => ({
        address: wallet.publicKey(),
        network: Networks.TESTNET,
      }),
      sign: async (transaction) => {
        const tx = TransactionBuilder.fromXdr(transaction, Networks.TESTNET);
        tx.sign(wallet);
        return tx.toXdr();
      },
    },
    phone: {
      request: async (_config, callbacks) => {
        events = callbacks;
        return {
          url: "https://zkpassport.id/r/synthetic-fixture",
          cancel() {},
        };
      },
    },
    changed() {},
    now: () => clockNow * 1000,
  });
  return {
    flow,
    order,
    policy,
    browserFetch: async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit
    ) => app.request(String(input), init),
    events: () => events!,
    uploads: () => uploads,
    reservationRequests,
    sign(transaction: string) {
      const tx = TransactionBuilder.fromXdr(transaction, Networks.TESTNET);
      tx.sign(wallet);
      return tx.toXdr();
    },
    prepare(value: unknown) {
      prepared = value;
    },
    advance(seconds: number) {
      clockNow += seconds;
    },
    proof: {
      name: "outer_evm_count_6",
      version: "0.20.0",
      vkeyHash: policy.verifier_vk_hash,
      proof:
        "00".repeat(64) +
        now.toString(16).padStart(64, "0") +
        "00".repeat(8 * 32 + 10240),
    },
  };
}

describe("gated browser wallet authentication", () => {
  it("does not offer a signature or authenticate a wallet on Mainnet", async () => {
    const wallet = Keypair.random();
    const app = new Hono();
    let signed = false;
    const flow = createAnchorGateFlow({
      origin: "http://localhost:8787",
      fetch: async (input, init) => app.request(String(input), init),
      wallet: {
        connect: async () => wallet.publicKey(),
        current: async () => ({
          address: wallet.publicKey(),
          network: Networks.PUBLIC,
        }),
        sign: async () => {
          signed = true;
          throw new Error("Must not sign");
        },
      },
      phone: {
        request: async () => {
          throw new Error("Must not request a proof");
        },
      },
      changed: () => {},
    });
    await expect(flow.connect()).rejects.toThrow("Testnet");
    expect(signed).toBe(false);
    expect(flow.view.wallet).toBe("");
  });

  it("authenticates through a server-validated real SEP-10 wallet signature", async () => {
    const wallet = Keypair.random();
    const anchor = Keypair.random();
    const app = new Hono();
    let authenticated = false;
    app.get("/.well-known/stellar.toml", (c) =>
      c.text(
        `NETWORK_PASSPHRASE="${Networks.TESTNET}"\nSIGNING_KEY="${anchor.publicKey()}"\nWEB_AUTH_ENDPOINT="http://localhost:8787/auth"`
      )
    );
    app.get("/auth", (c) =>
      c.json({
        transaction: WebAuth.buildChallengeTx(
          anchor,
          c.req.query("account")!,
          "localhost:8787",
          300,
          Networks.TESTNET,
          "localhost:8787"
        ),
        network_passphrase: Networks.TESTNET,
      })
    );
    app.post("/auth", async (c) => {
      const { transaction } = await c.req.json();
      WebAuth.verifyChallengeTxSigners(
        transaction,
        anchor.publicKey(),
        Networks.TESTNET,
        [wallet.publicKey()],
        "localhost:8787",
        "localhost:8787"
      );
      authenticated = true;
      return c.json({ token: "synthetic-http-session-token" });
    });
    const flow = createAnchorGateFlow({
      origin: "http://localhost:8787",
      fetch: async (input, init) => app.request(String(input), init),
      wallet: {
        connect: async () => wallet.publicKey(),
        current: async () => ({
          address: wallet.publicKey(),
          network: Networks.TESTNET,
        }),
        sign: async (transaction) => {
          const { tx } = WebAuth.readChallengeTx(
            transaction,
            anchor.publicKey(),
            Networks.TESTNET,
            "localhost:8787",
            "localhost:8787"
          );
          tx.sign(wallet);
          return tx.toXdr();
        },
      },
      phone: {
        request: async () => {
          throw new Error("Must not request a proof");
        },
      },
      changed: () => {},
    });
    await flow.connect();
    expect(authenticated).toBe(true);
    expect(flow.view.wallet).toBe(wallet.publicKey());
  });
});

describe("gated browser order and phone lifecycle", () => {
  it("retains exact reservation terms and idempotency after an unknown HTTP outcome", async () => {
    const test = browserHarness("withdrawal", {
      loseFirstReservationResponse: true,
    });
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("2.5", "withdrawal");
    await expect(
      test.flow.createOrder("demo:synthetic-account")
    ).rejects.toThrow("response was lost");
    expect(test.flow.view.reservationPending).toBe(true);
    expect(test.flow.view.order).toBeNull();
    await expect(test.flow.quote("2.5", "withdrawal")).rejects.toThrow(
      "Reconcile the existing reservation"
    );
    expect(() => test.flow.selectDirection("deposit")).toThrow(
      "Reconcile the existing reservation"
    );
    expect(() => test.flow.clearQuote()).toThrow(
      "Reconcile the existing reservation"
    );
    await expect(test.flow.refresh("77".repeat(32))).rejects.toThrow(
      "Reconcile the existing reservation"
    );
    await expect(test.flow.createOrder("demo:different")).rejects.toThrow(
      "Do not change the destination"
    );
    test.advance(601);
    await test.flow.createOrder("demo:synthetic-account");
    expect(test.reservationRequests).toHaveLength(2);
    expect(test.reservationRequests[0]?.key).toBeTruthy();
    expect(test.reservationRequests[1]).toEqual(test.reservationRequests[0]);
    expect(test.flow.view.reservationPending).toBe(false);
    expect(test.flow.view.order?.id).toBe(test.order.id);
  });

  it("recovers an unknown exact reservation after policy expiry without allowing new terms", async () => {
    const test = browserHarness("withdrawal", {
      policyLifetime: 1,
      loseFirstReservationResponse: true,
    });
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("2.5", "withdrawal");
    await expect(
      test.flow.createOrder("demo:synthetic-account")
    ).rejects.toThrow("response was lost");
    test.advance(1);
    expect(test.flow.recoveryOnly).toBe(true);
    await expect(test.flow.quote("2.5", "withdrawal")).rejects.toThrow(
      "Policy expired"
    );
    await test.flow.createOrder("demo:synthetic-account");
    expect(test.reservationRequests).toHaveLength(2);
    expect(test.reservationRequests[1]).toEqual(test.reservationRequests[0]);
    expect(test.flow.view.reservationPending).toBe(false);
    expect(test.flow.view.order?.id).toBe(test.order.id);
    await expect(test.flow.requestProof()).rejects.toThrow("Policy expired");
  });

  it("refuses an expired quote before starting a new reservation", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    test.advance(600);
    await expect(test.flow.createOrder()).rejects.toThrow("Quote expired");
    expect(test.reservationRequests).toHaveLength(0);
    expect(test.flow.view.reservationPending).toBe(false);
    expect(test.flow.view.order).toBeNull();
  });

  it("permits a fresh quote after the server confirms expiry before reserving an order", async () => {
    const test = browserHarness("deposit", {
      reservationRejection: { status: 409, code: "quote_expired" },
    });
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    await expect(test.flow.createOrder()).rejects.toThrow(
      "Quote expired before reservation"
    );
    expect(test.flow.view.reservationPending).toBe(false);
    expect(test.flow.view.order).toBeNull();
    expect(test.flow.view.quote).toBeNull();
    await test.flow.quote("100.00");
    expect(test.flow.view.quote?.id).toBe("qt_demo");
  });

  it.each([
    { status: 400 as const, code: "quote_expired" },
    { status: 409 as const, code: "unknown_conflict" },
    { status: 503 as const, code: "unavailable" },
  ])(
    "preserves unknown reservation recovery for HTTP $status / $code",
    async (reservationRejection) => {
      const test = browserHarness("deposit", { reservationRejection });
      await test.flow.initialize();
      await test.flow.connect();
      await test.flow.quote("100.00");
      await expect(test.flow.createOrder()).rejects.toThrow(
        "Reconcile before retrying"
      );
      expect(test.flow.view.reservationPending).toBe(true);
      expect(test.flow.view.quote?.id).toBe("qt_demo");
      expect(() => test.flow.clearQuote()).toThrow(
        "Reconcile the existing reservation"
      );
    }
  );

  it("keeps reservation recovery locked until the response matches the authenticated wallet", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    const recipient = test.order.recipient;
    test.order.recipient = Keypair.random().publicKey();
    await expect(test.flow.createOrder()).rejects.toThrow("wallet and vault");
    expect(test.flow.view.reservationPending).toBe(true);
    expect(test.flow.view.order).toBeNull();
    test.order.recipient = recipient;
    await test.flow.createOrder();
    expect(test.flow.view.reservationPending).toBe(false);
    expect(test.flow.view.order?.recipient).toBe(recipient);
    expect(test.reservationRequests[1]).toEqual(test.reservationRequests[0]);
  });

  it("requires a newly reviewed quote after explicitly editing unreserved terms", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    test.flow.clearQuote();
    expect(test.flow.view.quote).toBeNull();
    await expect(test.flow.createOrder()).rejects.toThrow("fresh quote");
    expect(test.reservationRequests).toHaveLength(0);
    await test.flow.quote("100.00");
    await test.flow.createOrder();
    expect(() => test.flow.clearQuote()).toThrow("existing order");
    expect(test.flow.view.order?.id).toBe(test.order.id);
  });

  it("reconnects after policy expiry to finish an already-authorized withdrawal without allowing new actions", async () => {
    const test = browserHarness("withdrawal", { clockOffset: 3601 });
    Object.assign(test.order, {
      stage: "payout_authorized",
      payout_authorized_at: test.order.created_at,
      escrowed: true,
      expired: true,
    });
    await test.flow.initialize();
    expect(test.flow.view.info).not.toBeNull();
    expect(test.flow.view.message).toContain("Recovery only");
    await test.flow.connect();
    expect(test.flow.view.wallet).toBe(test.order.recipient);
    await expect(test.flow.quote("2.5", "withdrawal")).rejects.toThrow(
      "Policy expired"
    );
    await expect(
      test.flow.createOrder("demo:synthetic-account")
    ).rejects.toThrow("Policy expired");
    await test.flow.refresh(test.order.id);
    await expect(test.flow.requestProof()).rejects.toThrow("Policy expired");
    await expect(test.flow.signProof()).rejects.toThrow("Policy expired");
    await expect(test.flow.authorizePayout()).rejects.toThrow("Policy expired");
    await test.flow.simulateBank();
    expect(test.flow.view.order?.stage).toBe("paid");
    await test.flow.settle();
    expect(test.flow.view.order).toMatchObject({
      stage: "settled",
      completed: true,
      escrowed: false,
    });
  });

  it("blocks new actions when the policy expires after the page was initialized", async () => {
    const test = browserHarness("withdrawal", { policyLifetime: 1 });
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("2.5", "withdrawal");
    expect(test.flow.recoveryOnly).toBe(false);
    test.advance(1);
    expect(test.flow.recoveryOnly).toBe(true);
    await expect(test.flow.quote("2.5", "withdrawal")).rejects.toThrow(
      "Policy expired"
    );
    await expect(
      test.flow.createOrder("demo:synthetic-account")
    ).rejects.toThrow("Policy expired");
    Object.assign(test.order, {
      stage: "eligible",
      escrowed: true,
      eligibility_expires_at: test.order.deadline,
    });
    await test.flow.refresh(test.order.id);
    await expect(test.flow.requestProof()).rejects.toThrow("Policy expired");
    await expect(test.flow.signProof()).rejects.toThrow("Policy expired");
    await expect(test.flow.authorizePayout()).rejects.toThrow("Policy expired");
    await expect(test.flow.simulateBank()).rejects.toThrow("Policy expired");
    expect(test.flow.view.order?.stage).toBe("eligible");
  });

  it("keeps the existing deposit receipt when requesting a fresh eligibility proof", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    await test.flow.createOrder();
    Object.assign(test.order, {
      stage: "funded",
      receipt_id: "existing-deposit-receipt",
      eligibility_expires_at: test.order.created_at,
    });
    await test.flow.refresh();
    await test.flow.requestProof();
    expect(test.flow.view.phoneUrl).toBeTruthy();
    expect(test.flow.view.order).toMatchObject({
      stage: "funded",
      receipt_id: "existing-deposit-receipt",
    });
  });

  it("discards a deposit quote when the customer switches direction", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    test.flow.selectDirection("withdrawal");
    expect(test.flow.view.quote).toBeNull();
    await expect(
      test.flow.createOrder("demo:synthetic-account")
    ).rejects.toThrow("fresh quote");
  });

  it("reserves an exact reverse quote for a synthetic withdrawal destination", async () => {
    const test = browserHarness("withdrawal");
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("2.5", "withdrawal");
    await test.flow.createOrder("demo:synthetic-account");
    expect(test.flow.view.order).toMatchObject({
      direction: "withdrawal",
      amount_try: "100.00",
      amount_token: "2.5000000",
      bank_destination: "demo:synthetic-account",
      escrowed: false,
    });
  });

  it("shows a recorded mock credit without inventing an onchain paid receipt", async () => {
    const test = browserHarness("withdrawal");
    await test.flow.initialize();
    await test.flow.connect();
    Object.assign(test.order, {
      stage: "payout_authorized",
      escrowed: true,
      payout_authorized_at: test.order.created_at,
      mock_bank_credit: {
        destination: "demo:synthetic-account",
        amount_try: "100.00",
        credited_at: new Date(test.order.created_at * 1000).toISOString(),
      },
    });
    await test.flow.refresh(test.order.id);
    expect(test.flow.view.order).toMatchObject({
      stage: "payout_authorized",
      receipt_id: null,
      completed: false,
      mock_bank_credit: {
        destination: "demo:synthetic-account",
        amount_try: "100.00",
      },
    });
    await expect(test.flow.settle()).rejects.toThrow("receipt");
  });

  it("signs the exact native withdrawal invocation at the external wallet boundary", async () => {
    const test = browserHarness("withdrawal");
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("2.5", "withdrawal");
    await test.flow.createOrder("demo:synthetic-account");
    const transaction = new TransactionBuilder(
      new Account(test.order.recipient, "1"),
      { fee: "100", networkPassphrase: Networks.TESTNET }
    )
      .addOperation(
        new Contract(test.order.contract).call(
          "prove_order",
          nativeToScVal(Buffer.from(test.order.id, "hex")),
          nativeToScVal(Buffer.from(test.proof.proof.slice(11 * 64), "hex")),
          nativeToScVal(Buffer.from(test.proof.proof.slice(0, 11 * 64), "hex"))
        )
      )
      .setTimeout(60)
      .build();
    test.prepare({
      action_id: "synthetic-native-action",
      transaction: transaction.toXdr(),
      hash: Buffer.from(transaction.hash()).toString("hex"),
      expires_at: Number(transaction.timeBounds!.maxTime),
      network_passphrase: Networks.TESTNET,
    });
    await test.flow.requestProof();
    await test.events().proof(test.proof);
    expect(test.flow.view.order?.stage).toBe("created");
    await test.flow.signProof();
    expect(test.flow.view.order).toMatchObject({
      stage: "eligible",
      escrowed: true,
    });
  });

  it("finishes an already-authorized withdrawal after its proof deadline without authorizing twice", async () => {
    const test = browserHarness("withdrawal");
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("2.5", "withdrawal");
    await test.flow.createOrder("demo:synthetic-account");
    Object.assign(test.order, {
      stage: "eligible",
      escrowed: true,
      eligibility_expires_at: test.order.deadline,
    });
    await test.flow.refresh();
    await expect(test.flow.simulateBank()).rejects.toThrow("authorized");
    await test.flow.authorizePayout();
    expect(test.flow.view.order?.stage).toBe("payout_authorized");
    test.advance(601);
    Object.assign(test.order, { expired: true });
    await test.flow.refresh();
    await expect(test.flow.requestProof()).rejects.toThrow();
    await expect(test.flow.authorizePayout()).rejects.toThrow();
    await test.flow.simulateBank();
    expect(test.flow.view.order).toMatchObject({
      stage: "paid",
      completed: false,
      receipt_id: "mock-receipt-1",
    });
    await test.flow.settle();
    expect(test.flow.view.order).toMatchObject({
      stage: "settled",
      completed: true,
    });
  });

  it("displays the exact quote and never uploads a cancelled phone callback", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    expect(test.flow.view.quote?.buy_amount).toBe("2.5000000");
    await test.flow.createOrder();
    await test.flow.requestProof();
    expect(test.flow.view.phoneUrl).toBeTruthy();
    test.flow.cancelPhone();
    await test.events().proof({
      name: "outer_evm_count_6",
      version: "0.20.0",
      vkeyHash: test.policy.verifier_vk_hash,
      proof: "00".repeat(10240 + 352),
    });
    expect(test.uploads()).toBe(0);
    expect(test.flow.view.prepared).toBeNull();
    expect(test.flow.view.order?.stage).toBe("created");
  });

  it("removes the expired phone request and ignores its late proof callbacks", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    await test.flow.createOrder();
    await test.flow.requestProof();
    expect(test.flow.view.phoneUrl).toBeTruthy();
    test.advance(600);
    test.events().rejected();
    expect(test.flow.view.phoneUrl).toBe("");
    expect(test.flow.view.message).toContain("Phone request expired");
    await test.events().proof(test.proof);
    test.events().event("Late phone event must not replace expiry.");
    expect(test.uploads()).toBe(0);
    expect(test.flow.view.message).toContain("Phone request expired");
    expect(test.flow.view.prepared).toBeNull();
  });

  it("preserves same-order proof work but discards it when resuming another owned order", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    await test.flow.createOrder();
    await test.flow.requestProof();
    const originalPhone = test.events();
    const originalUrl = test.flow.view.phoneUrl;
    await test.flow.refresh();
    expect(test.flow.view.phoneUrl).toBe(originalUrl);
    test.order.id = "44".repeat(32);
    test.order.quote_id = "different-owned-order-quote";
    await test.flow.refresh(test.order.id);
    expect(test.flow.view.quote).toBeNull();
    expect(test.flow.view.phoneUrl).toBe("");
    await originalPhone.proof(test.proof);
    expect(test.uploads()).toBe(0);

    test.prepare({
      action_id: "synthetic-preparation-only",
      transaction: "This fixture is never offered to a wallet for signing.",
      hash: "55".repeat(32),
      expires_at: test.order.deadline,
      network_passphrase: Networks.TESTNET,
    });
    await test.flow.requestProof();
    await test.events().proof(test.proof);
    expect(test.flow.view.prepared?.action_id).toBe(
      "synthetic-preparation-only"
    );
    await test.flow.refresh();
    expect(test.flow.view.prepared?.action_id).toBe(
      "synthetic-preparation-only"
    );
    test.order.id = "66".repeat(32);
    await test.flow.refresh(test.order.id);
    expect(test.flow.view.prepared).toBeNull();
    await expect(test.flow.signProof()).rejects.toThrow(
      "fresh proof transaction"
    );
  });

  it("rejects a prepared payment instead of offering it as a proof signature", async () => {
    const test = browserHarness();
    await test.flow.initialize();
    await test.flow.connect();
    await test.flow.quote("100.00");
    await test.flow.createOrder();
    const payment = new TransactionBuilder(
      new Account(test.order.recipient, "1"),
      { fee: "100", networkPassphrase: Networks.TESTNET }
    )
      .addOperation(
        Operation.payment({
          destination: test.order.recipient,
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(60)
      .build();
    test.prepare({
      action_id: "wrong_operation",
      transaction: payment.toXdr(),
      hash: Buffer.from(payment.hash()).toString("hex"),
      expires_at: Number(payment.timeBounds!.maxTime),
      network_passphrase: Networks.TESTNET,
    });
    await test.flow.requestProof();
    await test.events().proof(test.proof);
    expect(test.flow.view.prepared).not.toBeNull();
    await expect(test.flow.signProof()).rejects.toThrow("proof invocation");
    expect(test.flow.view.order?.stage).toBe("created");
  });
});

function makeBrowserNode() {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  return {
    textContent: "",
    value: "",
    disabled: false,
    hidden: false,
    onclick: null as (() => void) | null,
    oninput: null as (() => void) | null,
    classList: {
      add(value: string) {
        classes.add(value);
      },
      remove(value: string) {
        classes.delete(value);
      },
      contains(value: string) {
        return classes.has(value);
      },
      toggle(value: string, force?: boolean) {
        const enabled = force ?? !classes.has(value);
        if (enabled) classes.add(value);
        else classes.delete(value);
        return enabled;
      },
    },
    replaceChildren() {},
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    focus() {},
    closest(selector: string): object | null {
      return selector === "[hidden]" && this.hidden ? this : null;
    },
    append() {},
    getContext() {
      return { clearRect() {} };
    },
  };
}

async function browserPageHarness(
  options: {
    walletAvailable?: boolean;
    walletUnresponsive?: boolean;
    direction?: "deposit" | "withdrawal";
  } = {}
) {
  const test = browserHarness(options.direction);
  const nodes = new Map<string, ReturnType<typeof makeBrowserNode>>();
  let activeNode: ReturnType<typeof makeBrowserNode> | null = null;
  const node = (id: string) => {
    if (!nodes.has(id)) {
      const value = makeBrowserNode();
      value.focus = () => {
        activeNode = value;
      };
      nodes.set(id, value);
    }
    return nodes.get(id)!;
  };
  let receiveProof: ((proof: unknown) => void) | undefined;
  let rejectProof: (() => void) | undefined;
  let tick: (() => void) | undefined;
  const walletAccess = vi.fn(async () => ({ address: test.order.recipient }));
  vi.resetModules();
  vi.doMock("@stellar/freighter-api", () => ({
    isConnected: async () =>
      options.walletUnresponsive
        ? new Promise<{ isConnected: boolean }>(() => {})
        : { isConnected: options.walletAvailable ?? true },
    getAddress: async () => ({ address: test.order.recipient }),
    getNetworkDetails: async () => ({ networkPassphrase: Networks.TESTNET }),
    requestAccess: walletAccess,
    signTransaction: async (transaction: string) => ({
      signerAddress: test.order.recipient,
      signedTxXdr: test.sign(transaction),
    }),
    WatchWalletChanges: class {
      watch() {}
      stop() {}
    },
  }));
  vi.doMock("qrcode", () => ({ default: { toCanvas: async () => {} } }));
  vi.doMock("@zkpassport/sdk", () => ({
    VERSION: "0.17.1",
    ZKPassport: class {
      clearAllRequests() {}
      async request() {
        const builder = {
          gte() {
            return builder;
          },
          in() {
            return builder;
          },
          bind() {
            return builder;
          },
          done() {
            return {
              url: "https://zkpassport.id/r/synthetic-fixture",
              onBridgeConnect() {},
              onRequestReceived() {},
              onGeneratingProof() {},
              onBridgeConnectionLost() {},
              onError() {},
              onReject(callback: () => void) {
                rejectProof = callback;
              },
              onProofGenerated(callback: (proof: unknown) => void) {
                receiveProof = callback;
              },
            };
          },
        };
        return builder;
      }
    },
  }));
  vi.stubGlobal("window", {
    location: { origin: "http://localhost:8787", hostname: "localhost" },
    fetch: test.browserFetch,
    addEventListener() {},
  });
  vi.stubGlobal("document", {
    getElementById: node,
    createElement: makeBrowserNode,
    get activeElement() {
      return activeNode;
    },
  });
  vi.stubGlobal("setInterval", (callback: () => void) => {
    tick = callback;
    return 0;
  });
  const browserEntry = "../web/anchor-gate.js";
  await import(browserEntry);
  await vi.waitFor(() => expect(node("connect").disabled).toBe(false));
  return {
    ...test,
    node,
    focusedId() {
      return [...nodes].find(([, value]) => value === activeNode)?.[0];
    },
    walletAccess,
    receiveProof() {
      receiveProof!(test.proof);
    },
    rejectProof() {
      rejectProof!();
    },
    tick() {
      tick!();
    },
    async click(id: string) {
      expect(node(id).disabled).toBe(false);
      node(id).focus();
      node(id).onclick!();
      await vi.waitFor(
        () => expect(node("status-label").textContent).not.toBe("WORKING"),
        { timeout: 4000 }
      );
    },
    cleanup() {
      vi.unstubAllGlobals();
      vi.doUnmock("@stellar/freighter-api");
      vi.doUnmock("@zkpassport/sdk");
      vi.doUnmock("qrcode");
      vi.resetModules();
    },
  };
}

describe("production-built gated browser serving", () => {
  it("keeps a rejected phone request visible after its QR is removed", async () => {
    const test = await browserPageHarness();
    try {
      await test.click("connect");
      test.node("amount").value = "100.00";
      await test.click("quote");
      expect(test.focusedId()).toBe("quote-heading");
      await test.click("reserve");
      await test.click("prove");
      expect(test.focusedId()).toBe("proof-heading");
      await test.click("cancel-proof");
      expect(test.focusedId()).toBe("prove");
      expect(test.node("phone-box").hidden).toBe(true);
      expect(test.node("status").textContent).toContain(
        "Phone request cancelled"
      );
      await test.click("prove");
      test.rejectProof();
      expect(test.node("phone-box").hidden).toBe(true);
      expect(test.node("cancel-proof").hidden).toBe(true);
      expect(test.node("prove").hidden).toBe(false);
      expect(test.node("status-bar").hidden).toBe(false);
      expect(test.node("status").textContent).toContain(
        "Phone request rejected"
      );
      expect(test.node("status").textContent).toContain(
        "No eligibility or payout was granted"
      );
      expect(test.node("status-announcement").textContent).toBe(
        test.node("status").textContent
      );
    } finally {
      test.cleanup();
    }
  });

  it("offers withdrawal settlement actions one confirmed stage at a time", async () => {
    const test = await browserPageHarness({ direction: "withdrawal" });
    try {
      await test.click("choose-withdrawal");
      await test.click("connect");
      test.node("amount").value = "2.5";
      test.node("bank-destination").value = "demo:synthetic-account";
      await test.click("quote");
      await test.click("reserve");
      for (const id of ["authorize-payout", "bank-action", "settle"])
        expect(test.node(id).hidden, id).toBe(true);
      Object.assign(test.order, {
        stage: "eligible",
        escrowed: true,
        eligibility_expires_at: test.order.deadline,
      });
      await test.click("refresh");
      expect(test.node("authorize-payout").hidden).toBe(false);
      expect(test.node("bank-action").hidden).toBe(true);
      expect(test.node("settle").hidden).toBe(true);
      await test.click("authorize-payout");
      expect(test.focusedId()).toBe("settle-heading");
      expect(test.node("authorize-payout").hidden).toBe(true);
      expect(test.node("bank-action").hidden).toBe(false);
      expect(test.node("settle").hidden).toBe(true);
      await test.click("bank-action");
      expect(test.focusedId()).toBe("settle-heading");
      expect(test.node("bank-action").hidden).toBe(true);
      expect(test.node("settle").hidden).toBe(false);
      await test.click("settle");
      for (const id of [
        "authorize-payout",
        "bank-action",
        "settle",
        "prove",
        "signature-box",
      ])
        expect(test.node(id).hidden, id).toBe(true);
      expect(test.node("completion").hidden).toBe(false);
      expect(test.node("completion-amount").textContent).toBe(
        "2.5000000 mock USDC -> 100.00 simulated TRY"
      );
    } finally {
      test.cleanup();
    }
  });

  it("shows only the current wallet and quote actions before an order exists", async () => {
    const test = await browserPageHarness();
    try {
      expect(test.node("connect").hidden).toBe(false);
      for (const id of [
        "disconnect",
        "wallet-card",
        "session-options",
        "exchange-summary",
        "reserve",
        "refresh",
        "status-bar",
      ])
        expect(test.node(id).hidden, id).toBe(true);
      await test.click("connect");
      expect(test.node("connect").hidden).toBe(true);
      expect(test.node("wallet-card").hidden).toBe(false);
      expect(test.node("session-options").hidden).toBe(false);
      expect(test.node("quote").hidden).toBe(false);
      expect(test.node("quote-inputs").hidden).toBe(false);
      test.node("amount").focus();
      test.tick();
      expect(test.focusedId()).toBe("amount");
      test.node("amount").value = "100.00";
      await test.click("quote");
      expect(test.node("quote").hidden).toBe(true);
      expect(test.node("quote-inputs").hidden).toBe(true);
      expect(test.node("quote-heading").textContent).toBe("Review your quote");
      expect(test.node("reserve").hidden).toBe(false);
      expect(test.node("reserve").disabled).toBe(false);
      expect(test.node("exchange-summary").hidden).toBe(false);
      expect(test.node("quote-requirements").textContent).toBe(
        "Age 18+ / Nationality: GBR, USA / Document issuer: any"
      );
      expect(test.node("order-summary").hidden).toBe(true);
      await test.click("reserve");
      expect(test.node("reserve").hidden).toBe(true);
      expect(test.node("refresh").hidden).toBe(false);
      expect(test.node("order-summary").hidden).toBe(false);
      expect(test.node("order-summary").textContent).toBe(
        "100.00 simulated TRY -> 2.5000000 mock USDC"
      );
      const expiredClock = vi
        .spyOn(Date, "now")
        .mockReturnValue((test.order.deadline + 1) * 1000);
      try {
        test.tick();
        expect(test.node("status-bar").hidden).toBe(false);
        expect(test.node("status").textContent).toContain(
          "order deadline passed"
        );
        expect(test.node("status").textContent).toContain(
          "not automatically refunded"
        );
      } finally {
        expiredClock.mockRestore();
      }
      await test.click("disconnect");
      expect(test.focusedId()).toBe("wallet-heading");
    } finally {
      test.cleanup();
    }
  });

  it("does not claim submission when resuming a pending unsigned proof", async () => {
    const test = await browserPageHarness();
    try {
      Object.assign(test.order, {
        actions: [
          {
            id: "unsigned-prepared-proof",
            kind: "prove",
            transaction_hash: "44".repeat(32),
            status: "pending",
            ledger: null,
            expires_at: test.order.deadline,
          },
        ],
      });
      await test.click("connect");
      test.node("order-id").value = test.order.id;
      test.node("order-id").oninput!();
      await test.click("resume-order");
      for (const id of ["status", "settlement-next"]) {
        expect(test.node(id).textContent).not.toContain("submitted");
        expect(test.node(id).textContent).toContain("not confirmed");
        expect(test.node(id).textContent).toContain("Check status");
      }
      expect(test.node("sign-proof").disabled).toBe(true);
      expect(test.node("bank-action").disabled).toBe(true);
      expect(test.node("completion").hidden).toBe(true);
      expect(test.node("status-bar").hidden).toBe(false);
      expect(test.node("refresh").hidden).toBe(false);
      expect(test.node("signature-box").hidden).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it("resumes an owned order beside its input without requiring the distant status button", async () => {
    const test = await browserPageHarness();
    try {
      expect(test.node("resume-order").disabled).toBe(true);
      await test.click("choose-withdrawal");
      expect(test.node("status").textContent).toContain("Connect Freighter");
      await test.click("connect");
      test.node("order-id").value = test.order.id;
      test.node("order-id").oninput!();
      await test.click("resume-order");
      expect(test.node("order").textContent).toContain(test.order.id);
      expect(test.node("amount").value).toBe("100.00");
      expect(test.node("quote-card").hidden).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it.each([
    { name: "unavailable", walletAvailable: false },
    { name: "unresponsive", walletUnresponsive: true },
  ])(
    "ends login with useful guidance when Freighter is $name",
    async (options) => {
      const test = await browserPageHarness(options);
      try {
        await test.click("connect");
        expect(test.node("status").textContent).toContain(
          "Freighter is unavailable in this browser"
        );
        expect(test.node("connect").disabled).toBe(false);
        expect(test.node("wallet-state").textContent).toBe("Not connected");
        expect(test.focusedId()).toBe("connect");
        expect(test.node("status-announcement").textContent).toBe(
          test.node("status").textContent
        );
        expect(test.walletAccess).not.toHaveBeenCalled();
      } finally {
        test.cleanup();
      }
    }
  );

  it("keeps the exact prepared proof signable after checking its unsubmitted chain status", async () => {
    const test = await browserPageHarness();
    try {
      await test.click("connect");
      test.node("amount").value = "100.00";
      await test.click("quote");
      await test.click("reserve");
      expect(test.node("prove").hidden).toBe(false);
      expect(test.node("cancel-proof").hidden).toBe(true);
      expect(test.node("signature-box").hidden).toBe(true);
      const transaction = new TransactionBuilder(
        new Account(test.order.recipient, "1"),
        { fee: "100", networkPassphrase: Networks.TESTNET }
      )
        .addOperation(
          new Contract(test.order.contract).call(
            "prove_order",
            nativeToScVal(Buffer.from(test.order.id, "hex")),
            nativeToScVal(Buffer.from(test.proof.proof.slice(11 * 64), "hex")),
            nativeToScVal(
              Buffer.from(test.proof.proof.slice(0, 11 * 64), "hex")
            )
          )
        )
        .setTimeout(60)
        .build();
      const hash = Buffer.from(transaction.hash()).toString("hex");
      test.prepare({
        action_id: "exact-prepared-proof",
        transaction: transaction.toXdr(),
        hash,
        expires_at: Number(transaction.timeBounds!.maxTime),
        network_passphrase: Networks.TESTNET,
      });
      await test.click("prove");
      expect(test.node("prove").hidden).toBe(true);
      expect(test.node("phone-box").hidden).toBe(false);
      expect(test.node("cancel-proof").hidden).toBe(false);
      expect(test.node("status-bar").hidden).toBe(false);
      test.receiveProof();
      await vi.waitFor(() =>
        expect(test.node("sign-proof").disabled).toBe(false)
      );
      expect(test.node("signature-box").hidden).toBe(false);
      expect(test.node("prove").hidden).toBe(true);
      expect(test.node("proof-instruction").textContent).toContain("Sign");
      expect(test.node("proof-requirements").textContent).toContain("18+");
      const expiredClock = vi
        .spyOn(Date, "now")
        .mockReturnValue((Number(transaction.timeBounds!.maxTime) + 1) * 1000);
      try {
        test.tick();
        expect(test.node("sign-proof").disabled).toBe(true);
        expect(test.node("signature-box").hidden).toBe(false);
        expect(test.node("prove").hidden).toBe(false);
        expect(test.node("proof-instruction").textContent).toContain("expired");
        expect(test.node("status").textContent).toContain(
          "signature request expired"
        );
        expiredClock.mockReturnValue((test.order.deadline + 1) * 1000);
        test.tick();
        expect(test.node("prove").disabled).toBe(true);
        expect(test.node("sign-proof").disabled).toBe(true);
        for (const id of ["proof-instruction", "status"]) {
          expect(test.node(id).textContent).toContain("order deadline passed");
          expect(test.node(id).textContent).toContain(
            "not automatically refunded"
          );
          expect(test.node(id).textContent).toContain("Check status");
          expect(test.node(id).textContent).not.toContain("new QR");
        }
      } finally {
        expiredClock.mockRestore();
        test.tick();
      }
      Object.assign(test.order, {
        actions: [
          {
            id: "exact-prepared-proof",
            kind: "prove",
            transaction_hash: hash,
            status: "pending",
            ledger: null,
            expires_at: Number(transaction.timeBounds!.maxTime),
          },
        ],
      });
      await test.click("refresh");
      expect(test.node("sign-proof").disabled).toBe(false);
      expect(test.node("prove").disabled).toBe(true);
      expect(test.node("bank-action").disabled).toBe(true);
      await test.click("sign-proof");
      expect(test.order.stage).toBe("eligible");
    } finally {
      test.cleanup();
    }
  });

  it.each([
    {
      name: "exact 18+/ZKR/ZKR",
      age: 18,
      nationalities: ["ZKR"],
      issuers: ["ZKR"],
      stock: true,
    },
    {
      name: "different nationality",
      age: 18,
      nationalities: ["TUR"],
      issuers: ["ZKR"],
      stock: false,
    },
    {
      name: "different issuer",
      age: 18,
      nationalities: ["ZKR"],
      issuers: ["TUR"],
      stock: false,
    },
    {
      name: "different minimum age",
      age: 21,
      nationalities: ["ZKR"],
      issuers: ["ZKR"],
      stock: false,
    },
    {
      name: "broader nationality list",
      age: 18,
      nationalities: ["TUR", "ZKR"],
      issuers: ["ZKR"],
      stock: false,
    },
  ])(
    "renders synthetic-document guidance for $name without claiming approval",
    async ({ age, nationalities, issuers, stock }) => {
      const test = browserHarness("deposit", { externalInputs: 12 });
      test.policy.min_age = age;
      test.policy.allowed_nationalities = nationalities;
      test.policy.allowed_issuers = issuers;
      test.policy.verifier_vk_hash =
        "00fe2b15b91a3c7c3ede7f84a0751e29373bfbf2da0ab7392e2cfa564eab8ab7";
      const nodes = new Map<string, ReturnType<typeof makeBrowserNode>>();
      const node = (id: string) => {
        if (!nodes.has(id)) nodes.set(id, makeBrowserNode());
        return nodes.get(id)!;
      };
      vi.resetModules();
      vi.doMock("@stellar/freighter-api", () => ({
        getAddress() {
          throw new Error("No wallet action expected");
        },
        getNetworkDetails() {
          throw new Error("No wallet action expected");
        },
        requestAccess() {
          throw new Error("No wallet action expected");
        },
        signTransaction() {
          throw new Error("No wallet action expected");
        },
        WatchWalletChanges: class {
          watch() {}
          stop() {}
        },
      }));
      vi.doMock("@zkpassport/sdk", () => ({
        VERSION: "0.17.1",
        ZKPassport: class {
          constructor() {
            throw new Error("No phone request expected");
          }
        },
      }));
      vi.stubGlobal("window", {
        location: { origin: "http://localhost:8787", hostname: "localhost" },
        fetch: test.browserFetch,
        addEventListener() {},
      });
      vi.stubGlobal("document", { getElementById: node });
      vi.stubGlobal("setInterval", () => 0);
      try {
        const browserEntry = "../web/anchor-gate.js";
        await import(browserEntry);
        await vi.waitFor(() => expect(node("connect").disabled).toBe(false));
        if (stock) {
          expect(node("proof-help").textContent).toContain("John Smith");
          expect(node("proof-help").textContent).toContain("1995-11-12");
        } else {
          expect(node("proof-help").textContent).not.toContain("John Smith");
          expect(node("proof-help").textContent).not.toContain("1995-11-12");
          expect(node("proof-help").textContent).toContain(
            "matching the exact age, nationality and issuing-country policy"
          );
        }
        expect(node("proof-help").textContent).toContain("synthetic");
        expect(node("proof-help").textContent).toContain(
          "Do not use a real ID"
        );
        expect(node("proof-help").textContent).toContain(
          "phone proof is not onchain approval"
        );
        expect(node("proof-consent").textContent).toContain(
          "Receiving a proof is not approval"
        );
        expect(node("prove").disabled).toBe(true);
        expect(node("bank-action").disabled).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        vi.doUnmock("@stellar/freighter-api");
        vi.doUnmock("@zkpassport/sdk");
        vi.resetModules();
      }
    }
  );

  it("serves generated assets with private-session headers only at the configured host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "anchor-gate-browser-"));
    try {
      await buildAnchorGateBrowser(directory);
      const app = anchorGateBrowserRoutes("https://anchor.example", directory);
      const page = await app.request("https://anchor.example/anchor-gate");
      expect(page.status).toBe(200);
      expect(page.headers.get("Cache-Control")).toBe("no-store");
      expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(page.headers.get("Content-Security-Policy")).toContain(
        "frame-ancestors 'none'"
      );
      const html = await page.text();
      expect(html.includes('src="/anchor-gate/bundle.js"')).toBe(true);
      expect(html.includes('id="authorize-payout"')).toBe(true);
      const bundle = await app.request(
        "https://anchor.example/anchor-gate/bundle.js"
      );
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("Content-Type")).toContain(
        "application/javascript"
      );
      expect((await bundle.text()).includes("Stellar Proof-Gated Anchor")).toBe(
        true
      );
      expect(
        (await app.request("https://other.example/anchor-gate")).status
      ).toBe(403);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
