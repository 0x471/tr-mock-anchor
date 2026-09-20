import { expect, it } from "vitest";
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb } from "../src/db.js";
import { createRateService } from "../src/rates.js";
import { createSepContext } from "../src/sepauth.js";
import { createFakeGateway } from "../src/stellar.js";

it("keeps a customer's firm quote asset immutable across an issuer change", async () => {
  const cfg = {
    ...config,
    publicUrl: "http://localhost:8787",
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
    const sep = createSepContext(deps);
    const app = createApp(deps, sep);
    const wallet = Keypair.random();
    const challenge = (await (
      await app.request(`/auth?account=${wallet.publicKey()}`)
    ).json()) as { transaction: string };
    const signed = TransactionBuilder.fromXdr(
      challenge.transaction,
      Networks.TESTNET
    );
    signed.sign(wallet);
    const login = (await (
      await app.request("/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: signed.toXdr() }),
      })
    ).json()) as { token: string };
    const headers = {
      authorization: `Bearer ${login.token}`,
      "content-type": "application/json",
    };
    const created = await app.request("/sep38/quote", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sell_asset: "iso4217:TRY",
        buy_asset: `stellar:USDC:${cfg.usdcIssuer}`,
        sell_amount: "100.00",
        context: "sep24",
      }),
    });
    expect(created.status).toBe(201);
    const quote = (await created.json()) as { id: string; buy_asset: string };
    const replacement = { ...cfg, usdcIssuer: Keypair.random().publicKey() };
    const restarted = createApp(
      { ...deps, cfg: replacement, stellar: createFakeGateway(replacement) },
      sep
    );
    const fetched = await restarted.request(`/sep38/quote/${quote.id}`, {
      headers,
    });
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as { buy_asset: string }).buy_asset).toBe(
      quote.buy_asset
    );
  } finally {
    db.close();
  }
});
