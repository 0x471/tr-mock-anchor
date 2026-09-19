import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { Deps } from "../context.js";
import { ApiError } from "../errors.js";
import { sepJwtAuth, type SepContext, type SepEnv } from "../sepauth.js";
import { verifyJwt } from "../jwt.js";
import { createGatedAnchor } from "../anchor-gate.js";

export function anchorGateRoutes(deps: Deps, sep: SepContext) {
  const app = new Hono<SepEnv>();
  const gate =
    deps.cfg.anchorMode === "zkpassport" &&
    deps.cfg.networkPassphrase === Networks.TESTNET
      ? deps.anchorGate
      : undefined;
  const anchor = gate ? createGatedAnchor(deps, gate) : undefined;
  app.use("/anchor-gate/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(deps.cfg.publicUrl).origin)
      throw new ApiError(
        403,
        "invalid_origin",
        "Use the configured anchor origin."
      );
    await next();
  });
  app.get("/anchor-gate/info", async (c) =>
    c.json({
      enabled: !!gate,
      network: "testnet",
      network_passphrase: Networks.TESTNET,
      sell_asset: "iso4217:TRY",
      buy_asset: `stellar:${deps.cfg.usdcCode}:${deps.cfg.usdcIssuer}`,
      max_fee_stroops: deps.cfg.anchorGateMaxFeeStroops,
      ...(gate ? { config: await gate.configuration() } : {}),
    })
  );
  app.use("/anchor-gate/orders*", async (c, next) => {
    if (!anchor)
      throw new ApiError(
        503,
        "gate_unavailable",
        "The proof-gated vault is not configured."
      );
    const token = (c.req.header("authorization") ?? "").replace(
      /^Bearer\s+/i,
      ""
    );
    const claims = verifyJwt(token, sep.jwtSecret);
    let header: { alg?: string; typ?: string } = {};
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(token.split(".")[0] ?? "", "base64url").toString()
      );
      if (parsed && typeof parsed === "object") header = parsed;
    } catch {
      /* Invalid credentials fail closed below. */
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      claims.iss !== `${deps.cfg.publicUrl}/auth` ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.iat < 0 ||
      claims.iat > now + 30 ||
      claims.exp <= now
    )
      throw new ApiError(
        403,
        "authentication_required",
        "A valid SEP-10 wallet session is required."
      );
    if (!StrKey.isValidEd25519PublicKey(claims.sub))
      throw new ApiError(
        422,
        "recipient_unsupported",
        "This vault requires a plain G account without a memo."
      );
    return sepJwtAuth(deps, sep)(c, next);
  });
  app.use(
    "/anchor-gate/orders*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: { code: "body_too_large" } }, 413),
    })
  );
  let pendingMutation = Promise.resolve();
  app.use("/anchor-gate/orders*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const previous = pendingMutation;
    let release!: () => void;
    pendingMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await next();
    } finally {
      release();
    }
  });
  app.post("/anchor-gate/orders", async (c) => {
    const parsed = z
      .object({
        quote_id: z.string().min(1).max(100),
        direction: z.enum(["deposit", "withdrawal"]).default("deposit"),
        bank_destination: z
          .string()
          .regex(/^demo:[A-Za-z0-9_-]{1,64}$/)
          .optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    const key = c.req.header("idempotency-key") ?? "";
    if (!parsed.success || !/^[A-Za-z0-9._:-]{1,100}$/.test(key))
      throw new ApiError(
        400,
        "invalid_order_request",
        "Provide quote_id and an Idempotency-Key header."
      );
    return c.json(
      await anchor!.create(
        c.get("sepSub"),
        c.get("sepCustomer").id,
        parsed.data.quote_id,
        key,
        parsed.data.direction,
        parsed.data.bank_destination
      ),
      201
    );
  });
  app.get("/anchor-gate/orders/:id", async (c) =>
    c.json(await anchor!.get(c.req.param("id"), c.get("sepSub")))
  );
  app.get("/anchor-gate/orders/:id/proof-request", async (c) =>
    c.json(await anchor!.proofRequest(c.req.param("id"), c.get("sepSub")))
  );
  app.post("/anchor-gate/orders/:id/prepare-proof", async (c) => {
    const hex = z
      .string()
      .regex(/^(?:[0-9a-f]{2})+$/)
      .max(22000);
    const parsed = z
      .object({ proof: hex, public_inputs: hex })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiError(
        400,
        "invalid_proof_request",
        "Provide proof and public_inputs as lowercase hexadecimal without 0x."
      );
    return c.json(
      await anchor!.prepareProof(
        c.req.param("id"),
        c.get("sepSub"),
        Buffer.from(parsed.data.proof, "hex"),
        Buffer.from(parsed.data.public_inputs, "hex")
      )
    );
  });
  app.post("/anchor-gate/orders/:id/submit", async (c) => {
    const parsed = z
      .object({
        action_id: z.string().regex(/^[0-9a-f]{32}$/),
        signed_transaction: z.string().min(1).max(100000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiError(
        400,
        "invalid_submission",
        "Provide action_id and signed_transaction."
      );
    return c.json(
      await anchor!.submitProof(
        c.req.param("id"),
        c.get("sepSub"),
        parsed.data.action_id,
        parsed.data.signed_transaction
      )
    );
  });
  app.post("/anchor-gate/orders/:id/simulate-bank", async (c) =>
    c.json(await anchor!.simulateBank(c.req.param("id"), c.get("sepSub")))
  );
  app.post("/anchor-gate/orders/:id/authorize-payout", async (c) =>
    c.json(await anchor!.authorizePayout(c.req.param("id"), c.get("sepSub")))
  );
  app.post("/anchor-gate/orders/:id/settle", async (c) =>
    c.json(await anchor!.settle(c.req.param("id"), c.get("sepSub")))
  );
  return app;
}
