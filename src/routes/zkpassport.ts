import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Deps } from "../context.js";
import { nowIso } from "../db.js";
import { newId } from "../ids.js";
import { sepJwtAuth, type SepContext, type SepEnv } from "../sepauth.js";
import {
  createNativePassportVerifier,
  PASSPORT_INPUT_BYTES,
  PASSPORT_PROOF_BYTES,
  PASSPORT_VERIFIER,
  PASSPORT_VK_HASH,
  type ProofStatus,
} from "../zkpassport.js";

const hex = (bytes: number) =>
  z.string().regex(new RegExp(`^(?:0x)?[0-9a-fA-F]{${bytes * 2}}$`));
const submission = z
  .object({
    proof: hex(PASSPORT_PROOF_BYTES),
    public_inputs: hex(PASSPORT_INPUT_BYTES),
  })
  .strict();
const decode = (value: string) => Buffer.from(value.replace(/^0x/, ""), "hex");
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");

interface ProofRow {
  id: string;
  stellar_subject: string;
  proof_sha256: string;
  public_inputs_sha256: string;
  verifier_contract: string;
  math_status: ProofStatus;
  verification_ledger: number | null;
  created_at: string;
}

function response(row: ProofRow) {
  return {
    ...row,
    execution_method: "rpc_simulation",
    network: "testnet",
    eligibility_status: "unbound",
    payout_authorized: false,
  };
}

export function zkpassportRoutes(deps: Deps, sep: SepContext) {
  const app = new Hono<SepEnv>();
  const verifier =
    deps.passportVerifier ?? createNativePassportVerifier(deps.cfg);
  app.get("/zkpassport/info", (c) =>
    c.json({
      anchor_mode: deps.cfg.anchorMode,
      verifier_contract: PASSPORT_VERIFIER,
      vk_hash: PASSPORT_VK_HASH,
      circuit_version: "0.20.0",
      outer_circuit: "OuterCount5",
      proof_bytes: PASSPORT_PROOF_BYTES,
      public_input_bytes: PASSPORT_INPUT_BYTES,
      network: "testnet",
      execution_method: "rpc_simulation",
      eligibility_status: "unbound",
      payout_authorized: false,
    })
  );
  app.use("/zkpassport/proofs*", sepJwtAuth(deps, sep));
  app.post(
    "/zkpassport/proofs",
    bodyLimit({
      maxSize: 24_576,
      onError: (c) => c.json({ error: "proof_request_too_large" }, 413),
    }),
    async (c) => {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "invalid_json" }, 400);
      }
      const parsed = submission.safeParse(raw);
      if (!parsed.success)
        return c.json(
          {
            error: "invalid_proof_encoding",
            proof_bytes: PASSPORT_PROOF_BYTES,
            public_input_bytes: PASSPORT_INPUT_BYTES,
          },
          400
        );
      const proof = decode(parsed.data.proof);
      const publicInputs = decode(parsed.data.public_inputs);
      const result = await verifier
        .verify(proof, publicInputs)
        .catch(() => ({
          status: "verifier_unavailable" as const,
          ledger: null,
        }));
      const row: ProofRow = {
        id: newId("zpf"),
        stellar_subject: c.get("sepSub"),
        proof_sha256: digest(proof),
        public_inputs_sha256: digest(publicInputs),
        verifier_contract: PASSPORT_VERIFIER,
        math_status: result.status,
        verification_ledger: result.ledger,
        created_at: nowIso(),
      };
      // Authentication identifies the submitter; it does not bind the proof to that wallet.
      deps.db
        .prepare(
          `INSERT INTO passport_proofs(id, customer_id, stellar_subject, proof_sha256, public_inputs_sha256, verifier_contract, math_status, verification_ledger, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          row.id,
          c.get("sepCustomer").id,
          row.stellar_subject,
          row.proof_sha256,
          row.public_inputs_sha256,
          row.verifier_contract,
          row.math_status,
          row.verification_ledger,
          row.created_at
        );
      return c.json(
        response(row),
        result.status === "math_valid"
          ? 201
          : result.status === "invalid"
            ? 422
            : 503
      );
    }
  );
  app.get("/zkpassport/proofs/:id", (c) => {
    const row = deps.db
      .prepare(
        `SELECT id, stellar_subject, proof_sha256, public_inputs_sha256, verifier_contract, math_status, verification_ledger, created_at
      FROM passport_proofs WHERE id = ? AND customer_id = ? AND stellar_subject = ?`
      )
      .get(
        c.req.param("id"),
        c.get("sepCustomer").id,
        c.get("sepSub")
      ) as unknown as ProofRow | undefined;
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(response(row));
  });
  return app;
}
