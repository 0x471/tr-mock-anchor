import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  createDiagnosticIntent,
  inspectReceivedProofs,
  type DiagnosticCapture,
  type DiagnosticSummary,
  type PassportRequestClient,
  type RequestOptions,
} from "./zkpassport-request.js";
import type { PassportVerifier } from "./zkpassport.js";

export const BROWSER_PROOF_BODY_LIMIT = 256 * 1024;

export interface BrowserDiagnosticDependencies {
  options: RequestOptions;
  port: number;
  client: PassportRequestClient;
  verifier: PassportVerifier;
  html: string;
  bundle: string;
  now?: () => number;
  saveCapture?: (
    capture: DiagnosticCapture,
    summary: DiagnosticSummary
  ) => Promise<void>;
}

export function createBrowserDiagnosticApp(
  deps: BrowserDiagnosticDependencies
) {
  if (
    deps.options.domain !== "localhost" ||
    !deps.options.devMode ||
    !Number.isInteger(deps.port) ||
    deps.port < 1 ||
    deps.port > 65535 ||
    deps.options.timeoutSeconds < 1 ||
    deps.options.timeoutSeconds > 600
  ) {
    throw new Error(
      "Browser diagnostics require localhost, synthetic mode and a bounded timeout."
    );
  }
  const now = deps.now ?? Date.now;
  const intent = createDiagnosticIntent(deps.options, now());
  const host = `localhost:${deps.port}`;
  const origin = `http://${host}`;
  const app = new Hono();
  let cancelled = false;
  let received = false;

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https: wss:; img-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    );
    if (c.req.header("host") !== host)
      return c.json({ error: "invalid_host" }, 403);
    if (c.req.method === "POST" && c.req.header("origin") !== origin)
      return c.json({ error: "invalid_origin" }, 403);
    if (cancelled || now() >= intent.expiresAt * 1000)
      return c.json({ error: "session_closed" }, 410);
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: BROWSER_PROOF_BODY_LIMIT,
      onError: (c) => c.json({ error: "body_too_large" }, 413),
    })
  );
  app.get("/", (c) => c.html(deps.html));
  app.get("/bundle.js", (c) =>
    c.body(deps.bundle, 200, {
      "Content-Type": "application/javascript; charset=utf-8",
    })
  );
  app.get("/config", (c) =>
    c.json({
      domain: intent.domain,
      scope: intent.scope,
      digest: intent.digest,
      expiresAt: intent.expiresAt,
    })
  );
  app.post("/cancel", (c) => {
    cancelled = true;
    return c.json({ cancelled: true, payout_authorized: false });
  });
  app.post("/proof", async (c) => {
    if (received) return c.json({ error: "proof_already_received" }, 409);
    if (
      !c.req
        .header("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return c.json({ error: "json_required" }, 415);
    let record: unknown;
    try {
      record = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    // Uploading may outlive cancellation or expiry; do not send such proofs to RPC.
    if (cancelled || now() >= intent.expiresAt * 1000)
      return c.json({ error: "session_closed" }, 410);
    if (received) return c.json({ error: "proof_already_received" }, 409);
    // A compressed request expects one outer proof. Do not replace an earlier capture.
    received = true;
    const result = await inspectReceivedProofs(
      { proofs: [record] },
      deps.client,
      deps.verifier,
      intent,
      now()
    );
    if (cancelled || now() >= intent.expiresAt * 1000)
      return c.json({ error: "session_closed" }, 410);
    const normalizedSummary: DiagnosticSummary = {
      ...result.summary,
      proofs_received: 1,
      last_milestone: "proof_received_verifying_math",
    };
    let exportSaved = false;
    if (deps.saveCapture && result.capture) {
      await deps.saveCapture(result.capture, normalizedSummary);
      exportSaved = true;
    }
    const { proofs: _metadata, ...summary } = normalizedSummary;
    return c.json({
      ...summary,
      export_saved: exportSaved,
    });
  });
  app.onError((_error, c) =>
    c.json({ error: "diagnostic_failed", payout_authorized: false }, 500)
  );
  return app;
}
