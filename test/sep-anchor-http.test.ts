import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
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
import { sep38Routes } from "../src/routes/sep38.js";
import type { SepAnchorGateway } from "../src/sep-anchor-types.js";
import { createApp } from "../src/app.js";
import { createOfacPrecheck, type OfacPrecheck } from "../src/ofac-precheck.js";

const databases: DB[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

function fixture(
  options: {
    fullApp?: boolean;
    ofacEnabled?: boolean;
    ofac?: OfacPrecheck;
  } = {}
) {
  let nativeUnavailable = false;
  const cfg = {
    ...config,
    publicUrl: "http://localhost:8787",
    anchorMode: "zkpassport" as const,
    stellarMode: "fake" as const,
    rateSource: "static" as const,
    staticUsdTry: "40.00",
    anchorGateAllowedWallets: [],
    anchorGateContract: "",
    anchorGateOfacEnabled: options.ofacEnabled ?? false,
  };
  const db = openDb(":memory:");
  databases.push(db);
  const deps: Deps = {
    cfg,
    db,
    stellar: createFakeGateway(cfg),
    rates: createRateService(cfg),
    log: createLogger(true),
    ofac: options.ofac,
  };
  const gateway: SepAnchorGateway = {
    async configuration() {
      if (nativeUnavailable) throw new Error("Synthetic native outage");
      return {
        contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
        token: new Asset(cfg.usdcCode, cfg.usdcIssuer).contractId(
          Networks.TESTNET
        ),
        provider: Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey(),
        bank_notary: Keypair.fromRawEd25519Seed(
          Buffer.alloc(32, 8)
        ).publicKey(),
        domain: "localhost",
        scope: "sep-anchor-test",
        policy_hash: "12".repeat(32),
        policy: {
          min_age: 18,
          allowed_nationalities: ["ZKR"],
          allowed_issuers: ["ZKR"],
          mock_only: true,
          max_proof_age: 600,
          verifier_vk_hash:
            "03dbb84b656cdf3b9f93d809c530b4c3901fe5be6f56c424a04ae827ebe45a08",
        },
        proof_bytes: 10240,
        external_inputs: 13,
        max_order_lifetime: 1800,
        policy_valid_until: Math.floor(Date.now() / 1000) + 3600,
        max_amount: "1000000000",
        max_try_minor: "1000000",
        ledger_time: Math.floor(Date.now() / 1000),
      };
    },
    async challenge() {
      return "34".repeat(32);
    },
    async eligibility() {
      return null;
    },
    async order() {
      return null;
    },
    async prepare() {
      throw new Error("No chain mutation expected in this scenario");
    },
    async submit() {
      return { status: "pending", ledger: null };
    },
    async transaction() {
      return { status: "pending", ledger: null };
    },
  };
  const sep = createSepContext(deps);
  const engine = createSepAnchor(deps, gateway);
  const app = options.fullApp
    ? createApp({ ...deps, sepAnchorGateway: gateway }, sep)
    : new Hono().route("/", createSepAnchorRoutes(deps, sep, engine));
  if (!options.fullApp) app.route("/", sep38Routes(deps, sep));
  const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  function auth(sub = wallet, overrides: Record<string, unknown> = {}) {
    const now = Math.floor(Date.now() / 1000);
    return {
      Authorization: `Bearer ${signJwt({ iss: `${cfg.publicUrl}/auth`, sub, iat: now, exp: now + 600, ...overrides }, sep.jwtSecret)}`,
    };
  }
  const request = (path: string, init?: RequestInit) =>
    app.request(`${cfg.publicUrl}${path}`, init);
  return {
    request,
    auth,
    wallet,
    cfg,
    deps,
    nativeDown() {
      nativeUnavailable = true;
    },
  };
}

const syntheticAddressFeed = `<?xml version="1.0"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
<publshInformation><Publish_Date>09/18/2026</Publish_Date><Record_Count>1</Record_Count></publshInformation>
<sdnEntry><uid>1</uid><lastName>Synthetic fixture</lastName><idList><id><uid>2</uid>
<idType>Digital Currency Address - TEST</idType><idNumber>synthetic-non-stellar-address</idNumber>
</id></idList></sdnEntry></sdnList>`;

it("admits an unlisted wallet through the full SEP-only deployment after official-source screening", async () => {
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
    if (
      String(input) !==
      "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"
    )
      throw new Error("Unexpected external endpoint");
    return new Response(syntheticAddressFeed);
  });
  const { request, auth } = fixture({ fullApp: true, ofacEnabled: true });
  expect(await (await request("/anchor-gate/info")).json()).toMatchObject({
    enabled: false,
  });
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"asset_code":"USDC"}',
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    type: "interactive_customer_info_needed",
  });
});

