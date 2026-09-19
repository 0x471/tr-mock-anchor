import { afterEach, describe, expect, it, vi } from "vitest";
import { Horizon, Keypair } from "@stellar/stellar-sdk";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import {
  assertEconomicActionsEnabled,
  economicActionsEnabled,
  POLICY_PENDING_CODE,
  POLICY_PENDING_MESSAGE,
  type AnchorMode,
} from "../src/anchor-policy.js";
import { createLogger, type Deps } from "../src/context.js";
import { kvGet, kvSet, openDb, tx, type DB } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createFakeGateway, createLiveGateway } from "../src/stellar.js";
import { createWorkers } from "../src/workers.js";
import { createSepContext } from "../src/sepauth.js";
import { ensureSepCustomer } from "../src/core/sep.js";
import { createOfframp, createOnramp } from "../src/core/orders.js";
import { applyLedger } from "../src/core/ledger.js";
import { signJwt } from "../src/jwt.js";

const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
const otherWallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2));
const databases: DB[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture(anchorMode: AnchorMode = "zkpassport") {
  const cfg = {
    ...config,
    anchorMode,
    publicUrl: "http://localhost:8787",
    stellarMode: "fake" as const,
    treasurySecret: "",
    rateSource: "static" as const,
    staticUsdTry: "40.00",
    minOnrampTry: "0",
    maxOnrampTry: "",
    minOfframpUsdc: "0",
    dbPath: ":memory:",
  };
  const db = openDb(":memory:");
  databases.push(db);
  const stellar = createFakeGateway(cfg);
  const deps: Deps = {
    cfg,
    db,
    stellar,
    rates: createRateService(cfg),
    log: createLogger(true),
  };
  const sep = createSepContext(deps);
  const app = createApp(deps, sep);
  const auth = (sub = wallet.publicKey()) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      authorization: `Bearer ${signJwt({ iss: `${cfg.publicUrl}/auth`, sub, iat: now, exp: now + 60 }, sep.jwtSecret)}`,
    };
  };
  return { cfg, db, stellar, deps, sep, app, auth };
}

