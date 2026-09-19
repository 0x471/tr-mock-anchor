import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import {
  PASSPORT_INPUT_BYTES,
  PASSPORT_PROOF_BYTES,
  PASSPORT_VK_HASH,
  type PassportVerifier,
  type ProofStatus,
} from "./zkpassport.js";

const FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_TIMEOUT_SECONDS = 600;
const hex = z.string().regex(/^(?:0x)?[0-9a-fA-F]+$/);
const proofRecord = z
  .object({
    name: z.string().max(100).optional(),
    version: z.string().max(40).optional(),
    vkeyHash: z.string().max(100).optional(),
    proof: z
      .string()
      .max(200_000)
      .regex(/^(?:[0-9a-fA-F]{2})+$/)
      .optional(),
  })
  .passthrough();

export interface RequestOptions {
  domain: string;
  scope: string;
  devMode: true;
  timeoutSeconds: number;
  recipient?: string;
  out?: string;
}

export function parseRequestOptions(args: string[]): RequestOptions {
  const values = new Map<string, string>();
  let devMode = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--dev-mode" && !devMode) {
      devMode = true;
      continue;
    }
    if (
      !key ||
      ![
        "--domain",
        "--scope",
        "--recipient",
        "--out",
        "--timeout-seconds",
      ].includes(key) ||
      values.has(key)
    ) {
      throw new Error("Unknown or duplicate option. Use --help.");
    }
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}.`);
    values.set(key, value);
  }
  if (!devMode)
    throw new Error(
      "This synthetic Testnet diagnostic requires explicit --dev-mode."
    );
  const domain = values.get("--domain");
  if (
    !domain ||
    domain.length > 253 ||
    domain !== domain.toLowerCase() ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
      domain
    )
  ) {
    throw new Error(
      "--domain must be a lowercase hostname without protocol, port, path or whitespace."
    );
  }
  const scope = values.get("--scope") ?? "stellar-anchor-compatibility-v1";
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(scope))
    throw new Error("--scope must be a canonical lowercase identifier.");
  const timeoutText = values.get("--timeout-seconds") ?? "600";
  if (!/^\d+$/.test(timeoutText))
    throw new Error("--timeout-seconds must be an integer between 1 and 600.");
  const timeoutSeconds = Number(timeoutText);
  if (
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error("--timeout-seconds must be an integer between 1 and 600.");
  }
  const recipient = values.get("--recipient");
  if (recipient && !StrKey.isValidEd25519PublicKey(recipient))
    throw new Error(
      "--recipient must be a public Stellar G account, never a secret key."
    );
  return {
    domain,
    scope,
    devMode: true,
    timeoutSeconds,
    recipient,
    out: values.get("--out"),
  };
}

export interface DiagnosticIntent {
  purpose: "zkpassport-stellar-compatibility-v1";
  domain: string;
  scope: string;
  network: string;
  recipient: string | null;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  digest: string;
}

export function createDiagnosticIntent(
  options: RequestOptions,
  now = Date.now(),
  nonce = randomBytes(32)
): DiagnosticIntent {
  if (nonce.length !== 32) throw new Error("Expected a 32-byte nonce.");
  const issuedAt = Math.floor(now / 1000);
  const fields = {
    purpose: "zkpassport-stellar-compatibility-v1" as const,
    domain: options.domain,
    scope: options.scope,
    network: Networks.TESTNET,
    recipient: options.recipient ?? null,
    issuedAt,
    expiresAt: issuedAt + options.timeoutSeconds,
    nonce: nonce.toString("hex"),
  };
  // A fixed ordered array avoids object-key-order ambiguity; this is not a payout intent.
  const encoded = JSON.stringify([
    fields.purpose,
    fields.domain,
    fields.scope,
    fields.network,
    fields.recipient,
    fields.issuedAt,
    fields.expiresAt,
    fields.nonce,
  ]);
  return {
    ...fields,
    digest: createHash("sha256").update(encoded, "utf8").digest("hex"),
  };
}

export interface DiagnosticRequest {
  url: string;
  requestId: string;
  onSuccess(callback: (response: unknown) => void): void;
  onReject(callback: () => void): void;
  onError(callback: (error: unknown) => void): void;
  onRequestReceived(callback: () => void): void;
  onGeneratingProof(callback: () => void): void;
}

export interface DiagnosticBuilder {
  gte(key: "age", value: number): DiagnosticBuilder;
  bind(key: "custom_data", value: string): DiagnosticBuilder;
  done(): DiagnosticRequest;
}

export interface PassportRequestClient {
  request(options: {
    name: string;
    purpose: string;
    scope: string;
    mode: "compressed-evm";
    devMode: true;
    validity: number;
    uniqueIdentifierType: 0;
    verifierMode: "local";
  }): Promise<DiagnosticBuilder>;
  getSolidityVerifierParameters(options: {
    proof: unknown;
    domain: string;
    scope: string;
    devMode: true;
    validityPeriodInSeconds: number;
  }): unknown;
  clearAllRequests(): void;
}

type SdkConstructor = new (domain: string) => PassportRequestClient;
function isConstructor(value: unknown): value is SdkConstructor {
  return typeof value === "function";
}

export function loadPassportRequestClient(
  domain: string
): PassportRequestClient {
  // SDK 0.17.1's ESM buffer/ import fails on Node; use its published CJS export.
  const sdk: { VERSION?: unknown; ZKPassport?: unknown } = createRequire(
    import.meta.url
  )("@zkpassport/sdk");
  if (sdk.VERSION !== "0.17.1" || !isConstructor(sdk.ZKPassport)) {
    throw new Error("Install the reviewed @zkpassport/sdk version 0.17.1.");
  }
  return new sdk.ZKPassport(domain);
}

export interface DiagnosticSummary {
  outcome: "received" | "rejected" | "error" | "timed_out" | "interrupted";
  profile: "supported" | "unsupported" | "malformed" | "not_received";
  math_status: ProofStatus | "not_checked";
  ledger: number | null;
  payout_authorized: false;
  eligibility_status: "not_evaluated";
  proofs: { name?: string; version?: string; vkey_hash?: string }[];
  proof_bytes?: number;
  public_input_bytes?: number;
  request_checks?: {
    scopes_match: boolean;
    commitments_match: boolean;
    recent_timestamp: boolean;
    non_salted_test_profile: boolean;
  };
}

export interface DiagnosticCapture {
  intent: DiagnosticIntent;
  proofs: {
    name?: string;
    version?: string;
    vkeyHash?: string;
    proof?: string;
  }[];
  native_input?: { proof: string; public_inputs: string };
}

export interface DiagnosticResult {
  summary: DiagnosticSummary;
  capture?: DiagnosticCapture;
}

function emptySummary(
  outcome: DiagnosticSummary["outcome"]
): DiagnosticSummary {
  return {
    outcome,
    profile: "not_received",
    math_status: "not_checked",
    ledger: null,
    payout_authorized: false,
    eligibility_status: "not_evaluated",
    proofs: [],
  };
}

function stripHex(value: string): string {
  return value.replace(/^0x/, "").toLowerCase();
}
function sha256TruncatedField(value: Buffer | string): string {
  return `00${createHash("sha256").update(value).digest("hex").slice(0, 62)}`;
}

export async function inspectReceivedProofs(
  response: unknown,
  client: PassportRequestClient,
  verifier: PassportVerifier,
  intent: DiagnosticIntent,
  now = Date.now()
): Promise<DiagnosticResult> {
  const summary = emptySummary("received");
  const parsed = z
    .object({ proofs: z.array(proofRecord).min(1).max(16) })
    .safeParse(response);
  if (!parsed.success) return { summary: { ...summary, profile: "malformed" } };
  const records = parsed.data.proofs;
  const capture: DiagnosticCapture = {
    intent,
    proofs: records.map(({ name, version, vkeyHash, proof }) => ({
      name,
      version,
      vkeyHash,
      proof,
    })),
  };
  summary.proofs = records.map(({ name, version, vkeyHash }) => ({
    name,
    version,
    vkey_hash: vkeyHash,
  }));
  const candidate = records[0];
  if (
    records.length !== 1 ||
    !candidate ||
    candidate.name !== "outer_evm_count_5" ||
    candidate.version !== "0.20.0" ||
    !candidate.vkeyHash ||
    stripHex(candidate.vkeyHash).padStart(64, "0") !== PASSPORT_VK_HASH
  ) {
    return { summary: { ...summary, profile: "unsupported" }, capture };
  }
  try {
    // SDK 0.17.1 pads partial words; reject noncanonical input before its parser runs.
    if (
      candidate.proof?.length !==
      (PASSPORT_PROOF_BYTES + PASSPORT_INPUT_BYTES) * 2
    ) {
      throw new Error("Invalid SDK proof container length.");
    }
    const parameters = z
      .object({
        proofVerificationData: z.object({
          proof: hex,
          publicInputs: z.array(hex).length(10),
          vkeyHash: hex,
        }),
      })
      .parse(
        client.getSolidityVerifierParameters({
          proof: candidate,
          domain: intent.domain,
          scope: intent.scope,
          devMode: true,
          validityPeriodInSeconds: 3600,
        })
      );
    const data = parameters.proofVerificationData;
    const proofHex = stripHex(data.proof);
    const inputHex = data.publicInputs.map(stripHex);
    if (
      stripHex(data.vkeyHash).padStart(64, "0") !== PASSPORT_VK_HASH ||
      proofHex.length !== PASSPORT_PROOF_BYTES * 2 ||
      inputHex.some(
        (value) => value.length !== 64 || BigInt(`0x${value}`) >= FR
      )
    )
      throw new Error("Invalid canonical encoding.");
    const proof = Buffer.from(proofHex, "hex");
    const inputs = Buffer.from(inputHex.join(""), "hex");
    if (inputs.length !== PASSPORT_INPUT_BYTES)
      throw new Error("Invalid input count.");
    const bind = Buffer.alloc(512);
    const customDataBindingHeader = Buffer.from("0801fd030040", "hex");
    const minimumAdultAgePredicate = Buffer.from("0100021200", "hex");
    customDataBindingHeader.copy(bind);
    bind.write(intent.digest, 6, 64, "ascii");
    const commitments = [
      sha256TruncatedField(minimumAdultAgePredicate),
      sha256TruncatedField(bind),
    ].sort();
    const proofTime = BigInt(`0x${inputHex[2]}`);
    const currentTime = BigInt(Math.floor(now / 1000));
    summary.profile = "supported";
    summary.proof_bytes = proof.length;
    summary.public_input_bytes = inputs.length;
    summary.request_checks = {
      scopes_match:
        inputHex[3] === sha256TruncatedField(intent.domain) &&
        inputHex[4] === sha256TruncatedField(intent.scope),
      commitments_match:
        JSON.stringify(inputHex.slice(5, 7).sort()) ===
        JSON.stringify(commitments),
      recent_timestamp:
        proofTime >= BigInt(intent.issuedAt - 60) &&
        proofTime <= currentTime &&
        currentTime - proofTime < 3600n &&
        currentTime < BigInt(intent.expiresAt),
      non_salted_test_profile:
        [0n, 2n].includes(BigInt(`0x${inputHex[7]}`)) &&
        BigInt(`0x${inputHex[9]}`) === 0n &&
        BigInt(`0x${inputHex[8]}`) !== 0n,
    };
    capture.native_input = {
      proof: proofHex,
      public_inputs: inputs.toString("hex"),
    };
    try {
      const verified = await verifier.verify(proof, inputs);
      summary.math_status = verified.status;
      summary.ledger = verified.ledger;
    } catch {
      summary.math_status = "verifier_unavailable";
    }
    return { summary, capture };
  } catch {
    return {
      summary: { ...summary, profile: "malformed", math_status: "not_checked" },
      capture,
    };
  }
}

export async function runPassportRequest(
  options: RequestOptions,
  client: PassportRequestClient,
  verifier: PassportVerifier,
  onEvent: (event: { event: string; url?: string }) => void,
  signal?: AbortSignal
): Promise<DiagnosticResult> {
  const intent = createDiagnosticIntent(options);
  return new Promise((resolve) => {
    let finished = false;
    let processing = false;
    const cleanup = () => {
      try {
        client.clearAllRequests();
      } catch {
        /* Keep cleanup failures from changing the diagnostic result. */
      }
    };
    const finish = (result: DiagnosticResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      cleanup();
      resolve(result);
    };
    const abort = () => finish({ summary: emptySummary("interrupted") });
    const timer = setTimeout(
      () => finish({ summary: emptySummary("timed_out") }),
      options.timeoutSeconds * 1000
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    void Promise.resolve()
      .then(() =>
        client.request({
          name: "Stellar Anchor Diagnostic",
          purpose:
            "Test proof compatibility only. No identity approval or payout.",
          scope: options.scope,
          mode: "compressed-evm",
          devMode: true,
          validity: 3600,
          uniqueIdentifierType: 0,
          verifierMode: "local",
        })
      )
      .then((builder) => {
        if (finished) {
          cleanup();
          return;
        }
        const request = builder
          .gte("age", 18)
          .bind("custom_data", intent.digest)
          .done();
        request.onRequestReceived(() => {
          if (!finished) onEvent({ event: "request_received" });
        });
        request.onGeneratingProof(() => {
          if (!finished) onEvent({ event: "generating_proof" });
        });
        request.onReject(() => finish({ summary: emptySummary("rejected") }));
        request.onError(() => finish({ summary: emptySummary("error") }));
        request.onSuccess((response) => {
          if (finished || processing) return;
          processing = true;
          onEvent({ event: "proof_received_verifying_math" });
          void inspectReceivedProofs(response, client, verifier, intent).then(
            finish,
            () => finish({ summary: emptySummary("error") })
          );
        });
        onEvent({ event: "request_ready", url: request.url });
      })
      .catch(() => finish({ summary: emptySummary("error") }));
  });
}
