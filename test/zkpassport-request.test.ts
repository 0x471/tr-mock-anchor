import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  PASSPORT_VK_HASH,
  type PassportVerification,
} from "../src/zkpassport.js";
import {
  createDiagnosticIntent,
  inspectReceivedProofs,
  loadPassportRequestClient,
  parseRequestOptions,
  runPassportRequest,
  type DiagnosticBuilder,
  type DiagnosticIntent,
  type DiagnosticRequest,
  type PassportRequestClient,
} from "../src/zkpassport-request.js";

const options = parseRequestOptions(["--domain", "example.org", "--dev-mode"]);
const intent = createDiagnosticIntent(
  options,
  1_800_000_000_000,
  Buffer.alloc(32, 7)
);
const proof = readFileSync(
  new URL(
    "../contracts/zkpassport-verifier/fixtures/proof.bin",
    import.meta.url
  )
);
const candidate = {
  name: "outer_evm_count_5",
  version: "0.20.0",
  vkeyHash: PASSPORT_VK_HASH,
  proof: Buffer.alloc(9888 + 320).toString("hex"),
};
const field = (value: number) => `0x${value.toString(16).padStart(64, "0")}`;
const h31 = (value: Buffer | string) =>
  `0x00${createHash("sha256").update(value).digest("hex").slice(0, 62)}`;

function parameters(binding: DiagnosticIntent = intent) {
  const bind = Buffer.concat([
    Buffer.from("0801fd030040", "hex"),
    Buffer.from(binding.digest, "ascii"),
    Buffer.alloc(442),
  ]);
  return {
    proofVerificationData: {
      proof: `0x${proof.toString("hex")}`,
      vkeyHash: `0x${PASSPORT_VK_HASH}`,
      publicInputs: [
        field(1),
        field(2),
        field(binding.issuedAt),
        h31(binding.domain),
        h31(binding.scope),
        h31(Buffer.from("0100021200", "hex")),
        h31(bind),
        field(2),
        field(1),
        field(0),
      ],
    },
  };
}

function fakeClient(data: unknown = parameters()) {
  let success: (value: unknown) => void = () => {};
  let reject: () => void = () => {};
  let error: (value: unknown) => void = () => {};
  let received: () => void = () => {};
  let generating: () => void = () => {};
  let generated: (value: unknown) => void = () => {};
  let connected: () => void = () => {};
  let disconnected: () => void = () => {};
  const request: DiagnosticRequest & {
    onProofGenerated(callback: (proof: unknown) => void): void;
    onBridgeConnect(callback: () => void): void;
    onBridgeConnectionLost(callback: () => void): void;
  } = {
    url: "https://zkpassport.id/r?test=1",
    requestId: "fake",
    onSuccess: (callback) => {
      success = callback;
    },
    onReject: (callback) => {
      reject = callback;
    },
    onError: (callback) => {
      error = callback;
    },
    onRequestReceived: (callback) => {
      received = callback;
    },
    onGeneratingProof: (callback) => {
      generating = callback;
    },
    onProofGenerated: (callback) => {
      generated = callback;
    },
    onBridgeConnect: (callback) => {
      connected = callback;
    },
    onBridgeConnectionLost: (callback) => {
      disconnected = callback;
    },
  };
  const builder: DiagnosticBuilder = {
    gte: vi.fn(() => builder),
    bind: vi.fn(() => builder),
    done: vi.fn(() => request),
  };
  const client = {
    request: vi.fn(async () => builder),
    getSolidityVerifierParameters: vi.fn(() => data),
    clearAllRequests: vi.fn(),
  } satisfies PassportRequestClient;
  const verify = vi.fn(async (): Promise<PassportVerification> => ({
    status: "math_valid",
    ledger: 123,
  }));
  return {
    client,
    builder,
    verify,
    success: (value: unknown) => success(value),
    reject: () => reject(),
    error: (value: unknown = "sensitive error text") => error(value),
    received: () => received(),
    generating: () => generating(),
    generated: (value: unknown) => generated(value),
    connected: () => connected(),
    disconnected: () => disconnected(),
  };
}

