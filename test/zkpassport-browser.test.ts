import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BROWSER_PROOF_BODY_LIMIT,
  createBrowserDiagnosticApp,
} from "../src/zkpassport-browser.js";
import { parseRequestOptions } from "../src/zkpassport-request.js";
import { PASSPORT_VK_HASH } from "../src/zkpassport.js";

const origin = "http://localhost:8792";
const options = parseRequestOptions(["--domain", "localhost", "--dev-mode"]);
const headers = {
  Host: "localhost:8792",
  Origin: origin,
  "Content-Type": "application/json",
};

function setup() {
  const client = {
    request: vi.fn(),
    getSolidityVerifierParameters: vi.fn(),
    clearAllRequests: vi.fn(),
  };
  const verify = vi.fn(async () => ({
    status: "math_valid" as const,
    ledger: 123,
  }));
  const saveCapture = vi.fn(async () => {});
  let currentTime = 1_800_000_000_000;
  const app = createBrowserDiagnosticApp({
    options,
    port: 8792,
    client,
    verifier: { verify },
    html: "page",
    bundle: "script",
    saveCapture,
    now: () => currentTime,
  });
  return {
    app,
    client,
    verify,
    saveCapture,
    setTime: (value: number) => {
      currentTime = value;
    },
  };
}

describe("loopback browser diagnostic HTTP boundary", () => {
  it.each(["cancelled", "expired"] as const)(
    "does not inspect a proof whose upload completes after the session is %s",
    async (closedBy) => {
      const { app, client, verify, saveCapture, setTime } = setup();
      client.getSolidityVerifierParameters.mockReturnValue({
        proofVerificationData: {
          proof: "00".repeat(9888),
          vkeyHash: PASSPORT_VK_HASH,
          publicInputs: Array(10).fill("00".repeat(32)),
        },
      });
      const body = JSON.stringify({
        name: "outer_evm_count_5",
        version: "0.20.0",
        vkeyHash: PASSPORT_VK_HASH,
        proof: "00".repeat(10208),
      });
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      let markReading = () => {};
      const reading = new Promise<void>((resolve) => {
        markReading = resolve;
      });
      let firstChunk = true;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
          },
          pull(controller) {
            if (firstChunk) {
              firstChunk = false;
              controller.enqueue(new TextEncoder().encode(body.slice(0, 10)));
              markReading();
            }
          },
        },
        { highWaterMark: 0 }
      );
      const pending = app.request(
        new Request(`${origin}/proof`, {
          method: "POST",
          headers,
          body: stream,
          duplex: "half",
        })
      );
      await reading;
      if (closedBy === "cancelled") {
        expect(
          (await app.request(`${origin}/cancel`, { method: "POST", headers }))
            .status
        ).toBe(200);
      } else {
        setTime(1_800_000_600_000);
      }
      if (!source) throw new Error("Upload stream was not initialized.");
      source.enqueue(new TextEncoder().encode(body.slice(10)));
      source.close();
      expect((await pending).status).toBe(410);
      expect(client.getSolidityVerifierParameters).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(saveCapture).not.toHaveBeenCalled();
    }
  );

  it("rejects oversized or non-JSON proof requests without invoking SDK parsing or RPC", async () => {
    const { app, client, verify } = setup();
    const oversized = await app.request(`${origin}/proof`, {
      method: "POST",
      headers,
      body: "x".repeat(BROWSER_PROOF_BODY_LIMIT + 1),
    });
    expect(oversized.status).toBe(413);
    const nonJson = await app.request(`${origin}/proof`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "text/plain" },
      body: "text",
    });
    expect(nonJson.status).toBe(415);
    const malformed = await app.request(`${origin}/proof`, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(client.getSolidityVerifierParameters).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(oversized.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("uses the identical server intent for proof bindings and writes at most one capture", async () => {
    const { app, client, verify, saveCapture } = setup();
    const config = z
      .object({ digest: z.string() })
      .parse(await (await app.request(`${origin}/config`, { headers })).json());
    const field = (value: number) => value.toString(16).padStart(64, "0");
    const hash = (value: string | Buffer) =>
      `00${createHash("sha256").update(value).digest("hex").slice(0, 62)}`;
    const bind = Buffer.concat([
      Buffer.from("0801fd030040", "hex"),
      Buffer.from(config.digest, "ascii"),
      Buffer.alloc(442),
    ]);
    client.getSolidityVerifierParameters.mockReturnValue({
      proofVerificationData: {
        proof: "00".repeat(9888),
        vkeyHash: PASSPORT_VK_HASH,
        publicInputs: [
          field(1),
          field(2),
          field(1_800_000_000),
          hash("localhost"),
          hash(options.scope),
          hash(Buffer.from("0100021200", "hex")),
          hash(bind),
          field(2),
          field(1),
          field(0),
        ],
      },
    });
    const record = {
      name: "outer_evm_count_5",
      version: "0.20.0",
      vkeyHash: PASSPORT_VK_HASH,
      proof: "00".repeat(10208),
      extra: "never retain",
    };
    const response = await app.request(`${origin}/proof`, {
      method: "POST",
      headers,
      body: JSON.stringify(record),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      math_status: "math_valid",
      payout_authorized: false,
      eligibility_status: "not_evaluated",
      export_saved: true,
      proofs_received: 1,
      last_milestone: "proof_received_verifying_math",
      request_checks: {
        scopes_match: true,
        commitments_match: true,
        recent_timestamp: true,
        non_salted_test_profile: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(record.proof);
    expect(JSON.stringify(result)).not.toContain("never retain");
    expect(saveCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ digest: config.digest }),
      }),
      expect.objectContaining({
        payout_authorized: false,
        proofs_received: 1,
        last_milestone: "proof_received_verifying_math",
      })
    );
    const again = await app.request(`${origin}/proof`, {
      method: "POST",
      headers,
      body: JSON.stringify(record),
    });
    expect(again.status).toBe(409);
    expect(saveCapture).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
  });

  it("closes proof admission after cancellation or expiration", async () => {
    const cancelled = setup();
    expect(
      (
        await cancelled.app.request(`${origin}/cancel`, {
          method: "POST",
          headers,
        })
      ).status
    ).toBe(200);
    expect(
      (
        await cancelled.app.request(`${origin}/proof`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status
    ).toBe(410);
    const expired = setup();
    expired.setTime(1_800_000_600_000);
    expect(
      (await expired.app.request(`${origin}/config`, { headers })).status
    ).toBe(410);
    expect(
      (
        await expired.app.request(`${origin}/proof`, {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status
    ).toBe(410);
    expect(expired.verify).not.toHaveBeenCalled();
    expect(cancelled.verify).not.toHaveBeenCalled();
  });
  it("requires an exact POST origin and never returns the received proof or arbitrary metadata", async () => {
    const client = {
      request: vi.fn(),
      getSolidityVerifierParameters: vi.fn(),
      clearAllRequests: vi.fn(),
    };
    const verify = vi.fn();
    const app = createBrowserDiagnosticApp({
      options,
      port: 8792,
      client,
      verifier: { verify },
      html: "page",
      bundle: "script",
    });
    const payload = JSON.stringify({
      name: "private name",
      proof: "aabb",
      version: "unknown",
      unrelated: "private payload",
    });
    for (const requestOrigin of [
      undefined,
      "http://evil.example",
      "http://localhost:8793",
    ]) {
      const response = await app.request(`${origin}/proof`, {
        method: "POST",
        headers: {
          Host: "localhost:8792",
          "Content-Type": "application/json",
          ...(requestOrigin ? { Origin: requestOrigin } : {}),
        },
        body: payload,
      });
      expect(response.status).toBe(403);
    }
    const response = await app.request(`${origin}/proof`, {
      method: "POST",
      headers: {
        Host: "localhost:8792",
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      profile: "unsupported",
      payout_authorized: false,
      eligibility_status: "not_evaluated",
      proofs_received: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(/private|aabb/);
    expect(verify).not.toHaveBeenCalled();
  });
  it("serves one bound intent only to the exact localhost host", async () => {
    const client = {
      request: vi.fn(),
      getSolidityVerifierParameters: vi.fn(),
      clearAllRequests: vi.fn(),
    };
    const app = createBrowserDiagnosticApp({
      options,
      port: 8792,
      client,
      verifier: { verify: vi.fn() },
      html: "page",
      bundle: "script",
    });
    const good = await app.request(`${origin}/config`, {
      headers: { Host: "localhost:8792" },
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({
      domain: "localhost",
      scope: options.scope,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const bad = await app.request(`${origin}/config`, {
      headers: { Host: "evil.example:8792" },
    });
    expect(bad.status).toBe(403);
    expect(client.request).not.toHaveBeenCalled();
  });
});
