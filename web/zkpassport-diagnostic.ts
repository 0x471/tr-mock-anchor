import { ZKPassport, VERSION } from "@zkpassport/sdk";

const progress = document.querySelector<HTMLPreElement>("#progress")!;
const summary = document.querySelector<HTMLPreElement>("#summary")!;
const link = document.querySelector<HTMLAnchorElement>("#request-url")!;
const startButton = document.querySelector<HTMLButtonElement>("#start")!;
let client: ZKPassport | undefined;
let stopped = false;
let started = false;
let submitted = false;
let count = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function milestone(event: string) {
  if (stopped) return;
  progress.textContent += `${new Date().toISOString()} ${event} proofs_received=${count}\n`;
}

function stop(event: string, notify = true) {
  if (stopped) return;
  milestone(event);
  stopped = true;
  clearTimeout(timer);
  client?.clearAllRequests();
  link.removeAttribute("href");
  startButton.disabled = true;
  if (notify)
    void fetch("/cancel", { method: "POST", keepalive: true }).catch(() => {});
}

window.addEventListener("pagehide", () => stop("page_closed"));
document
  .querySelector("#cancel")!
  .addEventListener("click", () => stop("cancelled"));
startButton.addEventListener("click", () => {
  if (started || stopped) return;
  started = true;
  startButton.disabled = true;
  void start().catch(() => stop("request_setup_failed"));
});

async function start() {
  if (VERSION !== "0.17.1" || window.location.hostname !== "localhost")
    throw new Error("Unsupported diagnostic runtime");
  const response = await fetch("/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Session unavailable");
  const config = await response.json();
  if (
    config.domain !== "localhost" ||
    !/^[a-f0-9]{64}$/.test(config.digest) ||
    typeof config.expiresAt !== "number" ||
    config.expiresAt * 1000 <= Date.now()
  )
    throw new Error("Invalid diagnostic intent");
  if (stopped) return;
  timer = setTimeout(
    () => stop("expired"),
    Math.max(0, config.expiresAt * 1000 - Date.now())
  );
  // No Origin override: the browser supplies its real HTTP Origin to the relay.
  client = new ZKPassport(window.location.hostname);
  const builder = await client.request({
    name: "Stellar Anchor Diagnostic",
    purpose: "Test proof compatibility only. No identity approval or payout.",
    scope: config.scope,
    mode: "compressed-evm",
    devMode: true,
    validity: 3600,
    uniqueIdentifierType: 0,
    verifierMode: "local",
  });
  if (stopped) {
    client.clearAllRequests();
    return;
  }
  const request = builder
    .gte("age", 18)
    .bind("custom_data", config.digest)
    .done();
  request.onBridgeConnect(() => milestone("bridge_connected"));
  request.onBridgeConnectionLost(() => milestone("bridge_connection_lost"));
  request.onRequestReceived(() => milestone("secure_channel_established"));
  request.onGeneratingProof(() => milestone("generating_proof"));
  request.onReject(() => stop("rejected"));
  request.onError(() => milestone("sdk_error"));
  request.onSuccess(() => {
    milestone("sdk_result_received_not_approval");
  });
  request.onProofGenerated((proof) => {
    if (stopped) return;
    count += 1;
    milestone("proof_received");
    if (submitted) {
      milestone("additional_proof_not_submitted");
      return;
    }
    submitted = true;
    void fetch("/proof", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(proof),
    })
      .then(async (result) => {
        if (stopped) return;
        if (!result.ok) {
          milestone("inspection_failed");
          return;
        }
        const inspected = await result.json();
        if (stopped) return;
        summary.textContent = JSON.stringify(inspected, null, 2);
        milestone("native_inspection_complete_not_approval");
        stop("diagnostic_complete");
      })
      .catch(() => milestone("inspection_failed"));
  });
  link.href = request.url;
  link.textContent = request.url;
  milestone("request_ready");
}
