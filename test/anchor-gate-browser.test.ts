import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
import { Hono } from "hono";
import {
  createAnchorGateFlow,
  type PhoneEvents,
} from "../web/anchor-gate-flow.js";

function browserHarness() {
  const now = Math.floor(Date.now() / 1000);
  const wallet = Keypair.random();
  const anchor = Keypair.random();
  const contract = StrKey.encodeContract(new Uint8Array(32).fill(7));
  const token = new Asset("USDC", anchor.publicKey()).contractId(
    Networks.TESTNET
  );
  const policy = {
    min_age: 18,
    allowed_nationalities: ["GBR", "USA"],
    allowed_issuers: [],
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
    source_asset: "iso4217:TRY",
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
        external_inputs: 11,
        max_order_lifetime: 600,
        policy_valid_until: now + 3600,
        max_amount: "1000000000",
        max_try_minor: "100000",
      },
    })
  );
  app.post("/sep38/quote", (c) =>
    c.json({
      id: "qt_demo",
      sell_asset: "iso4217:TRY",
      buy_asset: `stellar:USDC:${anchor.publicKey()}`,
      sell_amount: "100.00",
      buy_amount: "2.5000000",
      expires_at: new Date((now + 600) * 1000).toISOString(),
      fee: { total: "1.00", asset: "iso4217:TRY" },
    })
  );
  app.post("/anchor-gate/orders", (c) => c.json(order));
  app.get("/anchor-gate/orders/:id", (c) => c.json(order));
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
      request: async (_config, callbacks) => {
        events = callbacks;
        return {
          url: "https://zkpassport.id/r/synthetic-fixture",
          cancel() {},
        };
      },
    },
    changed() {},
    now: () => now * 1000,
  });
  return {
    flow,
    order,
    policy,
    events: () => events!,
    uploads: () => uploads,
    prepare(value: unknown) {
      prepared = value;
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