it("retains an injected address-screening service instead of replacing its listed-wallet decision", async () => {
  vi.stubGlobal("fetch", async () => new Response(syntheticAddressFeed));
  const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
  const ofac = createOfacPrecheck({
    fetch: async () =>
      new Response(
        syntheticAddressFeed.replace("synthetic-non-stellar-address", wallet)
      ),
  });
  const { request, auth } = fixture({ fullApp: true, ofacEnabled: true, ofac });
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"asset_code":"USDC"}',
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ code: "ofac_precheck_match" });
});

it("keeps new SEP-only initiation closed when the official address feed is unavailable", async () => {
  vi.stubGlobal(
    "fetch",
    async () => new Response("Unavailable", { status: 503 })
  );
  const { request, auth } = fixture({ fullApp: true, ofacEnabled: true });
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"asset_code":"USDC"}',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "ofac_precheck_unavailable",
  });
});

it("requires a valid SEP-10 bearer before opening an interactive order", async () => {
  const { request } = fixture();
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_code: "USDC" }),
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    type: "authentication_required",
    error: "A valid SEP-10 bearer session is required.",
  });
});

it("opens one authenticated hosted session without leaking a bearer into history", async () => {
  const { request, auth, wallet } = fixture();
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: {
      ...auth(),
      "Content-Type": "application/json",
      Origin: "https://wallet.example",
    },
    body: JSON.stringify({ asset_code: "USDC", account: wallet }),
  });
  expect(response.status).toBe(200);
  const created = z
    .object({ type: z.string(), id: z.string(), url: z.string() })
    .parse(await response.json());
  expect(created.type).toBe("interactive_customer_info_needed");
  expect(created.id).toMatch(/^[a-f0-9]{64}$/);
  expect(created.url).not.toContain("eyJ");
  const url = new URL(created.url);
  const opening = await request(url.pathname + url.search);
  expect(opening.status).toBe(303);
  expect(opening.headers.get("Location")).toBe(
    `/sep24/interactive/${created.id}`
  );
  const cookie = opening.headers.get("Set-Cookie")!;
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain(`Path=/sep24/interactive/${created.id}`);
  expect((await request(url.pathname + url.search)).status).toBe(403);
  const state = await request(`/sep24/interactive/${created.id}/state`, {
    headers: { Cookie: cookie.split(";")[0]! },
  });
  expect(state.status).toBe(200);
  const displayed = z
    .object({
      transaction: z.object({
        wallet: z.string(),
        status: z.string(),
        more_info_url: z.string(),
      }),
      csrf_token: z.string(),
    })
    .parse(await state.json());
  expect(displayed.transaction.wallet).toBe(wallet);
  expect(displayed.transaction.status).toBe("incomplete");
  expect(displayed.transaction.more_info_url).not.toContain("token=");
  expect(displayed.csrf_token).toMatch(/^[a-f0-9]{64}$/);
  const noBearer = await request(`/sep24/transaction?id=${created.id}`, {
    headers: { Cookie: cookie.split(";")[0]! },
  });
  expect(noBearer.status).toBe(403);
});

it("offers SEP-24 and exchange-only SEP-6 without exposing another wallet's order", async () => {
  const { request, auth } = fixture();
  const info = await (await request("/sep6/info")).json();
  expect(info).toMatchObject({
    deposit: { USDC: { enabled: false } },
    withdraw: { USDC: { enabled: false } },
    "deposit-exchange": { USDC: { enabled: true } },
    "withdraw-exchange": { USDC: { enabled: true } },
  });
  const result = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"asset_code":"USDC"}',
  });
  const created = z.object({ id: z.string() }).parse(await result.json());
  const stranger = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
  expect(
    (
      await request(`/sep24/transaction?id=${created.id}`, {
        headers: auth(stranger),
      })
    ).status
  ).toBe(404);
  const history = await request("/sep24/transactions?asset_code=USDC", {
    headers: auth(),
  });
  expect(history.status).toBe(200);
  const text = await history.text();
  expect(text).toContain(created.id);
  expect(text).not.toContain("token=");
  expect(
    (await request("/sep24/transaction?id=", { headers: auth() })).status
  ).toBe(400);
});

