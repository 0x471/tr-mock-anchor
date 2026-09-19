import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { config } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb, type DB } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createFakeGateway } from "../src/stellar.js";
import { createSepContext } from "../src/sepauth.js";
import { POLICY_PENDING_MESSAGE } from "../src/anchor-policy.js";
import type { GateGateway } from "../src/anchor-gate-types.js";

async function unusedGatewayCall(): Promise<never> {
  throw new Error("Public presentation must not invoke the contract gateway.");
}

const configuredGate: GateGateway = {
  configuration: unusedGatewayCall,
  order: unusedGatewayCall,
  prepareCreate: unusedGatewayCall,
  prepareProof: unusedGatewayCall,
  prepareReceipt: unusedGatewayCall,
  prepareAuthorization: unusedGatewayCall,
  prepareSettlement: unusedGatewayCall,
  submit: unusedGatewayCall,
  transaction: unusedGatewayCall,
};

const databases: DB[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function fixture(anchorGate?: GateGateway) {
  const cfg = {
    ...config,
    anchorMode: "zkpassport" as const,
    publicUrl: "http://localhost:8787",
    stellarMode: "fake" as const,
    treasurySecret: "",
    rateSource: "static" as const,
    staticUsdTry: "40.00",
    dbPath: ":memory:",
    networkPassphrase: Networks.TESTNET,
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
  const sep = createSepContext(deps);
  return {
    deps,
    strict: createApp(deps, sep),
    legacy: createApp({ ...deps, cfg: { ...cfg, anchorMode: "legacy" } }, sep),
  };
}

describe("public diagnostic-mode presentation", () => {
  it("serves honest non-actionable strict pages while preserving legacy HTML", async () => {
    const { strict, legacy } = fixture();
    for (const [path, file] of [
      ["/", "index.html"],
      ["/sep", "sep.html"],
      ["/explorer", "explorer.html"],
      ["/guide", "guide.html"],
      ["/mainnet", "mainnet.html"],
    ]) {
      const response = await strict.request(path!);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(POLICY_PENDING_MESSAGE);
      expect(text).toContain('href="/zkpassport/info"');
      expect(text).toContain("Do not send funds");
      expect(text).not.toMatch(
        /<form|<script|auto-approved|bank_account_number|simulate-bank-transfer/i
      );
      expect(text).toMatch(/^[\x00-\x7f]*$/);
      const original = await legacy.request(path!);
      expect(await original.text()).toBe(
        readFileSync(join(process.env.PUBLIC_DIR ?? "public", file!), "utf8")
      );
    }
  });

  it("describes strict capabilities without requesting live rates", async () => {
    const { strict, legacy, deps } = fixture();
    const quote = vi.spyOn(deps.rates, "quote");
    for (const path of ["/llms.txt", "/llms-full.txt", "/sitemap.md"]) {
      const response = await strict.request(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(POLICY_PENDING_MESSAGE);
      expect(text).toContain("/zkpassport/info");
      expect(text).toContain("Do not send funds");
      expect(text).not.toMatch(
        /auto-approved|bank_account_number|simulate-bank-transfer|pays real testnet/i
      );
      expect(text).toMatch(/^[\x00-\x7f]*$/);
    }
    expect(quote).not.toHaveBeenCalled();
    const strictDiscovery = await strict.request("/.well-known/stellar.toml");
    const legacyDiscovery = await legacy.request("/.well-known/stellar.toml");
    expect(await strictDiscovery.text()).toBe(await legacyDiscovery.text());
    const legacyReference = await legacy.request("/llms-full.txt");
    expect(await legacyReference.text()).toContain(
      "wallet user is auto-approved"
    );
  });

  it("reports strict health as diagnostic without implying payout authorization", async () => {
    const { strict, legacy } = fixture();
    const strictResponse = await strict.request("/health");
    expect(await strictResponse.json()).toMatchObject({
      ok: true,
      anchor_mode: "zkpassport",
      diagnostic_only: true,
      payout_authorized: false,
      policy_message: POLICY_PENDING_MESSAGE,
    });
    const legacyResponse = await legacy.request("/health");
    expect(await legacyResponse.json()).toMatchObject({
      ok: true,
      anchor_mode: "legacy",
      diagnostic_only: false,
      payout_authorized: true,
      policy_message:
        "Legacy sandbox payout processing is enabled, subject to normal per-order checks. No ZKPassport eligibility policy is enforced.",
    });
  });

  it("reports a configured Testnet gate without granting global payout authorization", async () => {
    const { strict, deps } = fixture(configuredGate);
    const response = await strict.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      anchor_mode: "zkpassport",
      diagnostic_only: false,
      native_gate_configured: true,
      payout_authorized: false,
      native_gate: {
        app_url: "http://localhost:8787/anchor-gate",
        info_url: "http://localhost:8787/anchor-gate/info",
      },
    });
    const wrongNetworkDeps = {
      ...deps,
      cfg: { ...deps.cfg, networkPassphrase: Networks.PUBLIC },
    };
    const wrongNetwork = createApp(
      wrongNetworkDeps,
      createSepContext(wrongNetworkDeps)
    );
    expect(await (await wrongNetwork.request("/health")).json()).toMatchObject({
      diagnostic_only: true,
      native_gate_configured: false,
      payout_authorized: false,
      native_gate: null,
    });
  });

  it("links configured native deposit and withdrawal flows without reopening legacy routes", async () => {
    const { strict } = fixture(configuredGate);
    for (const path of ["/", "/sep", "/explorer", "/guide", "/mainnet"]) {
      const response = await strict.request(path);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('href="/anchor-gate"');
      expect(text).toContain('href="/anchor-gate/info"');
      expect(text).toContain("Legacy economic routes remain disabled");
      expect(text).toContain("each order still requires its own proof");
      expect(text).toContain("Use test assets only");
      expect(text).not.toContain(
        "Deposits, withdrawals, bank simulation, and payout processing are disabled"
      );
      expect(text).not.toMatch(/auto-approved|<form|<script/i);
      expect(text).toMatch(/^[\x00-\x7f]*$/);
    }
    for (const path of ["/llms.txt", "/llms-full.txt", "/sitemap.md"]) {
      const text = await (await strict.request(path)).text();
      expect(text).toContain("http://localhost:8787/anchor-gate");
      expect(text).toContain("http://localhost:8787/anchor-gate/info");
      expect(text).toContain("Legacy economic routes remain disabled");
      expect(text).toContain("Use test assets only");
      expect(text).not.toContain(
        "Deposits, withdrawals, bank simulation, and payout processing are disabled"
      );
      expect(text).toMatch(/^[\x00-\x7f]*$/);
    }
    const capabilities = await (await strict.request("/sep6/info")).json();
    expect(capabilities).toMatchObject({
      deposit: { USDC: { enabled: false } },
      withdraw: { USDC: { enabled: false } },
    });
    expect((await strict.request("/static/index.html")).status).toBe(403);
  });

  it("blocks direct legacy HTML assets in strict mode but preserves ordinary assets", async () => {
    const { strict, legacy } = fixture();
    for (const path of [
      "/static/",
      "/static/index.html",
      "/static/index%2ehtml",
    ]) {
      const response = await strict.request(path);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain(POLICY_PENDING_MESSAGE);
    }
    expect((await strict.request("/static/style.css")).status).toBe(200);
    expect((await strict.request("/static/site.js")).status).toBe(200);
    expect((await legacy.request("/static/index.html")).status).toBe(200);
  });
});
