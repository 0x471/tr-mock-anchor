import { lstat, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { serve } from "@hono/node-server";
import { Networks } from "@stellar/stellar-sdk";
import { createBrowserDiagnosticApp } from "../src/zkpassport-browser.js";
import {
  loadPassportRequestClient,
  parseRequestOptions,
} from "../src/zkpassport-request.js";
import { createNativePassportVerifier } from "../src/zkpassport.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: tsx scripts/serve-zkpassport.ts --dev-mode [--port 8792] [--timeout-seconds 600] [--out /absolute/new-proof-export.json]\nBrowser-origin synthetic diagnostic only; no payout. Open http://localhost:8792, not 127.0.0.1. Optional export contains sensitive proof/public inputs and is created once with mode0600."
    );
    return;
  }
  let port = 8792;
  const filtered: string[] = [];
  let portSeen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
      const text = args[++i];
      if (portSeen || !text || !/^\d+$/.test(text))
        throw new Error("Invalid --port.");
      port = Number(text);
      portSeen = true;
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("Invalid --port.");
    } else filtered.push(args[i]!);
  }
  const options = parseRequestOptions(["--domain", "localhost", ...filtered]);
  if (options.scope !== "stellar-anchor-compatibility-v1")
    throw new Error("This browser diagnostic uses a fixed scope.");
  if (options.out) {
    options.out = resolve(options.out);
    try {
      await lstat(options.out);
      throw new Error("--out exists; refusing overwrite.");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["web/zkpassport-diagnostic.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    write: false,
    minify: true,
    logLevel: "silent",
  });
  const code = bundle.outputFiles[0]?.text;
  if (!code) throw new Error("Browser bundle unavailable.");
  const client = loadPassportRequestClient("localhost");
  const app = createBrowserDiagnosticApp({
    options,
    port,
    client,
    html: await readFile(
      resolve(root, "web/zkpassport-diagnostic.html"),
      "utf8"
    ),
    bundle: code,
    verifier: createNativePassportVerifier({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: Networks.TESTNET,
    }),
    saveCapture: options.out
      ? async (capture, summary) => {
          await writeFile(
            options.out!,
            `${JSON.stringify({ ...capture, summary }, null, 2)}\n`,
            { flag: "wx", mode: 0o600 }
          );
          console.log(JSON.stringify({ event: "proof_export_saved" }));
        }
      : undefined,
  });
  const server = serve(
    { fetch: app.fetch, hostname: "127.0.0.1", port },
    () => {
      console.log(
        JSON.stringify({
          event: "browser_diagnostic_ready",
          url: `http://localhost:${port}`,
          payout_authorized: false,
        })
      );
    }
  );
  const shutdown = () => {
    clearTimeout(timer);
    client.clearAllRequests();
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  };
  const timer = setTimeout(shutdown, options.timeoutSeconds * 1000);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.on("error", () => {
    console.error("Browser diagnostic server failed.");
    shutdown();
    process.exitCode = 1;
  });
}

void main().catch(() => {
  console.error(
    "Unable to start browser diagnostic. Check options, output path and dependencies."
  );
  process.exitCode = 1;
});