it.each(["sep6", "sep24"])(
  "treats unknown opaque %s transaction IDs as not found without relaxing request or session validation",
  async (protocol) => {
    const { request, auth } = fixture();
    const unknown = "f3087884-9ac1-4a6d-a6bc-435e4da0cad4";
    const response = await request(`/${protocol}/transaction?id=${unknown}`, {
      headers: auth(),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Transaction not found.",
      code: "transaction_not_found",
    });
    for (const query of [
      "",
      "?id=",
      `?id=${"a".repeat(129)}`,
      `?id=${unknown}&stellar_transaction_id=${"a".repeat(64)}`,
      `?id=${unknown}&id=another-opaque-id`,
    ])
      expect(
        (await request(`/${protocol}/transaction${query}`, { headers: auth() }))
          .status
      ).toBe(400);
    const initiated = await request("/sep24/transactions/deposit/interactive", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: '{"asset_code":"USDC"}',
    });
    const created = z.object({ id: z.string() }).parse(await initiated.json());
    const foreign = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
    expect(
      (
        await request(`/${protocol}/transaction?id=${created.id}`, {
          headers: auth(foreign),
        })
      ).status
    ).toBe(404);
    expect((await request(`/sep24/interactive/${unknown}`)).status).toBe(400);
  }
);

it("does not advertise enabled transfers when native configuration is unavailable", async () => {
  const { request, nativeDown } = fixture();
  expect((await request("/sep24/info")).status).toBe(200);
  nativeDown();
  const response = await request("/sep24/info");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error:
      "Native policy configuration is unavailable. New transfers are disabled.",
  });
  expect((await request("/sep6/info")).status).toBe(503);
});

it("returns a client error for excess TRY precision without losing the hosted order", async () => {
  const { request, auth, cfg } = fixture();
  const started = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"asset_code":"USDC"}',
  });
  const intent = z
    .object({ id: z.string(), url: z.string() })
    .parse(await started.json());
  const url = new URL(intent.url);
  const opened = await request(url.pathname + url.search);
  const cookie = opened.headers.get("Set-Cookie")!.split(";")[0]!;
  const path = `/sep24/interactive/${intent.id}`;
  const state = z
    .object({ csrf_token: z.string() })
    .parse(
      await (
        await request(`${path}/state`, { headers: { Cookie: cookie } })
      ).json()
    );
  const invalid = await request(`${path}/quote`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: cfg.publicUrl,
      "X-CSRF-Token": state.csrf_token,
      "Content-Type": "application/json",
    },
    body: '{"sell_amount":"100.001"}',
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ code: "invalid_amount" });
  const after = await request(`${path}/state`, { headers: { Cookie: cookie } });
  expect(await after.json()).toMatchObject({
    transaction: { id: intent.id, status: "incomplete", quote_id: null },
  });
});

it("rejects wrong-issuer, future-issued, expired and shared-account bearer sessions", async () => {
  const { request, auth, wallet } = fixture();
  const now = Math.floor(Date.now() / 1000);
  for (const headers of [
    auth(wallet, { iss: "https://attacker.example/auth" }),
    auth(wallet, { iat: now + 100 }),
    auth(wallet, { exp: now }),
    auth(`${wallet}:42`),
  ]) {
    const response = await request("/sep24/transactions/deposit/interactive", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: '{"asset_code":"USDC"}',
    });
    expect([400, 403]).toContain(response.status);
  }
});

it("protects hosted mutations from cross-origin requests and keeps expired orders resumable", async () => {
  const { request, auth, cfg } = fixture();
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"asset_code":"USDC"}',
  });
  const created = z
    .object({ id: z.string(), url: z.string() })
    .parse(await response.json());
  const start = new URL(created.url);
  const opening = await request(start.pathname + start.search);
  const cookie = opening.headers.get("Set-Cookie")!.split(";")[0]!;
  const path = `/sep24/interactive/${created.id}`;
  const state = z
    .object({ csrf_token: z.string() })
    .parse(
      await (
        await request(`${path}/state`, { headers: { Cookie: cookie } })
      ).json()
    );
  for (const extra of [
    { Origin: "https://attacker.example", "X-CSRF-Token": state.csrf_token },
    { Origin: cfg.publicUrl, "X-CSRF-Token": "00".repeat(32) },
  ]) {
    const rejected = await request(`${path}/quote`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", ...extra },
      body: '{"sell_amount":"100.00"}',
    });
    expect(rejected.status).toBe(403);
  }
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 1801000);
  expect(
    (await request(`${path}/state`, { headers: { Cookie: cookie } })).status
  ).toBe(403);
  const current = z
    .object({ transaction: z.object({ more_info_url: z.string() }) })
    .parse(
      await (
        await request(`/sep24/transaction?id=${created.id}`, {
          headers: auth(),
        })
      ).json()
    );
  const another = z
    .object({ transaction: z.object({ more_info_url: z.string() }) })
    .parse(
      await (
        await request(`/sep24/transaction?id=${created.id}`, {
          headers: auth(),
        })
      ).json()
    );
  expect(another.transaction.more_info_url).toBe(
    current.transaction.more_info_url
  );
  const resume = new URL(current.transaction.more_info_url);
  expect((await request(resume.pathname + resume.search)).status).toBe(303);
  expect((await request(resume.pathname + resume.search)).status).toBe(403);
});

