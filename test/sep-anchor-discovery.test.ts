import { expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createFakeGateway } from "../src/stellar.js";
import type { SepAnchorGateway } from "../src/sep-anchor-types.js";

it("advertises SEP-24 only when the separate native SEP gateway is configured", async () => {
  const cfg = {
    ...config,
    publicUrl: "http://localhost:8787",
    anchorMode: "zkpassport" as const,
    rateSource: "static" as const,
  };
  const db = openDb(":memory:");
  try {
    const deps: Deps = {
      cfg,
      db,
      stellar: createFakeGateway(cfg),
      rates: createRateService(cfg),
      log: createLogger(true),
    };
    const unavailable = async (): Promise<never> => {
      throw new Error("No contract read expected for discovery.");
    };
    const gateway: SepAnchorGateway = {
      configuration: unavailable,
      challenge: unavailable,
      eligibility: unavailable,
      order: unavailable,
      prepare: unavailable,
      submit: unavailable,
      transaction: unavailable,
    };
    const before = await (
      await createApp(deps).request("/.well-known/stellar.toml")
    ).text();
    expect(before).not.toContain("TRANSFER_SERVER_SEP0024");
    const enabled = createApp({ ...deps, sepAnchorGateway: gateway });
    const toml = await (
      await enabled.request("/.well-known/stellar.toml")
    ).text();
    expect(toml).toContain(
      'TRANSFER_SERVER_SEP0024="http://localhost:8787/sep24"'
    );
    expect(toml).toContain('TRANSFER_SERVER="http://localhost:8787/sep6"');
    expect(toml).toContain("native eligibility");
    expect(toml).not.toContain("not a portable SEP-6 ramp");
    const home = await enabled.request("/");
    expect(home.status).toBe(302);
    expect(home.headers.get("location")).toBe("/anchor");
  } finally {
    db.close();
  }
});
