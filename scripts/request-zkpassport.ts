import { lstat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Networks } from "@stellar/stellar-sdk";
import { createNativePassportVerifier } from "../src/zkpassport.js";
import {
  loadPassportRequestClient,
  parseRequestOptions,
  runPassportRequest,
} from "../src/zkpassport-request.js";

const HELP = `Usage: tsx scripts/request-zkpassport.ts --domain example.org --dev-mode
  [--scope stellar-anchor-compatibility-v1] [--recipient G_PUBLIC_ACCOUNT]
  [--timeout-seconds 600] [--out /absolute/scratch/proof-export.json]

Synthetic identity diagnostic on Stellar Testnet only. Requires @zkpassport/sdk 0.17.1.
Requests age >=18 plus a random diagnostic binding; does not authorize a payout.
The phone chooses its circuit version; this command cannot pin it.
Default: summary only. --out saves sensitive proof/public-input material, never raw passport data.
The output file must not exist; its parent directory must already exist.
Known compatible proof/public inputs are sent to Testnet RPC for read-only simulation.
`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(HELP);
    return 0;
  }
  const options = parseRequestOptions(args);
  if (options.out) {
    options.out = resolve(options.out);
    try {
      await lstat(options.out);
      throw new Error("--out already exists; refusing to overwrite it.");
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  }
  const client = loadPassportRequestClient(options.domain);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    console.log(
      "Diagnostic only; no payout or identity approval. Known proof public inputs go to Testnet RPC simulation."
    );
    const result = await runPassportRequest(
      options,
      client,
      createNativePassportVerifier({
        rpcUrl: "https://soroban-testnet.stellar.org",
        networkPassphrase: Networks.TESTNET,
      }),
      (event) => console.log(JSON.stringify(event)),
      controller.signal
    );
    if (options.out && result.capture) {
      await writeFile(
        options.out,
        `${JSON.stringify({ ...result.capture, summary: result.summary }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 }
      );
      console.log(
        JSON.stringify({ event: "proof_export_saved", path: options.out })
      );
    }
    console.log(JSON.stringify(result.summary, null, 2));
    if (result.summary.outcome === "interrupted") return 130;
    return result.summary.outcome === "received" &&
      result.summary.math_status === "math_valid" &&
      result.summary.request_checks &&
      Object.values(result.summary.request_checks).every(Boolean)
      ? 0
      : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    client.clearAllRequests();
  }
}

void main().then(
  (code) => {
    process.exitCode = code;
    // The SDK may leave pending reconnect timers after cancellation; enforce bounded CLI lifetime.
    setTimeout(() => process.exit(code), 1000).unref();
  },
  (error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Diagnostic failed."
    );
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1000).unref();
  }
);
