import { afterEach, expect, it } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { config } from "../src/config.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb, type DB } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createFakeGateway } from "../src/stellar.js";
import { createSepContext } from "../src/sepauth.js";
import { signJwt } from "../src/jwt.js";
import { createSepAnchor } from "../src/sep-anchor.js";
import { createSepAnchorRoutes } from "../src/routes/sep-anchor.js";
import type {
  SepAnchorGateway,
  SepChainAction,
  SepChainOrder,
  SepEligibility,
  SepIncomingPayment,
} from "../src/sep-anchor-types.js";
import type { SepAnchorView } from "../src/sep-anchor.js";
import { z } from "zod";
import { ApiError } from "../src/errors.js";

const databases: DB[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const now = () => Math.floor(Date.now() / 1000);
const provider = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();

class NativeTestnet implements SepAnchorGateway {
  orders = new Map<string, SepChainOrder>();
  grants = new Map<string, SepEligibility>();
  prepared = new Map<string, SepChainAction>();
  confirmed = new Set<string>();
  loseSubmissionResponse = false;
  pending = false;
  expectedSubject: string | null = null;
  rejectAuthorization = false;
  recipientState: "ready" | "missing_trustline" = "ready";
  providerState:
    | "ready"
    | "missing_account"
    | "missing_trustline"
    | "unauthorized"
    | "insufficient_limit" = "ready";
  ingressUnavailable = false;
  policyExpiry = now() + 3600;
  async configuration() {
    return {
      contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
      token: new Asset(config.usdcCode, config.usdcIssuer).contractId(
        Networks.TESTNET
      ),
      provider,
      bank_notary: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 8)).publicKey(),
      domain: "localhost",
      scope: "sep-anchor-test",
      policy_hash: "12".repeat(32),
      policy: { min_age: 18, mock_only: true },
      proof_bytes: 10240,
      external_inputs: 13,
      max_order_lifetime: 1800,
      policy_valid_until: this.policyExpiry,
      max_amount: "1000000000",
      max_try_minor: "1000000",
      ledger_time: now(),
    };
  }
  async challenge(subject: string) {
    if (this.expectedSubject && this.expectedSubject !== subject)
      throw new Error(
        "Native subject binding does not match the pinned cross-language vector"
      );
    return "34".repeat(32);
  }
  async eligibility(subject: string) {
    return this.grants.get(subject) ?? null;
  }
  async order(id: string) {
    return this.orders.get(id) ?? null;
  }
  async prepare(action: SepChainAction) {
    if (action.kind === "authorize" && this.rejectAuthorization)
      throw new ApiError(
        422,
        "gate_simulation_rejected",
        "Native authorization rejected."
      );
    const hash = createHash("sha256")
      .update(JSON.stringify([action, this.prepared.size]))
      .digest("hex");
    this.prepared.set(hash, action);
    return {
      transaction: hash,
      hash,
      min_time: now() - 30,
      expires_at: now() + 120,
    };
  }
  async submit(transaction: string) {
    if (this.pending) return { status: "pending" as const, ledger: null };
    if (!this.confirmed.has(transaction)) {
      const action = this.prepared.get(transaction)!;
      if (action.kind === "eligibility")
        this.grants.set(action.subject, {
          proof_time: now(),
          valid_until: now() + 600,
          confirmed_ledger: 99,
        });
      else if (action.kind === "create")
        this.orders.set(action.id, {
          ...action.terms,
          id: action.id,
          policy_hash: "12".repeat(32),
          created_at: now(),
          confirmed_ledger: 99,
          escrowed: action.terms.direction === "deposit",
          funding_id: null,
          receipt: null,
          payout_authorized_at: null,
          settled_at: null,
          refunded_at: null,
          cancelled_at: null,
        });
      else {
        const order = this.orders.get(action.id)!;
        if (action.kind === "receipt") order.receipt = action.receipt;
        if (action.kind === "fund") {
          order.funding_id = action.operation_id;
          order.escrowed = true;
        }
        if (action.kind === "authorize") order.payout_authorized_at = now();
        if (action.kind === "settle") {
          order.settled_at = now();
          order.escrowed = false;
        }
        if (action.kind === "refund") {
          order.refunded_at = now();
          order.escrowed = false;
        }
        if (action.kind === "cancel") {
          order.cancelled_at = now();
          order.escrowed = false;
        }
      }
      this.confirmed.add(transaction);
    }
    if (this.loseSubmissionResponse) {
      this.loseSubmissionResponse = false;
      throw new Error("Submission response lost");
    }
    return { status: "success" as const, ledger: 99 };
  }
  async transaction(hash: string) {
    return this.confirmed.has(hash)
      ? { status: "success" as const, ledger: 99 }
      : { status: "pending" as const, ledger: null };
  }
}