it("rejects unsupported callbacks and oversized proof requests with SEP error bodies", async () => {
  const { request, auth } = fixture();
  const callback = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      asset_code: "USDC",
      callback: "https://attacker.example",
    }),
  });
  expect(callback.status).toBe(400);
  expect(await callback.json()).toMatchObject({ code: "callback_unsupported" });
  const oversized = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ asset_code: "USDC", padding: "a".repeat(70000) }),
  });
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({
    error: "Request body exceeds 64 KiB.",
  });
});

it("rejects unsupported off-chain assets and foreign customer identities before creating an intent", async () => {
  const { request, auth } = fixture();
  for (const [direction, input] of [
    ["deposit", { source_asset: "iso4217:EUR" }],
    ["deposit", { destination_asset: "iso4217:TRY" }],
    ["withdraw", { destination_asset: "iso4217:EUR" }],
    ["withdraw", { source_asset: "iso4217:TRY" }],
    ["deposit", { customer_id: "another-customer" }],
  ] as const) {
    const response = await request(
      `/sep24/transactions/${direction}/interactive`,
      {
        method: "POST",
        headers: { ...auth(), "Content-Type": "application/json" },
        body: JSON.stringify({ asset_code: "USDC", ...input }),
      }
    );
    expect(response.status).toBe(400);
  }
  expect(
    await (
      await request("/sep24/transactions?asset_code=USDC", { headers: auth() })
    ).json()
  ).toEqual({ transactions: [] });
});

it("keeps SEP-12 customer types and transaction ownership explicit without auto-accepting registration", async () => {
  const { request, auth } = fixture();
  const registration = await request("/sep12/customer", {
    method: "PUT",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: '{"type":"sep6"}',
  });
  expect(registration.status).toBe(200);
  const customer = z
    .object({ id: z.string() })
    .parse(await registration.json());
  expect(
    await (
      await request(`/sep12/customer?id=${customer.id}&type=sep6`, {
        headers: auth(),
      })
    ).json()
  ).toMatchObject({ status: "NEEDS_INFO" });
  expect(
    (await request("/sep12/customer?type=unsupported", { headers: auth() }))
      .status
  ).toBe(400);
  expect(
    (
      await request(`/sep12/customer?transaction_id=${"a".repeat(64)}`, {
        headers: auth(),
      })
    ).status
  ).toBe(400);
  expect(
    (
      await request(
        `/sep12/customer?transaction_id=${"a".repeat(64)}&type=sep6`,
        { headers: auth() }
      )
    ).status
  ).toBe(404);
});

it("accepts a precise numeric SEP-24 amount without rounding extra decimal places", async () => {
  const { request, auth } = fixture();
  const create = (value: number) =>
    request("/sep24/transactions/deposit/interactive", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        asset_code: "USDC",
        source_asset: "iso4217:TRY",
        amount: value,
      }),
    });
  expect((await create(100.01)).status).toBe(200);
  expect((await create(100.001)).status).toBe(400);
  expect((await create(1.00000001)).status).toBe(400);
});

it("rejects a supplied SEP-38 quote conflict at SEP-24 initiation", async () => {
  const { request, auth, cfg } = fixture();
  const quoted = await request("/sep38/quote", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      sell_asset: "iso4217:TRY",
      buy_asset: `stellar:USDC:${cfg.usdcIssuer}`,
      sell_amount: "100.00",
      context: "sep24",
    }),
  });
  expect(quoted.status).toBe(201);
  const quote = z.object({ id: z.string() }).parse(await quoted.json());
  for (const amount of ["99.00", "2.4875621"]) {
    const response = await request("/sep24/transactions/deposit/interactive", {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ asset_code: "USDC", quote_id: quote.id, amount }),
    });
    expect(response.status).toBe(400);
  }
  const response = await request("/sep24/transactions/deposit/interactive", {
    method: "POST",
    headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({
      asset_code: "USDC",
      quote_id: quote.id,
      amount: "100.00",
    }),
  });
  expect(response.status).toBe(200);
});
