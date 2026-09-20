import {
  getAddress,
  getNetworkDetails,
  isConnected,
  requestAccess,
  signTransaction,
  WatchWalletChanges,
} from "@stellar/freighter-api";
import { ZKPassport, VERSION } from "@zkpassport/sdk";
import { countryCodeAlpha3ToName } from "@zkpassport/utils";
import QRCode from "qrcode";
import {
  createAnchorGateFlow,
  type GatePhone,
  type GateWallet,
} from "./anchor-gate-flow.js";

const element = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const button = (id: string) => element<HTMLButtonElement>(id);
let busy = false;
let qrUrl = "";
let renderingQr = 0;
const steps = ["wallet", "quote", "proof", "settle"] as const;
type Step = (typeof steps)[number];
let selectedStep: Step = "wallet";
let lastProgress: Step = "wallet";
let lastOrderId = "";
let lastQuoteId = "";
let lastTransactions = "";

const wallet: GateWallet = {
  async connect() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const available = await Promise.race([
      isConnected().catch(() => ({ isConnected: false })),
      new Promise<{ isConnected: boolean }>((resolve) => {
        timeout = setTimeout(() => resolve({ isConnected: false }), 3000);
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!available.isConnected || ("error" in available && available.error))
      throw new Error(
        "Freighter is unavailable in this browser. Open this page in a browser with the Freighter extension installed and enabled, then select Stellar Testnet."
      );
    const result = await requestAccess();
    if (result.error || !result.address)
      throw new Error("Freighter connection was declined or unavailable.");
    return result.address;
  },
  async current() {
    const [address, network] = await Promise.all([
      getAddress(),
      getNetworkDetails(),
    ]);
    if (address.error || network.error)
      throw new Error("Freighter account or network is unavailable.");
    return { address: address.address, network: network.networkPassphrase };
  },
  async sign(transaction, address) {
    const result = await signTransaction(transaction, {
      address,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    if (result.error || !result.signedTxXdr || result.signerAddress !== address)
      throw new Error("Freighter did not sign with the selected wallet.");
    return result.signedTxXdr;
  },
};

const phone: GatePhone = {
  async request(config, events) {
    if (
      VERSION !== "0.17.1" ||
      config.domain !== window.location.hostname ||
      !config.dev_mode
    )
      throw new Error("Unsupported synthetic browser request.");
    const client = new ZKPassport(config.domain);
    const builder = await client.request({
      name: "Stellar Proof-Gated Anchor",
      purpose:
        "Prove this order's age and country eligibility with a synthetic document. Simulated TRY and Testnet tokens only.",
      scope: config.scope,
      mode: "compressed-evm",
      devMode: true,
      validity: config.policy.max_proof_age,
      uniqueIdentifierType: 0,
      verifierMode: "local",
    });
    const supported = (
      code: string
    ): code is Parameters<typeof builder.in>[1][number] =>
      /^[A-Z]{3}$/.test(code) && !!countryCodeAlpha3ToName(code);
    const codes = (values: string[]) =>
      values.map((code) => {
        if (!supported(code))
          throw new Error("The configured country is unsupported by this SDK.");
        return code;
      });
    builder.gte("age", config.policy.min_age);
    if (config.policy.allowed_nationalities.length)
      builder.in("nationality", codes(config.policy.allowed_nationalities));
    if (config.policy.allowed_issuers.length)
      builder.in("issuing_country", codes(config.policy.allowed_issuers));
    const request = builder.bind("custom_data", config.custom_data).done();
    request.onBridgeConnect(() =>
      events.event("Phone relay connected. Awaiting your consent.")
    );
    request.onRequestReceived(() =>
      events.event(
        "Secure phone channel established. Review the policy on your phone."
      )
    );
    request.onGeneratingProof(() =>
      events.event(
        "Your phone is generating the proof. No eligibility is granted yet."
      )
    );
    request.onBridgeConnectionLost(() =>
      events.event("Phone connection interrupted. No new approval is assumed.")
    );
    request.onError(() =>
      events.event(
        "The phone reported an error. Cancel and request a fresh proof if needed."
      )
    );
    request.onReject(() => events.rejected());
    request.onProofGenerated((proof) => {
      void events.proof(proof);
    });
    const timer = setTimeout(
      () => {
        client.clearAllRequests();
        events.rejected();
      },
      Math.max(0, config.expires_at * 1000 - Date.now())
    );
    return {
      url: request.url,
      cancel() {
        clearTimeout(timer);
        client.clearAllRequests();
      },
    };
  },
};

const flow = createAnchorGateFlow({
  origin: window.location.origin,
  fetch: window.fetch.bind(window),
  wallet,
  phone,
  changed: render,
});

function render() {
  const {
    info,
    wallet: address,
    order,
    quote,
    prepared,
    phoneUrl,
    message,
    direction,
  } = flow.view;
  const now = Math.floor(Date.now() / 1000);
  const recoveryOnly = flow.recoveryOnly;
  const withdrawal = direction === "withdrawal";
  const tokenName = info?.buy_asset.split(":")[1] ?? "tokens";
  const authorized =
    !!order &&
    order.direction === "withdrawal" &&
    ["payout_authorized", "paid"].includes(order.stage) &&
    order.escrowed &&
    order.payout_authorized_at !== null;
  let statusMessage = message;
  element("wallet").textContent = address || "No wallet connected.";
  for (const choice of ["deposit", "withdrawal"] as const) {
    const control = button(`choose-${choice}`);
    control.setAttribute("aria-pressed", String(choice === direction));
    control.disabled =
      busy || !!order || recoveryOnly || flow.view.reservationPending;
  }
  element("destination-box").hidden = !withdrawal;
  const destinationInput = element<HTMLInputElement>("bank-destination");
  destinationInput.disabled =
    busy || !!order || recoveryOnly || flow.view.reservationPending;
  if (order) destinationInput.value = order.bank_destination ?? "";
  element("amount-label").textContent = withdrawal
    ? `Mock ${tokenName} amount to escrow`
    : "Simulated TRY amount";
  const amountInput = element<HTMLInputElement>("amount");
  amountInput.disabled =
    busy || !!quote || !!order || recoveryOnly || flow.view.reservationPending;
  if (order && order.id !== lastOrderId)
    amountInput.value = withdrawal ? order.amount_token : order.amount_try;
  else if (quote && quote.id !== lastQuoteId)
    amountInput.value = quote.sell_amount;
  lastQuoteId = quote?.id ?? "";
  element("amount-unit").textContent = withdrawal ? tokenName : "TRY";
  element("amount-hint").textContent = withdrawal
    ? "Requesting or accepting a quote does not debit your wallet. The first accepted proof transaction escrows the exact quoted tokens."
    : "Requesting a quote does not move funds. Accepting a deposit quote reserves the provider's exact tokens.";
  element("quote-heading").textContent = withdrawal
    ? "Get your withdrawal quote"
    : "Get your deposit quote";
  element("settle-heading").textContent = withdrawal
    ? "Complete the withdrawal"
    : "Complete the deposit";
  element("settle-subtitle").textContent = withdrawal
    ? "Authorize the simulated payout, record it, then settle escrow."
    : "Simulate the bank receipt. Receive tokens in your wallet.";
  element("blueprint-heading").textContent = withdrawal
    ? `Withdraw / ${tokenName} to TRY`
    : `Deposit / TRY to ${tokenName}`;
  element("flow-from").textContent = withdrawal
    ? "Testnet wallet"
    : "Simulated bank";
  element("flow-to").textContent = withdrawal
    ? "Simulated bank"
    : "Testnet wallet";
  element("wallet-state").textContent = address
    ? "Authenticated"
    : "Not connected";
  element("wallet-state").setAttribute(
    "data-state",
    address ? "confirmed" : "idle"
  );
  element("summary-wallet").textContent = address
    ? `${address.slice(0, 6)}...${address.slice(-5)}`
    : "Not connected";
  element("summary-wallet").title = address;
  const tokenAmount =
    order?.amount_token ??
    (withdrawal ? quote?.sell_amount : quote?.buy_amount);
  const tryAmount =
    order?.amount_try ?? (withdrawal ? quote?.buy_amount : quote?.sell_amount);
  const sent = withdrawal
    ? tokenAmount
      ? `${tokenAmount} mock ${tokenName}`
      : "Awaiting quote"
    : tryAmount
      ? `${tryAmount} simulated TRY`
      : "Awaiting quote";
  const received = withdrawal
    ? tryAmount
      ? `${tryAmount} simulated TRY`
      : "Awaiting quote"
    : tokenAmount
      ? `${tokenAmount} mock ${tokenName}`
      : "Awaiting quote";
  element("summary-send").textContent = sent;
  element("summary-receive").textContent = received;
  element("quote-card").hidden = !quote;
  if (info) {
    const policy = info.config.policy;
    element("policy-age").textContent = `${policy.min_age}+`;
    element("policy-nationality").textContent =
      policy.allowed_nationalities.join(", ") || "No predicate";
    element("policy-issuer").textContent =
      policy.allowed_issuers.join(", ") || "No predicate";
    element("policy").textContent =
      `Age: at least ${policy.min_age}\nNationality: ${policy.allowed_nationalities.join(", ") || "No nationality predicate"}\nDocument issuer: ${policy.allowed_issuers.join(", ") || "No issuing-country predicate"}\nSynthetic documents only. Policy expires ${new Date(info.config.policy_valid_until * 1000).toLocaleString()}.${recoveryOnly ? "\nRECOVERY ONLY: policy expired. Connect to refresh or finish an already-authorized withdrawal. New quotes, orders, proofs and payout authorizations are disabled." : ""}`;
  } else {
    for (const id of ["policy-age", "policy-nationality", "policy-issuer"])
      element(id).textContent = "Unavailable";
    element("policy").textContent =
      message === "Loading Testnet policy."
        ? "Loading the immutable onchain policy..."
        : "The onchain policy is unavailable or not configured for this origin. Wallet login, proof requests and settlement remain disabled.";
  }
  element("quote-result").textContent = quote
    ? `Pay ${quote.sell_amount} ${withdrawal ? `Testnet ${tokenName}` : "simulated TRY"}\nReceive ${quote.buy_amount} ${withdrawal ? "simulated TRY" : `Testnet ${tokenName}`}\nFee included: ${quote.fee.total} ${withdrawal ? tokenName : "TRY"}\nQuote expires ${new Date(quote.expires_at).toLocaleTimeString()}`
    : "";
  element("order").textContent = order
    ? `Order ${order.id}\nDirection: ${order.direction}\nStatus: ${order.stage}${order.expired && !order.completed ? (authorized ? " (proof window expired; authorized payout may finish)" : " (expired; no refund is implied)") : ""}\nWallet: ${order.recipient}\n${withdrawal ? `${order.amount_token} Testnet ${tokenName} -> ${order.amount_try} simulated TRY` : `${order.amount_try} simulated TRY -> ${order.amount_token} Testnet ${tokenName}`}\nToken: ${order.token}\nVault: ${order.contract}${withdrawal ? `\nSynthetic beneficiary: ${order.bank_destination}\nBeneficiary commitment: ${order.bank_destination_hash}\nToken escrow recorded: ${order.escrowed ? "yes" : "no"}` : ""}\nProof deadline: ${new Date(order.deadline * 1000).toLocaleString()}${order.confirmed_ledger === null ? "" : `\nConfirmed ledger: ${order.confirmed_ledger}`}${order.eligibility_expires_at ? `\nEligibility until: ${new Date(order.eligibility_expires_at * 1000).toLocaleTimeString()}` : ""}`
    : "No order reserved.";
  if ((order?.id ?? "") !== lastOrderId) {
    element<HTMLInputElement>("order-id").value = order?.id ?? "";
    lastOrderId = order?.id ?? "";
  }
  const wait =
    order?.created_at == null ? 0 : Math.max(0, order.created_at + 30 - now);
  const stockAdultMock =
    info?.config.policy.mock_only === true &&
    info.config.policy.min_age === 18 &&
    info.config.policy.allowed_nationalities.length === 1 &&
    info.config.policy.allowed_nationalities[0] === "ZKR" &&
    info.config.policy.allowed_issuers.length === 1 &&
    info.config.policy.allowed_issuers[0] === "ZKR";
  element("proof-help").textContent = recoveryOnly
    ? "Recovery only: this expired policy accepts no new phone proofs. Resume an existing order to inspect its confirmed state."
    : wait
      ? `Wait ${wait}s before creating the phone request so its source-chain timestamp can follow order creation.`
      : authorized || order?.completed
        ? "This order no longer accepts a phone proof. Its authorized completion follows the recorded bank and settlement states."
        : stockAdultMock
          ? "For this 18+/ZKR/ZKR policy, use ZKPassport developer mode and select the stock adult mock document John Smith: synthetic date of birth 1995-11-12, nationality ZKR, document issuer ZKR. Do not use a real ID. A phone proof is not onchain approval; the contract must verify the exact order policy."
          : "Use ZKPassport developer mode with a synthetic document matching the exact age, nationality and issuing-country policy in the exchange summary. Do not use a real ID. A phone proof is not onchain approval. Refresh an expired eligibility grant without changing this order.";
  element("proof-consent").textContent = withdrawal
    ? order?.escrowed
      ? "A refresh verifies a new proof for this same escrow. It must not debit tokens again. Only confirmed chain state grants eligibility."
      : `IMPORTANT: signing the first proof transaction also authorizes the vault to debit exactly ${order?.amount_token ?? "the quoted amount of"} Testnet ${tokenName} from your wallet into escrow. Expiry does not imply a refund. Receiving a phone proof is not approval.`
    : "Receiving a proof is not approval. Freighter signs the exact onchain invocation; only confirmed contract state unlocks the next step.";
  element("bank").textContent = withdrawal
    ? order?.receipt_id
      ? `SIMULATED PAYOUT RECORDED\nMock-bank receipt: ${order.receipt_id}\n${order.completed ? "Escrow settlement to the provider is confirmed." : "Simulated payout is not yet escrow settlement."}`
      : order?.mock_bank_credit
        ? `MOCK-BANK CREDIT RECORDED LOCALLY\n${order.mock_bank_credit.amount_try} simulated TRY to ${order.mock_bank_credit.destination}\nOnchain receipt is not yet confirmed. Reconcile the existing payout; do not create a replacement order.`
        : authorized
          ? `SIMULATED PAYOUT AUTHORIZED\n${order.amount_try} TRY to ${order.bank_destination}\nNo real bank transfer will occur. This authorization permits completion after the proof deadline.`
          : "Simulated TRY payout remains locked until native eligibility, token escrow and onchain payout authorization are confirmed."
    : order?.bank_instructions && !recoveryOnly
      ? `SIMULATED BANK RECEIPT ONLY\nExact amount: ${order.bank_instructions.amount_try} TRY\nReference: ${order.bank_instructions.reference}\nDo not make a real bank transfer.`
      : order?.receipt_id
        ? `Mock-bank receipt recorded: ${order.receipt_id}\n${order.completed ? "Testnet settlement confirmed." : "Receipt is not itself settlement."}`
        : "Bank instructions remain locked until native eligibility is confirmed.";
  element("settlement-help").textContent = withdrawal
    ? "Authorize simulated payout while eligibility is current. The mock-bank notary records one synthetic credit; settlement then transfers the exact escrow to the provider. An authorized payout cannot be replaced by a new proof."
    : "The bank notary attests simulated receipt separately. Settlement cannot change the recipient, asset or reserved amount.";
  const live =
    !!order &&
    !recoveryOnly &&
    !order.expired &&
    order.deadline > now &&
    !order.completed;
  const eligible =
    live &&
    !!order.eligibility_expires_at &&
    order.eligibility_expires_at > now;
  const pendingProof = order?.actions.some(
    (action) => action.kind === "prove" && action.status === "pending"
  );
  const pending = !!order?.actions.some(
    (action) => action.status === "pending"
  );
  const pendingOtherAction = !!order?.actions.some(
    (action) =>
      action.status === "pending" &&
      !(
        prepared &&
        action.kind === "prove" &&
        action.id === prepared.action_id &&
        action.transaction_hash === prepared.hash
      )
  );
  const quoteExpired = !!quote && Date.parse(quote.expires_at) <= now * 1000;
  button("connect").disabled = busy || !info || !!address;
  button("disconnect").disabled =
    flow.view.reservationPending || (!address && !busy);
  button("quote").disabled =
    busy ||
    !address ||
    !!order ||
    recoveryOnly ||
    flow.view.reservationPending ||
    !!quote;
  button("edit-quote").hidden = !quote || !!order;
  button("edit-quote").disabled =
    busy || recoveryOnly || flow.view.reservationPending;
  button("reserve").disabled =
    busy ||
    !address ||
    !quote ||
    !!order ||
    (recoveryOnly && !flow.view.reservationPending) ||
    (quoteExpired && !flow.view.reservationPending);
  button("reserve").textContent = flow.view.reservationPending
    ? "Retry original reservation"
    : "Accept quote + reserve order";
  button("prove").disabled =
    busy ||
    !address ||
    !live ||
    !(
      withdrawal ? ["created", "eligible"] : ["created", "eligible", "funded"]
    ).includes(order.stage) ||
    order.created_at === null ||
    wait > 0 ||
    !!phoneUrl ||
    !!pendingProof ||
    pending;
  button("cancel-proof").disabled = !phoneUrl;
  button("sign-proof").disabled =
    busy ||
    pendingOtherAction ||
    !prepared ||
    prepared.expires_at <= now ||
    !live;
  button("sign-proof").textContent =
    pending && prepared && !pendingOtherAction
      ? "Sign or retry exact proof transaction"
      : withdrawal && !order?.escrowed
        ? "Sign native proof + exact token escrow"
        : "Sign native proof transaction";
  button("authorize-payout").hidden = !withdrawal;
  button("authorize-payout").disabled =
    busy ||
    pending ||
    !eligible ||
    order?.stage !== "eligible" ||
    !order.escrowed;
  button("bank-action").textContent = withdrawal
    ? order?.mock_bank_credit
      ? "Reconcile simulated payout receipt"
      : "Record simulated TRY payout"
    : "Record simulated TRY receipt";
  button("bank-action").disabled =
    busy ||
    pending ||
    (withdrawal
      ? !authorized || order?.stage !== "payout_authorized"
      : !eligible || order?.stage !== "eligible" || !order.bank_instructions);
  button("settle").textContent = withdrawal
    ? "Settle escrow to provider"
    : "Settle Testnet tokens to wallet";
  button("settle").disabled =
    busy ||
    pending ||
    !order?.receipt_id ||
    (withdrawal
      ? !authorized || order.stage !== "paid"
      : !eligible || order.stage !== "funded");
  button("refresh").disabled =
    busy ||
    !address ||
    flow.view.reservationPending ||
    !/^[a-f0-9]{64}$/.test(element<HTMLInputElement>("order-id").value.trim());
  button("resume-order").disabled = button("refresh").disabled;
  const proofAccepted = !!order?.eligibility_expires_at;
  const state = (
    id: string,
    label: string,
    value: "confirmed" | "pending" | "idle"
  ) => {
    element(id).textContent = label;
    element(id).setAttribute("data-state", value);
  };
  state(
    "check-proof",
    proofAccepted
      ? eligible
        ? "Eligible"
        : "Accepted earlier"
      : pendingProof
        ? "Pending"
        : "Not verified",
    eligible ? "confirmed" : proofAccepted || pendingProof ? "pending" : "idle"
  );
  state(
    "check-receipt",
    order?.receipt_id
      ? "Confirmed"
      : order?.mock_bank_credit
        ? "Local credit only"
        : "Not recorded",
    order?.receipt_id
      ? "confirmed"
      : order?.mock_bank_credit
        ? "pending"
        : "idle"
  );
  state(
    "check-settlement",
    order?.completed ? "Settled" : pending ? "Action pending" : "Not settled",
    order?.completed ? "confirmed" : pending ? "pending" : "idle"
  );
  element("order-state").textContent = order
    ? `${order.direction} / ${order.stage.replaceAll("_", " ")}${order.expired && !order.completed ? " / deadline passed" : ""}`
    : flow.view.reservationPending
      ? "Reservation outcome unknown / retry same request"
      : "No order reserved";
  element("completion").hidden = !order?.completed;
  element("completion-amount").textContent = order?.completed
    ? `${sent} -> ${received}`
    : "";
  element("settlement-next").textContent = order?.completed
    ? "No further payment is needed. Review the transaction evidence. To begin again, return to Wallet and clear the session; existing records remain unchanged."
    : pending && prepared && !pendingOtherAction
      ? "Return to Verify to sign or retry only the exact prepared proof transaction. Its outcome is not yet confirmed."
      : pending
        ? "The transaction outcome is not confirmed. Use Check status before attempting another action."
        : authorized
          ? "This fixed payout is already authorized. Finish its receipt and settlement, even if the proof window has expired."
          : order?.expired
            ? "The order deadline passed. Held tokens are not automatically refunded. Check status; do not create a replacement payment."
            : "Each step unlocks only after the previous onchain state is confirmed.";
  const progress: Step = !address
    ? "wallet"
    : !order
      ? "quote"
      : order.completed || eligible || authorized
        ? "settle"
        : "proof";
  if (progress !== lastProgress) {
    selectedStep = progress;
    lastProgress = progress;
  }
  for (const step of steps) {
    const control = button(`step-${step}`);
    control.disabled =
      busy ||
      (step === "quote"
        ? !address
        : step === "proof" || step === "settle"
          ? !order
          : false);
    if (selectedStep === step) control.setAttribute("aria-current", "step");
    else control.removeAttribute("aria-current");
    element(`panel-${step}`).hidden = selectedStep !== step;
  }
  element("status-label").textContent = busy
    ? "WORKING"
    : element("status").classList.contains("error")
      ? "ATTENTION"
      : order?.completed
        ? "COMPLETE"
        : recoveryOnly
          ? "RECOVERY ONLY"
          : "NEXT STEP";
  if (!busy && !element("status").classList.contains("error")) {
    if (flow.view.reservationPending)
      statusMessage =
        "Reservation outcome unknown. Retry the original reservation with the same terms. Do not request a replacement quote or clear this session.";
    else if (pending && prepared && !pendingOtherAction)
      statusMessage =
        "The exact prepared proof transaction is not confirmed. Sign or retry that same transaction, or use Check status if you already submitted it.";
    else if (pending)
      statusMessage =
        "The transaction outcome is not confirmed. Select Check status to reconcile this order.";
    else if (quoteExpired && !order)
      statusMessage =
        "This quote expired. Select Edit amount and request a fresh quote before reserving.";
  }
  if (element("status").textContent !== statusMessage)
    element("status").textContent = statusMessage;
  const transactions = element("transactions");
  element("transactions-empty").hidden = !!order?.actions.length;
  const transactionState = JSON.stringify(order?.actions ?? []);
  if (transactionState !== lastTransactions) {
    lastTransactions = transactionState;
    transactions.replaceChildren();
    for (const action of order?.actions ?? []) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `https://stellar.expert/explorer/testnet/tx/${action.transaction_hash}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = `${action.kind}: ${action.status}${action.ledger === null ? "" : ` / ledger ${action.ledger}`} / ${action.transaction_hash.slice(0, 12)}...`;
      item.append(link);
      transactions.append(item);
    }
  }
  if (recoveryOnly && phoneUrl) {
    flow.cancelPhone();
    return;
  }
  element("phone-box").hidden = !phoneUrl;
  if (phoneUrl !== qrUrl) {
    qrUrl = phoneUrl;
    const generation = ++renderingQr;
    const canvas = element<HTMLCanvasElement>("qr");
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    const link = element<HTMLAnchorElement>("phone-link");
    link.removeAttribute("href");
    if (phoneUrl) {
      const url = new URL(phoneUrl);
      if (url.protocol !== "https:" || url.hostname !== "zkpassport.id") {
        flow.cancelPhone();
        return;
      }
      link.href = phoneUrl;
      void QRCode.toCanvas(canvas, phoneUrl, {
        width: 384,
        margin: 4,
        errorCorrectionLevel: "M",
      }).catch(() => {
        if (generation === renderingQr)
          element("status").textContent =
            "QR rendering failed. Use the private request link.";
      });
    }
  }
}

async function run(action: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  const previousStep = selectedStep;
  element("status").classList.remove("error");
  render();
  try {
    await action();
  } catch (error) {
    element("status").classList.add("error");
    flow.view.message =
      error instanceof Error && error.name !== "ZodError"
        ? error.message
        : "The anchor returned an unavailable or unsupported policy/response. No payout is assumed.";
  } finally {
    busy = false;
    render();
    if (previousStep !== selectedStep)
      element(`${selectedStep}-heading`).focus({ preventScroll: true });
  }
}

button("connect").onclick = () => {
  void run(() => flow.connect());
};
button("disconnect").onclick = () => {
  flow.disconnect();
};
button("quote").onclick = () => {
  void run(() => flow.quote(element<HTMLInputElement>("amount").value.trim()));
};
button("reserve").onclick = () => {
  void run(() =>
    flow.createOrder(
      flow.view.direction === "withdrawal"
        ? element<HTMLInputElement>("bank-destination").value.trim()
        : undefined
    )
  );
};
for (const direction of ["deposit", "withdrawal"] as const) {
  button(`choose-${direction}`).onclick = () => {
    if (busy || button(`choose-${direction}`).disabled) return;
    flow.selectDirection(direction);
    element<HTMLInputElement>("amount").value = "";
  };
}
button("edit-quote").onclick = () => {
  if (busy || button("edit-quote").disabled) return;
  flow.clearQuote();
  element("amount").focus();
};
for (const step of steps) {
  button(`step-${step}`).onclick = () => {
    if (button(`step-${step}`).disabled) return;
    selectedStep = step;
    render();
    element(`${step}-heading`).focus({ preventScroll: true });
  };
}
element<HTMLInputElement>("order-id").oninput = () => render();
button("prove").onclick = () => {
  void run(() => flow.requestProof());
};
button("cancel-proof").onclick = () => flow.cancelPhone();
button("sign-proof").onclick = () => {
  void run(() => flow.signProof());
};
button("bank-action").onclick = () => {
  void run(() => flow.simulateBank());
};
button("authorize-payout").onclick = () => {
  void run(() => flow.authorizePayout());
};
button("settle").onclick = () => {
  void run(() => flow.settle());
};
const refreshOrder = () => {
  void run(() =>
    flow.refresh(element<HTMLInputElement>("order-id").value.trim())
  );
};
button("refresh").onclick = refreshOrder;
button("resume-order").onclick = refreshOrder;
button("copy-link").onclick = () => {
  if (flow.view.phoneUrl)
    void navigator.clipboard.writeText(flow.view.phoneUrl).catch(() => {
      flow.view.message =
        "Clipboard unavailable. Use the request link beside the QR.";
      render();
    });
};
const watcher = new WatchWalletChanges();
watcher.watch((state) => {
  if (
    flow.view.wallet &&
    (state.error ||
      state.address !== flow.view.wallet ||
      state.networkPassphrase !== "Test SDF Network ; September 2015")
  )
    flow.disconnect();
});
const timer = setInterval(render, 1000);
window.addEventListener("pagehide", () => {
  clearInterval(timer);
  watcher.stop();
  flow.disconnect();
});
void run(() => flow.initialize());
