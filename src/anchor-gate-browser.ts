import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";

export function anchorGateBrowserRoutes(
  publicUrl: string,
  directory = process.env.PUBLIC_DIR ?? join(process.cwd(), "public")
) {
  const app = new Hono();
  const expected = new URL(publicUrl);
  for (const path of ["/anchor-gate", "/anchor-gate/bundle.js"])
    app.use(path, async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("X-Content-Type-Options", "nosniff");
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
      );
      if (new URL(c.req.url).host !== expected.host)
        return c.text("Use the configured anchor origin.", 403);
      await next();
    });
  app.get("/anchor-gate", async (c) =>
    c.html(await readFile(join(directory, "anchor-gate.html"), "utf8"))
  );
  app.get("/anchor-gate/bundle.js", async (c) =>
    c.body(await readFile(join(directory, "anchor-gate.js"), "utf8"), 200, {
      "Content-Type": "application/javascript; charset=utf-8",
    })
  );
  return app;
}