afterEach(() => vi.useRealTimers());

it("loads the actual pinned SDK through its Node-compatible export without starting a session", () => {
  const client = loadPassportRequestClient("example.org");
  expect(typeof client.request).toBe("function");
  expect(typeof client.getSolidityVerifierParameters).toBe("function");
  expect(typeof client.clearAllRequests).toBe("function");
  client.clearAllRequests();
});

it("extracts the exact public-input prefix with the actual SDK parser without network", async () => {
  const client = loadPassportRequestClient("example.org");
  const data = parameters().proofVerificationData;
  const sdkProof = {
    ...candidate,
    proof:
      data.publicInputs.map((value) => value.slice(2)).join("") +
      data.proof.slice(2),
    committedInputs: {
      compare_age_evm: { minAge: 18, maxAge: 0 },
      bind_evm: { data: { custom_data: intent.digest } },
    },
  };
  const verify = vi.fn(async (): Promise<PassportVerification> => ({
    status: "invalid",
    ledger: 123,
  }));
  const result = await inspectReceivedProofs(
    { proofs: [sdkProof] },
    client,
    { verify },
    intent,
    1_800_000_001_000
  );
  expect(result.summary).toMatchObject({
    profile: "supported",
    math_status: "invalid",
  });
  expect(verify).toHaveBeenCalledWith(
    proof,
    Buffer.from(
      data.publicInputs.map((value) => value.slice(2)).join(""),
      "hex"
    )
  );
  client.clearAllRequests();
});

