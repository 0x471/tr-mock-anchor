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
    fetch: async (input, init) => app.request(String(input), init),
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

describe("production-built gated browser serving", () => {
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
      const nodes = new Map<
        string,
        {
          textContent: string;
          value: string;
          disabled: boolean;
          hidden: boolean;
          classList: { add(): void; remove(): void };
          replaceChildren(): void;
        }
      >();
      const node = (id: string) => {
        if (!nodes.has(id))
          nodes.set(id, {
            textContent: "",
            value: "",
            disabled: false,
            hidden: false,
            classList: { add() {}, remove() {} },
            replaceChildren() {},
          });
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
