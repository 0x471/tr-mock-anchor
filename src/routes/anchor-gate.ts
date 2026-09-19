import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Networks, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import type { Deps } from "../context.js";
import { ApiError } from "../errors.js";
import { sepJwtAuth, type SepContext, type SepEnv } from "../sepauth.js";
import { verifyJwt } from "../jwt.js";
import { createGatedOnramp } from "../anchor-gate.js";

export function anchorGateRoutes(deps: Deps, sep: SepContext) {
  const app = new Hono<SepEnv>();
  const gate =
    deps.cfg.anchorMode === "zkpassport" &&
    deps.cfg.networkPassphrase === Networks.TESTNET
      ? deps.anchorGate
      : undefined;
  const onramp = gate ? createGatedOnramp(deps, gate) : undefined;
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
      ...(gate ? { config: await gate.configuration() } : {}),
    })
  );
  app.use("/anchor-gate/orders*", async (c, next) => {
    if (!onramp)
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
      header = JSON.parse(
        Buffer.from(token.split(".")[0] ?? "", "base64url").toString()
      );
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
  app.post("/anchor-gate/orders", async (c) => {
    const parsed = z
      .object({ quote_id: z.string().min(1).max(100) })
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
      await onramp!.create(
        c.get("sepSub"),
        c.get("sepCustomer").id,
        parsed.data.quote_id,
        key
      ),
      201
    );
  });
  app.get("/anchor-gate/orders/:id", async (c) =>
    c.json(await onramp!.get(c.req.param("id"), c.get("sepSub")))
  );
  return app;
}
