import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Keypair,
  Networks,
  SorobanDataBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { createLogger, type Deps } from "../src/context.js";
import { openDb } from "../src/db.js";
import { signJwt } from "../src/jwt.js";
import { createRateService } from "../src/rates.js";
import { createSepContext } from "../src/sepauth.js";
import { createFakeGateway } from "../src/stellar.js";
import {
  createNativePassportVerifier,
  PASSPORT_VERIFIER,
  type PassportVerification,
} from "../src/zkpassport.js";

const proof = readFileSync(
  new URL(
    "../contracts/zkpassport-verifier/fixtures/proof.bin",
    import.meta.url
  )
);
const inputs = readFileSync(
  new URL(
    "../contracts/zkpassport-verifier/fixtures/public_inputs.bin",
    import.meta.url
  )
);
const body = JSON.stringify({
  proof: proof.toString("hex"),
  public_inputs: inputs.toString("hex"),
});
afterEach(() => vi.restoreAllMocks());

function setup(
  result: PassportVerification = { status: "math_valid", ledger: 4766089 }
) {
  const cfg = {
    ...config,
    anchorMode: "zkpassport" as const,
    stellarMode: "fake" as const,
    rateSource: "static" as const,
  };
  const db = openDb(":memory:");
  const verify = vi.fn(async () => result);
  const deps: Deps = {
    cfg,
    db,
    stellar: createFakeGateway(cfg),
    rates: createRateService(cfg),
    log: createLogger(true),
    passportVerifier: { verify },
  };
  const sep = createSepContext(deps);
  const app = createApp(deps, sep);
  const subject = Keypair.random().publicKey();
  const headers = (sub = subject) => ({
    "content-type": "application/json",
    authorization: `Bearer ${signJwt({ iss: cfg.publicUrl, sub, iat: 0, exp: Math.floor(Date.now() / 1000) + 60 }, sep.jwtSecret)}`,
  });
  return { db, app, verify, subject, headers };
}