function fixture(walletOverride?: string) {
  const cfg = {
    ...config,
    publicUrl: "http://localhost:8787",
    anchorMode: "zkpassport" as const,
    stellarMode: "fake" as const,
    rateSource: "static" as const,
    staticUsdTry: "40.00",
    spreadBps: 50,
    anchorGateAllowedWallets: [],
    anchorGateOfacEnabled: false,
  };
  const db = openDb(":memory:");
  databases.push(db);
  const gateway = new NativeTestnet();
  const payments: SepIncomingPayment[] = [];
  const deps: Deps = {
    cfg,
    db,
    stellar: createFakeGateway(cfg),
    rates: createRateService(cfg),
    log: createLogger(true),
    sepAnchorIngress: {
      account: provider,
      asset: `stellar:${cfg.usdcCode}:${cfg.usdcIssuer}`,
      async recipientStatus(account) {
        return account === provider
          ? gateway.providerState
          : gateway.recipientState;
      },
      async payments() {
        if (gateway.ingressUnavailable) throw new Error("Horizon unavailable");
        return { payments, cursor: payments.at(-1)?.paging_token };
      },
    },
  };
  const sep = createSepContext(deps);
  let engine = createSepAnchor(deps, gateway);
  let app = new Hono().route("/", createSepAnchorRoutes(deps, sep, engine));
  const wallet =
    walletOverride ??
    Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  const auth = (sub = wallet) => ({
    Authorization: `Bearer ${signJwt({ iss: `${cfg.publicUrl}/auth`, sub, iat: now(), exp: now() + 600 }, sep.jwtSecret)}`,
  });
  const request = (path: string, init?: RequestInit) =>
    app.request(`${cfg.publicUrl}${path}`, init);
  async function begin(
    direction: "deposit" | "withdraw" = "deposit",
    input: Record<string, string> = {}
  ) {
    const response = await request(
      `/sep24/transactions/${direction}/interactive`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_code: cfg.usdcCode,
          account: wallet,
          ...input,
        }),
      }
    );
    expect(response.status).toBe(200);
    const created = z
      .object({ id: z.string(), url: z.string() })
      .parse(await response.json());
    const url = new URL(created.url);
    const opened = await request(url.pathname + url.search);
    const cookie = opened.headers.get("Set-Cookie")!.split(";")[0]!;
    const state = await request(`/sep24/interactive/${created.id}/state`, {
      headers: { Cookie: cookie },
    });
    const data = z.object({ csrf_token: z.string() }).parse(await state.json());
    const action = (name: string, body: unknown = {}) =>
      request(`/sep24/interactive/${created.id}/${name}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: cfg.publicUrl,
          "X-CSRF-Token": data.csrf_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const get = async () =>
      (
        await request(`/sep24/transaction?id=${created.id}`, {
          headers: auth(),
        })
      ).json() as Promise<{ transaction: SepAnchorView }>;
    return { id: created.id, action, get };
  }
  return {
    begin,
    gateway,
    payments,
    wallet,
    cfg,
    request,
    auth,
    restart() {
      engine = createSepAnchor(deps, gateway);
      app = new Hono().route("/", createSepAnchorRoutes(deps, sep, engine));
    },
    tick: () => engine.tick(),
  };
}

it("holds a fixed quote until native eligibility is confirmed before advertising payment", async () => {
  const f = fixture();
  const order = await f.begin();
  const quoted = await order.action("quote", { sell_amount: "100.00" });
  expect(quoted.status).toBe(200);
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(await quoted.json()).quote;
  const accepted = await order.action("accept", { quote_id: quote.id });
  expect(accepted.status).toBe(200);
  const held = ((await accepted.json()) as { transaction: SepAnchorView })
    .transaction;
  expect(held.status).toBe("incomplete");
  expect(held.ready_for_payment).toBe(false);
  expect(held.amount_out).toBe("2.4875621");
  const proof = await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  expect(proof.status).toBe(200);
  const ready = ((await proof.json()) as { transaction: SepAnchorView })
    .transaction;
  expect(ready.native.eligible).toBe(true);
  expect(ready.status).toBe("pending_user_transfer_start");
  expect(ready.ready_for_payment).toBe(true);
  expect(ready.amount_out).toBe("2.4875621");
});

it("settles a deposit only after the explicit simulated bank action and recovers a lost submission response", async () => {
  const f = fixture();
  const order = await f.begin();
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "100.00" })).json()
    ).quote;
  await order.action("accept", { quote_id: quote.id });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  f.restart();
  expect((await order.get()).transaction.status).toBe(
    "pending_user_transfer_start"
  );
  f.gateway.loseSubmissionResponse = true;
  const result = await order.action("mock-bank");
  expect(result.status).toBe(200);
  f.restart();
  const completed = (await order.get()).transaction;
  expect(completed.status).toBe("completed");
  expect(completed.stellar_transaction_id).toMatch(/^[a-f0-9]{64}$/);
  expect(completed.external_transaction_id).toMatch(/^[a-f0-9]{64}$/);
  expect(completed.completed_at).not.toBeNull();
  const replay = await order.action("mock-bank");
  expect(
    ((await replay.json()) as { transaction: SepAnchorView }).transaction
      .stellar_transaction_id
  ).toBe(completed.stellar_transaction_id);
});

it("funds exact classic withdrawal payment once and waits for explicit simulated payout authorization", async () => {
  const f = fixture();
  const order = await f.begin("withdraw");
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "2.0000000" })).json()
    ).quote;
  await order.action("accept", {
    quote_id: quote.id,
    bank_destination: "demo:sample",
  });
  const proof = await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const ready = ((await proof.json()) as { transaction: SepAnchorView })
    .transaction;
  expect(ready.withdraw_anchor_account).toBe(provider);
  expect(ready.withdraw_memo_type).toBe("hash");
  f.payments.push({
    operation_id: "501",
    paging_token: "501",
    transaction_hash: "56".repeat(32),
    from: f.wallet,
    to: provider,
    asset: `stellar:${f.cfg.usdcCode}:${f.cfg.usdcIssuer}`,
    amount: "20000000",
    memo_type: "hash",
    memo: ready.withdraw_memo,
    created_at: new Date().toISOString(),
  });
  await f.tick();
  const held = (await order.get()).transaction;
  expect(held.status).toBe("pending_user");
  expect(held.ready_for_payment).toBe(false);
  expect(held.external_transaction_id).toBeNull();
  expect(held.stellar_transaction_id).toBe("56".repeat(32));
  f.gateway.providerState = "insufficient_limit";
  f.restart();
  await f.tick();
  const paid = await order.action("mock-bank");
  expect(paid.status).toBe(200);
  const completed = ((await paid.json()) as { transaction: SepAnchorView })
    .transaction;
  expect(completed.status).toBe("completed");
  expect(completed.amount_out).toBe("79.60");
  expect(
    completed.actions.filter((action) => action.kind === "fund")
  ).toHaveLength(1);
});

it("refunds exact escrow before payout authorization even after eligibility expires", async () => {
  const f = fixture();
  const order = await f.begin("withdraw");
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "2.0000000" })).json()
    ).quote;
  await order.action("accept", {
    quote_id: quote.id,
    bank_destination: "demo:sample",
  });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const ready = (await order.get()).transaction;
  f.payments.push({
    operation_id: "501",
    paging_token: "501",
    transaction_hash: "56".repeat(32),
    from: f.wallet,
    to: provider,
    asset: `stellar:${f.cfg.usdcCode}:${f.cfg.usdcIssuer}`,
    amount: "20000000",
    memo_type: "hash",
    memo: ready.withdraw_memo,
    created_at: new Date().toISOString(),
  });
  await f.tick();
  for (const grant of f.gateway.grants.values()) grant.valid_until = now() - 1;
  expect((await order.action("mock-bank")).status).toBe(409);
  const refunded = await order.action("refund");
  expect(refunded.status).toBe(200);
  const view = ((await refunded.json()) as { transaction: SepAnchorView })
    .transaction;
  expect(view.status).toBe("refunded");
  expect(view.refunded).toBe(true);
  expect(view.refunds?.amount_refunded).toBe("2.0000000");
  expect(view.refunds?.amount_fee).toBe("0.0000000");
  expect(view.refunds?.payments[0]?.id_type).toBe("stellar");
  f.restart();
  expect((await order.get()).transaction.refunds).toEqual(view.refunds);
  expect((await order.action("mock-bank")).status).toBe(409);
});

it("resumes the same SEP-6 quote after a retry without creating a replacement exchange", async () => {
  const f = fixture();
  const hosted = await f.begin();
  expect(
    (
      await hosted.action("proof", {
        proof: Buffer.alloc(10240).toString("hex"),
        public_inputs: Buffer.alloc(13 * 32).toString("hex"),
      })
    ).status
  ).toBe(200);
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await hosted.action("quote", { sell_amount: "100.00" })).json()
    ).quote;
  const query = new URLSearchParams({
    quote_id: quote.id,
    account: f.wallet,
    amount: "100.00",
    source_asset: "iso4217:TRY",
    destination_asset: "USDC",
    funding_method: "bank_account",
  });
  const path = `/sep6/deposit-exchange?${query}`;
  const first = await f.request(path, { headers: f.auth() });
  expect(first.status).toBe(200);
  const created = z
    .object({ id: z.string(), status: z.string() })
    .parse(await first.json());
  expect(created.status).toBe("pending_user_transfer_start");
  f.restart();
  const retry = await f.request(path, { headers: f.auth() });
  expect(retry.status).toBe(200);
  expect(z.object({ id: z.string() }).parse(await retry.json()).id).toBe(
    created.id
  );
  query.set("amount", "101.00");
  expect(
    (await f.request(`/sep6/deposit-exchange?${query}`, { headers: f.auth() }))
      .status
  ).toBe(409);
});

it.each(["deposit", "withdraw"] as const)(
  "rejects first-time SEP-6 %s before consuming its quote or reserving an order",
  async (direction) => {
    const f = fixture();
    const hosted = await f.begin(direction);
    const sold = direction === "deposit" ? "100.00" : "2.0000000";
    const quote = z
      .object({ quote: z.object({ id: z.string() }) })
      .parse(
        await (await hosted.action("quote", { sell_amount: sold })).json()
      ).quote;
    const query = new URLSearchParams({
      quote_id: quote.id,
      account: f.wallet,
      amount: sold,
      source_asset: direction === "deposit" ? "iso4217:TRY" : "USDC",
      destination_asset: direction === "deposit" ? "USDC" : "iso4217:TRY",
      funding_method: "bank_account",
      ...(direction === "withdraw" ? { bank_destination: "demo:wallet" } : {}),
    });
    const rejected = await f.request(`/sep6/${direction}-exchange?${query}`, {
      headers: f.auth(),
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      code: "native_eligibility_required",
    });
    const history = z
      .object({
        transactions: z.array(
          z.object({ id: z.string(), order_id: z.string().nullable() })
        ),
      })
      .parse(
        await (
          await f.request("/sep6/transactions?asset_code=USDC", {
            headers: f.auth(),
          })
        ).json()
      );
    expect(history.transactions).toEqual([{ id: hosted.id, order_id: null }]);
    expect(
      (
        await hosted.action("accept", {
          quote_id: quote.id,
          ...(direction === "withdraw"
            ? { bank_destination: "demo:wallet" }
            : {}),
        })
      ).status
    ).toBe(200);
    expect((await hosted.get()).transaction.order_id).toBeNull();
  }
);

it.each(["deposit", "withdraw"] as const)(
  "rejects an expired native grant before starting a SEP-6 %s",
  async (direction) => {
    const f = fixture();
    const hosted = await f.begin(direction);
    expect(
      (
        await hosted.action("proof", {
          proof: Buffer.alloc(10240).toString("hex"),
          public_inputs: Buffer.alloc(13 * 32).toString("hex"),
        })
      ).status
    ).toBe(200);
    expect((await hosted.get()).transaction.native.eligible).toBe(true);
    for (const grant of f.gateway.grants.values())
      grant.valid_until = now() - 1;
    const sold = direction === "deposit" ? "100.00" : "2.0000000";
    const quote = z
      .object({ quote: z.object({ id: z.string() }) })
      .parse(
        await (await hosted.action("quote", { sell_amount: sold })).json()
      ).quote;
    const query = new URLSearchParams({
      quote_id: quote.id,
      account: f.wallet,
      amount: sold,
      source_asset: direction === "deposit" ? "iso4217:TRY" : "USDC",
      destination_asset: direction === "deposit" ? "USDC" : "iso4217:TRY",
      funding_method: "bank_account",
      ...(direction === "withdraw" ? { bank_destination: "demo:wallet" } : {}),
    });
    const rejected = await f.request(`/sep6/${direction}-exchange?${query}`, {
      headers: f.auth(),
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      code: "native_eligibility_required",
      onboarding_url: "http://localhost:8787/anchor",
      transfer_server_sep0024: "http://localhost:8787/sep24",
    });
    const history = z
      .object({
        transactions: z.array(
          z.object({ id: z.string(), order_id: z.string().nullable() })
        ),
      })
      .parse(
        await (
          await f.request("/sep6/transactions?asset_code=USDC", {
            headers: f.auth(),
          })
        ).json()
      );
    expect(history.transactions).toEqual([{ id: hosted.id, order_id: null }]);
    expect(
      (
        await hosted.action("accept", {
          quote_id: quote.id,
          ...(direction === "withdraw"
            ? { bank_destination: "demo:wallet" }
            : {}),
        })
      ).status
    ).toBe(200);
    expect((await hosted.get()).transaction.order_id).toBeNull();
  }
);

it("provides standard SEP-6 withdrawal instructions for a current native grant", async () => {
  const f = fixture();
  const hosted = await f.begin("withdraw");
  expect(
    (
      await hosted.action("proof", {
        proof: Buffer.alloc(10240).toString("hex"),
        public_inputs: Buffer.alloc(13 * 32).toString("hex"),
      })
    ).status
  ).toBe(200);
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await hosted.action("quote", { sell_amount: "2.0000000" })).json()
    ).quote;
  const query = new URLSearchParams({
    quote_id: quote.id,
    account: f.wallet,
    amount: "2.0000000",
    source_asset: "USDC",
    destination_asset: "iso4217:TRY",
    funding_method: "bank_account",
    bank_destination: "demo:wallet",
  });
  const response = await f.request(`/sep6/withdraw-exchange?${query}`, {
    headers: f.auth(),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: "pending_user_transfer_start",
    account_id: provider,
    memo_type: "hash",
    memo: expect.any(String),
  });
  expect(await (await f.request("/sep6/info")).json()).toMatchObject({
    profile: {
      native_eligibility_required: true,
      first_time_onboarding: "sep24",
      onboarding_url: "http://localhost:8787/anchor",
    },
  });
});

it.each([
  ["underpayment", { amount: "19999999" }],
  ["overpayment", { amount: "20000001" }],
  [
    "late payment",
    { created_at: new Date(Date.now() + 3600_000).toISOString() },
  ],
])(
  "preserves %s as operator recovery without funding or guessing a refund",
  async (_name, change) => {
    const f = fixture();
    const order = await f.begin("withdraw");
    const quote = z
      .object({ quote: z.object({ id: z.string() }) })
      .parse(
        await (await order.action("quote", { sell_amount: "2.0000000" })).json()
      ).quote;
    await order.action("accept", {
      quote_id: quote.id,
      bank_destination: "demo:sample",
    });
    await order.action("proof", {
      proof: Buffer.alloc(10240).toString("hex"),
      public_inputs: Buffer.alloc(13 * 32).toString("hex"),
    });
    const ready = (await order.get()).transaction;
    f.payments.push({
      operation_id: "501",
      paging_token: "501",
      transaction_hash: "56".repeat(32),
      from: f.wallet,
      to: provider,
      asset: `stellar:${f.cfg.usdcCode}:${f.cfg.usdcIssuer}`,
      amount: "20000000",
      memo_type: "hash",
      memo: ready.withdraw_memo,
      created_at: new Date().toISOString(),
      ...change,
    });
    await f.tick();
    f.restart();
    await f.tick();
    const state = (await order.get()).transaction;
    expect(state.recovery_required).toBe(true);
    expect(state.status).toBe("error");
    expect(state.actions.some((action) => action.kind === "fund")).toBe(false);
    expect((await order.action("mock-bank")).status).toBe(409);
    expect((await order.action("refund")).status).toBe(409);
  }
);

it("keeps an unknown native transaction pending across restart and resumes its exact hash", async () => {
  const f = fixture();
  const order = await f.begin();
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "100.00" })).json()
    ).quote;
  await order.action("accept", { quote_id: quote.id });
  f.gateway.pending = true;
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const waiting = (await order.get()).transaction;
  expect(waiting.status).toBe("pending_stellar");
  expect(waiting.native.eligible).toBe(false);
  expect(waiting.ready_for_payment).toBe(false);
  const original = waiting.actions[0]!.transaction_hash;
  f.restart();
  f.gateway.pending = false;
  const ready = (await order.get()).transaction;
  expect(ready.status).toBe("pending_user_transfer_start");
  expect(
    ready.actions.filter((action) => action.kind === "eligibility")
  ).toEqual([
    {
      kind: "eligibility",
      transaction_hash: original,
      status: "success",
      ledger: 99,
    },
  ]);
});

it("binds the proof challenge to the Rust contract's XDR subject vector", async () => {
  const f = fixture("GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG");
  f.gateway.expectedSubject =
    "17b547bbde39190c081d69d7046b8b694ad6a3ff92a02cf267d80e058a9fe986";
  const order = await f.begin();
  const response = await order.action("proof-request");
  expect(response.status).toBe(200);
  expect(
    z.object({ custom_data: z.string() }).parse(await response.json())
      .custom_data
  ).toBe("34".repeat(32));
});

it("allows a refund after payout authorization failed without authorizing during refund reconciliation", async () => {
  const f = fixture();
  const order = await f.begin("withdraw");
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "2.0000000" })).json()
    ).quote;
  await order.action("accept", {
    quote_id: quote.id,
    bank_destination: "demo:sample",
  });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const ready = (await order.get()).transaction;
  f.payments.push({
    operation_id: "501",
    paging_token: "501",
    transaction_hash: "56".repeat(32),
    from: f.wallet,
    to: provider,
    asset: `stellar:${f.cfg.usdcCode}:${f.cfg.usdcIssuer}`,
    amount: "20000000",
    memo_type: "hash",
    memo: ready.withdraw_memo,
    created_at: new Date().toISOString(),
  });
  await f.tick();
  f.gateway.rejectAuthorization = true;
  expect((await order.action("mock-bank")).status).toBe(422);
  f.gateway.rejectAuthorization = false;
  const response = await order.action("refund");
  expect(response.status).toBe(200);
  const state = ((await response.json()) as { transaction: SepAnchorView })
    .transaction;
  expect(state.status).toBe("refunded");
  expect(state.payout_authorized).toBe(false);
  expect(state.external_transaction_id).toBeNull();
});

it("does not let third-party dust freeze an owned exact withdrawal or hide its completed result", async () => {
  const f = fixture();
  const order = await f.begin("withdraw");
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "2.0000000" })).json()
    ).quote;
  await order.action("accept", {
    quote_id: quote.id,
    bank_destination: "demo:sample",
  });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const ready = (await order.get()).transaction;
  const payment = {
    operation_id: "501",
    paging_token: "501",
    transaction_hash: "56".repeat(32),
    from: f.wallet,
    to: provider,
    asset: `stellar:${f.cfg.usdcCode}:${f.cfg.usdcIssuer}`,
    amount: "20000000",
    memo_type: "hash",
    memo: ready.withdraw_memo,
    created_at: new Date().toISOString(),
  };
  f.payments.push(
    {
      ...payment,
      operation_id: "500",
      paging_token: "500",
      transaction_hash: "54".repeat(32),
      from: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey(),
      amount: "1",
    },
    payment
  );
  await f.tick();
  expect((await order.get()).transaction.escrowed).toBe(true);
  expect((await order.action("mock-bank")).status).toBe(200);
  f.payments.push({
    ...payment,
    operation_id: "502",
    paging_token: "502",
    transaction_hash: "58".repeat(32),
  });
  await f.tick();
  f.restart();
  const completed = (await order.get()).transaction;
  expect(completed.status).toBe("completed");
  expect(completed.stellar_transaction_id).toBe("56".repeat(32));
});

it("removes send instructions immediately after a confirmed incoming payment while custody is pending", async () => {
  const f = fixture();
  const order = await f.begin("withdraw");
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "2.0000000" })).json()
    ).quote;
  await order.action("accept", {
    quote_id: quote.id,
    bank_destination: "demo:sample",
  });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const ready = (await order.get()).transaction;
  f.payments.push({
    operation_id: "501",
    paging_token: "501",
    transaction_hash: "56".repeat(32),
    from: f.wallet,
    to: provider,
    asset: `stellar:${f.cfg.usdcCode}:${f.cfg.usdcIssuer}`,
    amount: "20000000",
    memo_type: "hash",
    memo: ready.withdraw_memo,
    created_at: new Date().toISOString(),
  });
  f.gateway.pending = true;
  await f.tick();
  const pending = (await order.get()).transaction;
  expect(pending.ready_for_payment).toBe(false);
  expect(pending.withdraw_anchor_account).toBeNull();
  expect(pending.withdraw_memo).toBeNull();
  expect(pending.status).toBe("pending_stellar");
  expect(pending.stellar_transaction_id).toBe("56".repeat(32));
});

it("waits for the exact token trustline before accepting a simulated bank deposit", async () => {
  const f = fixture();
  f.gateway.recipientState = "missing_trustline";
  const order = await f.begin();
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "100.00" })).json()
    ).quote;
  await order.action("accept", { quote_id: quote.id });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  const waiting = (await order.get()).transaction;
  expect(waiting.status).toBe("pending_trust");
  expect(waiting.ready_for_payment).toBe(false);
  expect((await order.action("mock-bank")).status).toBe(409);
  expect((await order.get()).transaction.external_transaction_id).toBeNull();
  f.gateway.recipientState = "ready";
  expect((await order.get()).transaction.ready_for_payment).toBe(true);
  expect((await order.action("mock-bank")).status).toBe(200);
  expect((await order.get()).transaction.status).toBe("completed");
});

it.each([
  "missing_account",
  "missing_trustline",
  "unauthorized",
  "insufficient_limit",
] as const)(
  "withholds withdrawal instructions when the provider is %s",
  async (state) => {
    const f = fixture();
    const order = await f.begin("withdraw");
    const quote = z
      .object({ quote: z.object({ id: z.string() }) })
      .parse(
        await (await order.action("quote", { sell_amount: "2.0000000" })).json()
      ).quote;
    await order.action("accept", {
      quote_id: quote.id,
      bank_destination: "demo:capacity",
    });
    f.gateway.providerState = state;
    expect(
      (
        await order.action("proof", {
          proof: Buffer.alloc(10240).toString("hex"),
          public_inputs: Buffer.alloc(13 * 32).toString("hex"),
        })
      ).status
    ).toBe(200);
    const held = (await order.get()).transaction;
    expect(held.native.eligible).toBe(true);
    expect(held.ready_for_payment).toBe(false);
    expect(held.status).toBe("pending_anchor");
    expect(held.withdraw_anchor_account).toBeNull();
    expect(held.withdraw_memo).toBeNull();
    expect(held.message).toContain("Do not send tokens");
    f.gateway.providerState = "ready";
    const ready = (await order.get()).transaction;
    expect(ready.id).toBe(held.id);
    expect(ready.quote_id).toBe(quote.id);
    expect(ready.ready_for_payment).toBe(true);
    expect(ready.withdraw_anchor_account).toBe(provider);
    expect(ready.amount_in).toBe("2.0000000");
  }
);

it("interprets a quote-bound SEP-24 deposit amount as the source TRY amount", async () => {
  const f = fixture();
  const first = await f.begin();
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await first.action("quote", { sell_amount: "100.00" })).json()
    ).quote;
  const order = await f.begin("deposit", {
    amount: "100.00",
    quote_id: quote.id,
    source_asset: "iso4217:TRY",
  });
  const response = await order.action("accept", { quote_id: quote.id });
  expect(response.status).toBe(200);
  const transaction = (
    (await response.json()) as { transaction: SepAnchorView }
  ).transaction;
  expect(transaction.amount_in).toBe("100.00");
  expect(transaction.amount_out).toBe("2.4875621");
});

it("keeps reconciling previously requested settlement while the independent payment feed is unavailable", async () => {
  const f = fixture();
  const order = await f.begin();
  const quote = z
    .object({ quote: z.object({ id: z.string() }) })
    .parse(
      await (await order.action("quote", { sell_amount: "100.00" })).json()
    ).quote;
  await order.action("accept", { quote_id: quote.id });
  await order.action("proof", {
    proof: Buffer.alloc(10240).toString("hex"),
    public_inputs: Buffer.alloc(13 * 32).toString("hex"),
  });
  f.gateway.pending = true;
  expect((await order.action("mock-bank")).status).toBe(200);
  f.gateway.pending = false;
  f.gateway.ingressUnavailable = true;
  await expect(f.tick()).resolves.toBeUndefined();
  expect((await order.get()).transaction.status).toBe("completed");
});