describe("diagnostic request arguments and intent", () => {
  it("requires explicit synthetic mode and a canonical caller-provided hostname", () => {
    expect(options).toMatchObject({
      domain: "example.org",
      devMode: true,
      timeoutSeconds: 600,
    });
    for (const args of [
      [],
      ["--domain", "example.org"],
      ["--dev-mode"],
      ["--domain", "https://example.org", "--dev-mode"],
      ["--domain", "Example.org", "--dev-mode"],
    ]) {
      expect(() => parseRequestOptions(args)).toThrow();
    }
  });

  it.each(["0", "601", "1.5", "NaN"])("rejects timeout %s", (value) => {
    expect(() =>
      parseRequestOptions([
        "--domain",
        "example.org",
        "--dev-mode",
        "--timeout-seconds",
        value,
      ])
    ).toThrow();
  });

  it("rejects unknown, duplicate, malformed scope and secret-key arguments", () => {
    for (const extra of [
      ["--network", "mainnet"],
      ["--dev-mode"],
      ["--domain", "other.org"],
      ["--scope", "Bad Scope"],
      ["--recipient", Keypair.random().secret()],
    ]) {
      expect(() =>
        parseRequestOptions(["--domain", "example.org", "--dev-mode", ...extra])
      ).toThrow();
    }
  });

  it("binds the fixed Testnet, optional recipient and fresh nonce, deterministically", () => {
    expect(intent.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(intent.network).toBe(Networks.TESTNET);
    expect(
      createDiagnosticIntent(options, 1_800_000_000_000, Buffer.alloc(32, 7))
    ).toEqual(intent);
    expect(
      createDiagnosticIntent(options, 1_800_000_000_000, Buffer.alloc(32, 8))
        .digest
    ).not.toBe(intent.digest);
    expect(
      createDiagnosticIntent(
        { ...options, recipient: Keypair.random().publicKey() },
        1_800_000_000_000,
        Buffer.alloc(32, 7)
      ).digest
    ).not.toBe(intent.digest);
    expect(
      createDiagnosticIntent(
        { ...options, domain: "another.org" },
        1_800_000_000_000,
        Buffer.alloc(32, 7)
      ).digest
    ).not.toBe(intent.digest);
  });
});

describe("received proof diagnostics", () => {
  it("uses the native adapter and never labels math validity as payout or identity approval", async () => {
    const fake = fakeClient();
    const result = await inspectReceivedProofs(
      {
        proofs: [candidate],
        result: { verified: true, passport: "do not retain" },
      },
      fake.client,
      { verify: fake.verify },
      intent,
      1_800_000_001_000
    );
    expect(fake.verify).toHaveBeenCalledWith(
      proof,
      Buffer.concat(
        parameters().proofVerificationData.publicInputs.map((value) =>
          Buffer.from(value.slice(2), "hex")
        )
      )
    );
    expect(result.summary).toMatchObject({
      profile: "supported",
      math_status: "math_valid",
      payout_authorized: false,
      eligibility_status: "not_evaluated",
      proof_bytes: 9888,
      public_input_bytes: 320,
    });
    expect(Object.values(result.summary.request_checks ?? {})).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(JSON.stringify(result)).not.toContain("do not retain");
    expect(JSON.stringify(result.summary)).not.toContain(candidate.proof);
  });

  it.each([
    { ...candidate, version: "0.21.0" },
    { ...candidate, name: "outer_evm_count_6" },
    { ...candidate, vkeyHash: "ff" },
  ])(
    "does not invoke the parser or verifier for another profile",
    async (record) => {
      const fake = fakeClient();
      const result = await inspectReceivedProofs(
        { proofs: [record], verified: true },
        fake.client,
        { verify: fake.verify },
        intent
      );
      expect(result.summary.profile).toBe("unsupported");
      expect(fake.client.getSolidityVerifierParameters).not.toHaveBeenCalled();
      expect(fake.verify).not.toHaveBeenCalled();
    }
  );

  it("rejects a claimed browser success with no valid proof records", async () => {
    const fake = fakeClient();
    expect(
      (
        await inspectReceivedProofs(
          { verified: true, proofs: [] },
          fake.client,
          { verify: fake.verify },
          intent
        )
      ).summary.profile
    ).toBe("malformed");
    expect(fake.verify).not.toHaveBeenCalled();
  });

  it.each([
    "01",
    `${candidate.proof}00`,
    candidate.proof.slice(0, -2),
    "not proof bytes",
  ])(
    "does not let the SDK pad or truncate a malformed container",
    async (container) => {
      const fake = fakeClient();
      const result = await inspectReceivedProofs(
        { proofs: [{ ...candidate, proof: container }] },
        fake.client,
        { verify: fake.verify },
        intent
      );
      expect(result.summary.profile).toBe("malformed");
      expect(fake.client.getSolidityVerifierParameters).not.toHaveBeenCalled();
      expect(fake.verify).not.toHaveBeenCalled();
    }
  );

  it.each([
    "proof_length",
    "input_count",
    "input_width",
    "field_modulus",
    "vk_mismatch",
    "non_hex",
  ])("rejects malformed %s before RPC", async (mutation) => {
    const data = parameters();
    if (mutation === "proof_length") data.proofVerificationData.proof = "0x01";
    if (mutation === "input_count")
      data.proofVerificationData.publicInputs.pop();
    if (mutation === "input_width")
      data.proofVerificationData.publicInputs[0] = "0x01";
    if (mutation === "field_modulus")
      data.proofVerificationData.publicInputs[0] = `0x${21888242871839275222246405745257275088548364400416034343698204186575808495617n.toString(16)}`;
    if (mutation === "vk_mismatch")
      data.proofVerificationData.vkeyHash = "0x02";
    if (mutation === "non_hex") data.proofVerificationData.proof = "not hex";
    const fake = fakeClient(data);
    expect(
      (
        await inspectReceivedProofs(
          { proofs: [candidate] },
          fake.client,
          { verify: fake.verify },
          intent
        )
      ).summary.profile
    ).toBe("malformed");
    expect(fake.verify).not.toHaveBeenCalled();
  });

  it("reports a stale or differently bound proof even when the math adapter says true", async () => {
    const data = parameters();
    data.proofVerificationData.publicInputs[2] = field(1784010128);
    data.proofVerificationData.publicInputs[3] = field(4);
    data.proofVerificationData.publicInputs[6] = field(5);
    const fake = fakeClient(data);
    const result = await inspectReceivedProofs(
      { proofs: [candidate] },
      fake.client,
      { verify: fake.verify },
      intent,
      1_800_000_001_000
    );
    expect(result.summary.request_checks).toMatchObject({
      scopes_match: false,
      commitments_match: false,
      recent_timestamp: false,
    });
    expect(result.summary.payout_authorized).toBe(false);
  });

  it("keeps RPC failure distinct from a malformed or invalid proof", async () => {
    const fake = fakeClient();
    fake.verify.mockRejectedValue(new Error("offline"));
    const result = await inspectReceivedProofs(
      { proofs: [candidate] },
      fake.client,
      { verify: fake.verify },
      intent
    );
    expect(result.summary).toMatchObject({
      profile: "supported",
      math_status: "verifier_unavailable",
    });
  });
});

describe("bounded request lifecycle without network", () => {
  it("retains progress and classifies a documented SDK proof error without exposing its text", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T02:00:00.000Z"));
    const fake = fakeClient();
    const events = vi.fn();
    const pending = runPassportRequest(
      options,
      fake.client,
      { verify: fake.verify },
      events
    );
    await vi.advanceTimersByTimeAsync(0);
    fake.received();
    fake.generated({ proof: "private proof" });
    fake.error("Cannot generate proof: private document details");
    const result = await pending;
    expect(result.summary).toMatchObject({
      outcome: "error",
      last_milestone: "proof_generated",
      proofs_received: 1,
      sdk_error_category: "proof_generation_failed",
    });
    expect(events).toHaveBeenLastCalledWith({
      event: "sdk_error",
      at: "2026-09-20T02:00:00.000Z",
      proofs_received: 1,
      sdk_error_category: "proof_generation_failed",
    });
    expect(JSON.stringify({ result, events: events.mock.calls })).not.toContain(
      "private"
    );
  });

  it("reports only timestamped transport milestones and proof counts through timeout, ignoring late events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T02:00:00.000Z"));
    const fake = fakeClient();
    const events = vi.fn();
    const pending = runPassportRequest(
      { ...options, timeoutSeconds: 1 },
      fake.client,
      { verify: fake.verify },
      events
    );
    await vi.advanceTimersByTimeAsync(0);
    fake.connected();
    fake.received();
    fake.generating();
    fake.generated({ name: "private document", proof: "private payload" });
    fake.disconnected();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.summary).toMatchObject({
      outcome: "timed_out",
      last_milestone: "bridge_connection_lost",
      proofs_received: 1,
    });
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      {
        event: "request_ready",
        at: "2026-09-20T02:00:00.000Z",
        proofs_received: 0,
        url: "https://zkpassport.id/r?test=1",
      },
      {
        event: "bridge_connected",
        at: "2026-09-20T02:00:00.000Z",
        proofs_received: 0,
      },
      {
        event: "secure_channel_established",
        at: "2026-09-20T02:00:00.000Z",
        proofs_received: 0,
      },
      {
        event: "generating_proof",
        at: "2026-09-20T02:00:00.000Z",
        proofs_received: 0,
      },
      {
        event: "proof_generated",
        at: "2026-09-20T02:00:00.000Z",
        proofs_received: 1,
      },
      {
        event: "bridge_connection_lost",
        at: "2026-09-20T02:00:00.000Z",
        proofs_received: 1,
      },
    ]);
    const eventCount = events.mock.calls.length;
    fake.connected();
    fake.received();
    fake.generating();
    fake.generated({ name: "late private document" });
    fake.disconnected();
    fake.error();
    fake.reject();
    fake.success({ proofs: [candidate] });
    expect(events).toHaveBeenCalledTimes(eventCount);
    expect(result.summary.proofs_received).toBe(1);
    expect(JSON.stringify(events.mock.calls)).not.toContain("private");
    expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.client.clearAllRequests).toHaveBeenCalledOnce();
  });

  it.each([
    ["This ID is not supported yet", "unsupported_id"],
    ["This ID is not supported yet: private detail", "other"],
    ["private error text", "other"],
    [{ message: "Cannot generate proof: private detail" }, "other"],
  ])(
    "classifies only source-defined SDK string errors",
    async (error, category) => {
      vi.useFakeTimers();
      const fake = fakeClient();
      const events = vi.fn();
      const pending = runPassportRequest(
        options,
        fake.client,
        { verify: fake.verify },
        events
      );
      await vi.advanceTimersByTimeAsync(0);
      fake.error(error);
      expect((await pending).summary).toMatchObject({
        outcome: "error",
        last_milestone: "request_ready",
        proofs_received: 0,
        sdk_error_category: category,
      });
      expect(JSON.stringify(events.mock.calls)).not.toContain("private");
    }
  );

  it("creates only age plus custom-data and cleans up after an unsupported response", async () => {
    const fake = fakeClient();
    const events = vi.fn();
    const pending = runPassportRequest(
      options,
      fake.client,
      { verify: fake.verify },
      events
    );
    await vi.waitFor(() =>
      expect(events).toHaveBeenCalledWith({
        event: "request_ready",
        url: "https://zkpassport.id/r?test=1",
        at: expect.any(String),
        proofs_received: 0,
      })
    );
    expect(fake.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "compressed-evm",
        uniqueIdentifierType: 0,
        devMode: true,
        verifierMode: "local",
      })
    );
    expect(fake.builder.gte).toHaveBeenCalledWith("age", 18);
    expect(fake.builder.bind).toHaveBeenCalledWith(
      "custom_data",
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
    fake.success({ proofs: [{ ...candidate, version: "unknown" }] });
    expect((await pending).summary.profile).toBe("unsupported");
    expect(fake.client.clearAllRequests).toHaveBeenCalledOnce();
    expect(fake.verify).not.toHaveBeenCalled();
  });

  it.each(["rejected", "error"] as const)(
    "closes the request after %s and does not expose SDK error text",
    async (outcome) => {
      const fake = fakeClient();
      const events = vi.fn();
      const pending = runPassportRequest(
        options,
        fake.client,
        { verify: fake.verify },
        events
      );
      await vi.waitFor(() => expect(events).toHaveBeenCalled());
      if (outcome === "rejected") fake.reject();
      else fake.error();
      const result = await pending;
      expect(result.summary.outcome).toBe(outcome);
      expect(JSON.stringify(result)).not.toContain("sensitive error text");
      expect(fake.client.clearAllRequests).toHaveBeenCalledOnce();
    }
  );

  it("times out even if SDK startup never completes", async () => {
    vi.useFakeTimers();
    const fake = fakeClient();
    fake.client.request.mockImplementation(() => new Promise(() => {}));
    const pending = runPassportRequest(
      { ...options, timeoutSeconds: 1 },
      fake.client,
      { verify: fake.verify },
      () => {}
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).summary).toMatchObject({
      outcome: "timed_out",
      last_milestone: null,
      proofs_received: 0,
    });
    expect(fake.client.clearAllRequests).toHaveBeenCalledOnce();
  });

  it("does not start an already interrupted session", async () => {
    const fake = fakeClient();
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await runPassportRequest(
          options,
          fake.client,
          { verify: fake.verify },
          () => {},
          controller.signal
        )
      ).summary.outcome
    ).toBe("interrupted");
    expect(fake.client.request).not.toHaveBeenCalled();
  });

  it("cancels an active session and ignores a late success callback", async () => {
    const fake = fakeClient();
    const controller = new AbortController();
    const events = vi.fn();
    const pending = runPassportRequest(
      options,
      fake.client,
      { verify: fake.verify },
      events,
      controller.signal
    );
    await vi.waitFor(() => expect(events).toHaveBeenCalled());
    fake.received();
    fake.generated({ proof: "private proof" });
    controller.abort();
    fake.success({ proofs: [candidate] });
    expect((await pending).summary).toMatchObject({
      outcome: "interrupted",
      last_milestone: "proof_generated",
      proofs_received: 1,
    });
    expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.client.clearAllRequests).toHaveBeenCalledOnce();
  });
});