describe("proof submissions", () => {
  it("reports the pinned diagnostic verifier without advertising payout approval", async () => {
    const { app } = setup();
    const response = await app.request("/zkpassport/info");
    expect(await response.json()).toMatchObject({
      verifier_contract: PASSPORT_VERIFIER,
      eligibility_status: "unbound",
      payout_authorized: false,
    });
  });

  it("requires SEP-10 authentication", async () => {
    const { app, verify } = setup();
    const response = await app.request("/zkpassport/proofs", {
      method: "POST",
      body,
    });
    expect(response.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
  });

  it("records math validity without approving identity, orders or payouts", async () => {
    const { app, db, headers, subject, verify } = setup();
    const response = await app.request("/zkpassport/proofs", {
      method: "POST",
      headers: headers(),
      body,
    });
    expect(response.status).toBe(201);
    const record = z
      .object({ id: z.string() })
      .passthrough()
      .parse(await response.json());
    expect(record).toMatchObject({
      stellar_subject: subject,
      math_status: "math_valid",
      execution_method: "rpc_simulation",
      eligibility_status: "unbound",
      payout_authorized: false,
    });
    expect(verify).toHaveBeenCalledWith(proof, inputs);
    expect(db.prepare("SELECT kyc_status FROM customers").get()).toMatchObject({
      kyc_status: "pending",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM onramps").get()
    ).toMatchObject({ count: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM ledger").get()
    ).toMatchObject({ count: 0 });
    const columns = db
      .prepare("PRAGMA table_info(passport_proofs)")
      .all()
      .map((row) => row.name);
    expect(columns).not.toContain("proof");
    expect(columns).not.toContain("public_inputs");
    const own = await app.request(`/zkpassport/proofs/${record.id}`, {
      headers: headers(),
    });
    expect(own.status).toBe(200);
    const other = await app.request(`/zkpassport/proofs/${record.id}`, {
      headers: headers(Keypair.random().publicKey()),
    });
    expect(other.status).toBe(404);
    const otherMemo = await app.request(`/zkpassport/proofs/${record.id}`, {
      headers: headers(`${subject}:7`),
    });
    expect(otherMemo.status).toBe(404);
  });

  it.each([
    ["invalid", 422],
    ["verifier_unavailable", 503],
  ] as const)("keeps %s distinct from authorization", async (status, http) => {
    const { app, headers } = setup({ status, ledger: null });
    const result = await app.request("/zkpassport/proofs", {
      method: "POST",
      headers: headers(),
      body,
    });
    expect(result.status).toBe(http);
    expect(await result.json()).toMatchObject({
      math_status: status,
      payout_authorized: false,
    });
  });

  it("rejects malformed fields and oversized requests before invoking the verifier", async () => {
    const { app, headers, verify } = setup();
    for (const invalid of [
      "{",
      "{}",
      JSON.stringify({ proof: "12", public_inputs: inputs.toString("hex") }),
      JSON.stringify({
        proof: proof.toString("hex"),
        public_inputs: inputs.toString("hex"),
        verified: true,
      }),
    ]) {
      const response = await app.request("/zkpassport/proofs", {
        method: "POST",
        headers: headers(),
        body: invalid,
      });
      expect(response.status).toBe(400);
    }
    const large = await app.request("/zkpassport/proofs", {
      method: "POST",
      headers: headers(),
      body: "x".repeat(24_577),
    });
    expect(large.status).toBe(413);
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("native verifier adapter", () => {
  const cfg = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  };
  const success = (
    retval = xdr.ScVal.scvBool(true)
  ): rpc.Api.SimulateTransactionSuccessResponse => ({
    id: "1",
    latestLedger: 4766089,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "100",
    result: { auth: [], retval },
  });

  it("requires exactly true from the contract", async () => {
    const call = vi
      .spyOn(rpc.Server.prototype, "simulateTransaction")
      .mockResolvedValue(success());
    expect(
      await createNativePassportVerifier(cfg).verify(proof, inputs)
    ).toEqual({ status: "math_valid", ledger: 4766089 });
    call.mockResolvedValue(success(xdr.ScVal.scvBool(false)));
    expect(
      (await createNativePassportVerifier(cfg).verify(proof, inputs)).status
    ).toBe("verifier_unavailable");
  });

  it("recognizes only an explicit InvalidProof contract error", async () => {
    const call = vi
      .spyOn(rpc.Server.prototype, "simulateTransaction")
      .mockResolvedValue({
        id: "1",
        latestLedger: 4766089,
        events: [],
        _parsed: true,
        error: "HostError: Error(Contract, #2)",
      });
    expect(
      (await createNativePassportVerifier(cfg).verify(proof, inputs)).status
    ).toBe("invalid");
    call.mockResolvedValue({
      id: "1",
      latestLedger: 4766089,
      events: [],
      _parsed: true,
      error: "HostError: Error(Budget, ExceededLimit)",
    });
    expect(
      (await createNativePassportVerifier(cfg).verify(proof, inputs)).status
    ).toBe("verifier_unavailable");
    call.mockRejectedValue(new Error("RPC unreachable"));
    expect(
      (await createNativePassportVerifier(cfg).verify(proof, inputs)).status
    ).toBe("verifier_unavailable");
  });

  it("does not silently treat archived-contract simulation as an available verifier", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({
      ...success(),
      result: { auth: [], retval: xdr.ScVal.scvBool(true) },
      restorePreamble: {
        minResourceFee: "100",
        transactionData: new SorobanDataBuilder(),
      },
    });
    expect(
      (await createNativePassportVerifier(cfg).verify(proof, inputs)).status
    ).toBe("verifier_unavailable");
  });

  it("never targets mainnet or sends malformed inputs to RPC", async () => {
    const call = vi.spyOn(rpc.Server.prototype, "simulateTransaction");
    expect(
      (
        await createNativePassportVerifier({
          ...cfg,
          networkPassphrase: Networks.PUBLIC,
        }).verify(proof, inputs)
      ).status
    ).toBe("verifier_unavailable");
    expect(
      (
        await createNativePassportVerifier(cfg).verify(
          proof.subarray(1),
          inputs
        )
      ).status
    ).toBe("invalid");
    expect(call).not.toHaveBeenCalled();
  });
});