function economicSnapshot(db: DB) {
  return [
    "onramps",
    "offramps",
    "payouts",
    "ledger",
    "bank_transfers",
    "sep_transactions",
    "quotes",
    "unmatched_deposits",
    "events",
    "kv",
  ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

const rate = { rateMicro: 40_000000n, midMicro: 40_000000n, quoteId: null };

describe("strict legacy-route anchor policy", () => {
  it("fails closed by default and requires explicit legacy mode", () => {
    expect(economicActionsEnabled({})).toBe(false);
    expect(economicActionsEnabled({ anchorMode: "zkpassport" })).toBe(false);
    expect(() => assertEconomicActionsEnabled({})).toThrowError(
      /Legacy economic routes are disabled/
    );
    expect(() =>
      assertEconomicActionsEnabled({ anchorMode: "zkpassport" })
    ).toThrowError(/separately configured proof-gated vault/);
    expect(economicActionsEnabled({ anchorMode: "legacy" })).toBe(true);
    expect(() =>
      assertEconomicActionsEnabled({ anchorMode: "legacy" })
    ).not.toThrow();
  });

  it("creates pending customers unless legacy mode is explicitly requested", () => {
    const { db } = fixture();
    expect(ensureSepCustomer(db, wallet.publicKey()).kyc_status).toBe(
      "pending"
    );
    expect(
      ensureSepCustomer(db, otherWallet.publicKey(), "legacy").kyc_status
    ).toBe("approved");
  });

  it("blocks all four SEP-6 create routes before economic mutations", async () => {
    const { app, auth, db } = fixture();
    const before = economicSnapshot(db);
    for (const path of [
      "/sep6/deposit?asset_code=USDC&amount=100.00",
      "/sep6/deposit-exchange?destination_asset=USDC&source_asset=iso4217:TRY&amount=100.00",
      "/sep6/withdraw?asset_code=USDC&amount=1.0000000",
      "/sep6/withdraw-exchange?source_asset=USDC&destination_asset=iso4217:TRY&amount=1.0000000",
    ]) {
      const response = await app.request(path, { headers: auth() });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: POLICY_PENDING_CODE },
      });
    }
    expect(economicSnapshot(db)).toEqual(before);
    const infoResponse = await app.request("/sep6/info");
    const info = (await infoResponse.json()) as Record<
      string,
      { USDC: { enabled: boolean } }
    >;
    for (const kind of [
      "deposit",
      "deposit-exchange",
      "withdraw",
      "withdraw-exchange",
    ]) {
      expect(info[kind]!.USDC.enabled).toBe(false);
    }
  });

  it("blocks the unauthenticated bank helper for an existing legacy deposit", async () => {
    const { app, auth, db, deps, sep } = fixture("legacy");
    const created = await app.request(
      "/sep6/deposit?asset_code=USDC&amount=100.00",
      { headers: auth() }
    );
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    const strictApp = createApp(
      { ...deps, cfg: { ...deps.cfg, anchorMode: "zkpassport" } },
      sep
    );
    const before = economicSnapshot(db);
    const response = await strictApp.request(
      `/sep6/tx/${id}/simulate-bank-transfer`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"amount":"100.00"}',
      }
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: POLICY_PENDING_CODE },
    });
    expect(economicSnapshot(db)).toEqual(before);
    const page = await strictApp.request(`/sep6/tx/${id}`);
    const html = await page.text();
    expect(html).toContain("Transfers disabled");
    expect(html).not.toContain('method="post"');
  });

  it.each([
    "/sep6/deposit?asset_code=USDC&amount=100.00&memo=42&memo_type=id",
    "/sep6/withdraw?asset_code=USDC&amount=1.0000000",
  ])(
    "holds legacy transaction responses without payment instructions: %s",
    async (path) => {
      const { app, auth, db, deps, sep } = fixture("legacy");
      const created = await app.request(path, { headers: auth() });
      expect(created.status).toBe(200);
      const { id } = (await created.json()) as { id: string };
      const strictApp = createApp(
        { ...deps, cfg: { ...deps.cfg, anchorMode: "zkpassport" } },
        sep
      );
      for (const status of [
        "pending_user_transfer_start",
        "pending_anchor",
        "pending_stellar",
        "pending_trust",
        "pending_external",
        "incomplete",
      ]) {
        db.prepare(
          "UPDATE sep_transactions SET status_override = ? WHERE id = ?"
        ).run(status, id);
        const before = economicSnapshot(db);
        for (const endpoint of [
          `/sep6/transaction?id=${id}`,
          "/sep6/transactions?asset_code=USDC",
        ]) {
          const response = await strictApp.request(endpoint, {
            headers: auth(),
          });
          expect(response.status).toBe(200);
          const body = (await response.json()) as {
            transaction?: Record<string, unknown>;
            transactions?: Record<string, unknown>[];
          };
          const result = body.transaction ?? body.transactions![0]!;
          expect(result).toMatchObject({
            status: "incomplete",
            message: POLICY_PENDING_MESSAGE,
            status_eta: null,
            user_action_required_by: null,
          });
          for (const field of [
            "instructions",
            "withdraw_anchor_account",
            "withdraw_memo",
            "withdraw_memo_type",
            "deposit_memo",
            "deposit_memo_type",
          ])
            expect(result[field]).toBeFalsy();
        }
        expect(economicSnapshot(db)).toEqual(before);
      }
      for (const status of ["completed", "error"]) {
        db.prepare(
          "UPDATE sep_transactions SET status_override = ?, message = ? WHERE id = ?"
        ).run(status, "Historical outcome", id);
        const legacy = await app.request(`/sep6/transaction?id=${id}`, {
          headers: auth(),
        });
        const strict = await strictApp.request(`/sep6/transaction?id=${id}`, {
          headers: auth(),
        });
        expect(await strict.json()).toEqual(await legacy.json());
      }
    }
  );

  it("blocks shared order constructors even for an approved legacy customer", () => {
    const { db, deps } = fixture();
    const customer = ensureSepCustomer(db, wallet.publicKey(), "legacy");
    const before = economicSnapshot(db);
    expect(() =>
      tx(db, () =>
        createOnramp(deps, customer, {
          kurus: 100_00n,
          rate,
          destination: wallet.publicKey(),
        })
      )
    ).toThrowError(/Legacy economic routes are disabled/);
    expect(() =>
      tx(db, () =>
        createOfframp(deps, customer, {
          expected: 1_0000000n,
          rate,
          autoPayout: true,
          payoutIban: customer.iban,
        })
      )
    ).toThrowError(/Legacy economic routes are disabled/);
    expect(economicSnapshot(db)).toEqual(before);
  });

  it("holds queued legacy orders without sends, attempts, refunds or cursor advancement", async () => {
    const { db, deps, sep, stellar } = fixture("legacy");
    const customer = ensureSepCustomer(db, wallet.publicKey(), "legacy");
    const { offramp } = tx(db, () => {
      applyLedger(db, customer.id, "TRY", 1_000_00n, "test_credit", "seed");
      createOnramp(deps, customer, {
        kurus: 100_00n,
        rate,
        destination: wallet.publicKey(),
      });
      return {
        offramp: createOfframp(deps, customer, {
          expected: 1_0000000n,
          rate,
          autoPayout: true,
          payoutIban: customer.iban,
        }),
      };
    });
    stellar.simulateIncoming({
      from: wallet.publicKey(),
      amount: "1.0000000",
      memoId: offramp.memo_id,
    });
    kvSet(db, "horizon_payments_cursor", "0");
    const send = vi.spyOn(stellar, "sendUsdc");
    const balance = vi.spyOn(stellar, "treasuryUsdcBalance");
    const incoming = vi.spyOn(stellar, "incomingUsdc");
    const strictDeps: Deps = {
      ...deps,
      cfg: { ...deps.cfg, anchorMode: "zkpassport" },
    };
    const workers = createWorkers(strictDeps, sep);
    const before = economicSnapshot(db);
    for (let tick = 0; tick < 7; tick++) {
      expect(await workers.settleOnrampsOnce()).toBe(0);
      expect(await workers.watchOfframpsOnce()).toBe(0);
    }
    expect(send).not.toHaveBeenCalled();
    expect(balance).not.toHaveBeenCalled();
    expect(incoming).not.toHaveBeenCalled();
    expect(stellar.sent).toEqual([]);
    expect(kvGet(db, "horizon_payments_cursor")).toBe("0");
    expect(economicSnapshot(db)).toEqual(before);
  });

  it("blocks fake-gateway payments and claimable fallback without changing balance", async () => {
    const { stellar } = fixture();
    const before = await stellar.treasuryUsdcBalance();
    const send = () =>
      stellar.sendUsdc({
        destination: wallet.publicKey(),
        amountStroops: 1_0000000n,
      });
    await expect(send()).rejects.toMatchObject({ code: POLICY_PENDING_CODE });
    stellar.markNoTrustline(wallet.publicKey());
    await expect(send()).rejects.toMatchObject({ code: POLICY_PENDING_CODE });
    await expect(
      stellar.sendUsdc({
        destination: wallet.publicKey(),
        amountStroops: 1_0000000n,
        allowClaimableBalance: false,
      })
    ).rejects.toMatchObject({ code: POLICY_PENDING_CODE });
    expect(stellar.sent).toEqual([]);
    expect(await stellar.treasuryUsdcBalance()).toBe(before);
  });

  it("blocks live-gateway payout before any destination lookup or submission", async () => {
    const { cfg } = fixture();
    const lookup = vi
      .spyOn(Horizon.Server.prototype, "loadAccount")
      .mockRejectedValue(new Error("unexpected network lookup"));
    const live = createLiveGateway({
      ...cfg,
      stellarMode: "live",
      treasurySecret: wallet.secret(),
    });
    await expect(
      live.sendUsdc({
        destination: otherWallet.publicKey(),
        amountStroops: 1_0000000n,
        allowClaimableBalance: true,
      })
    ).rejects.toMatchObject({ code: POLICY_PENDING_CODE });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never reports SEP-12 ACCEPTED in strict mode, including an old approved record", async () => {
    const { app, auth, db } = fixture();
    const customer = ensureSepCustomer(db, wallet.publicKey(), "legacy");
    const response = await app.request("/sep12/customer", {
      method: "PUT",
      headers: { ...auth(), "content-type": "application/json" },
      body: '{"first_name":"Test","email_address":"test@example.invalid"}',
    });
    expect(response.status).toBe(202);
    const result = await app.request(`/sep12/customer?id=${customer.id}`, {
      headers: auth(),
    });
    const text = await result.text();
    expect(result.status).toBe(200);
    expect(text).not.toContain("ACCEPTED");
    expect(JSON.parse(text)).toMatchObject({ status: "NEEDS_INFO" });
  });

  it("strict SEP-12 resolves only the exact authenticated account and memo", async () => {
    const { app, auth, db } = fixture();
    const ownSub = `${wallet.publicKey()}:1`;
    const me = ensureSepCustomer(db, ownSub);
    const otherMemo = ensureSepCustomer(db, `${wallet.publicKey()}:2`);
    const other = ensureSepCustomer(db, otherWallet.publicKey());
    const headers = { ...auth(ownSub), "content-type": "application/json" };
    const before = db.prepare("SELECT * FROM customers ORDER BY id").all();
    for (const query of [
      `id=${other.id}`,
      `id=${otherMemo.id}`,
      `account=${otherWallet.publicKey()}`,
      "memo=2",
    ]) {
      const response = await app.request(`/sep12/customer?${query}`, {
        headers,
      });
      expect(response.status).toBe(404);
    }
    for (const identity of [
      { id: other.id },
      { id: otherMemo.id },
      { account: otherWallet.publicKey() },
      { memo: "2" },
    ]) {
      const response = await app.request("/sep12/customer", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          ...identity,
          email_address: "wrong@example.invalid",
        }),
      });
      expect(response.status).toBe(404);
    }
    const deleted = await app.request(`/sep12/customer/${wallet.publicKey()}`, {
      method: "DELETE",
      headers,
      body: '{"memo":"2"}',
    });
    expect(deleted.status).toBe(404);
    expect(db.prepare("SELECT * FROM customers ORDER BY id").all()).toEqual(
      before
    );
    const own = await app.request("/sep12/customer", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        id: me.id,
        account: wallet.publicKey(),
        memo: "1",
      }),
    });
    expect(own.status).toBe(202);
    expect(ensureSepCustomer(db, ownSub).kyc_status).toBe("pending");
  });
});
