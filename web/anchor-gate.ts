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
import {
  createTestnetWalletSetup,
  type TestnetAsset,
  type WalletReadiness,
} from "./anchor-wallet-setup.js";

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
let setupEpoch = 0;
let setupState: { address: string; state: WalletReadiness } | undefined;
let automaticCheck: Promise<void> | undefined;
let nextAutomaticCheck = 0;
let automaticFailures = 0;
let automaticProblem = "";
let pageClosed = false;

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
    await walletSetup.ensureFunding(result.address);
    return result.address;
  },
  async current() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const [address, network] = await Promise.race([
      Promise.all([getAddress(), getNetworkDetails()]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                "Freighter is not responding. Unlock it, then try again."
              )
            ),
          3000
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (address.error || network.error)
      throw new Error("Freighter account or network is unavailable.");
    return { address: address.address, network: network.networkPassphrase };
  },
  async sign(transaction, address) {
    await walletSetup.ensureFunding(address);
    const result = await signTransaction(transaction, {
      address,
      networkPassphrase: "Test SDF Network ; September 2015",
    });
    if (result.error || !result.signedTxXdr || result.signerAddress !== address)
      throw new Error("Freighter did not sign with the selected wallet.");
    return result.signedTxXdr;
  },
};

const walletSetup = createTestnetWalletSetup({
  fetch: window.fetch.bind(window),
  wallet,
  changed(message) {
    flow.view.message = message;
    render();
  },
});

function configuredAsset(): TestnetAsset {
  const info = flow.view.info;
  if (!info) throw new Error("The Testnet asset is not configured.");
  const [protocol, code, issuer, extra] = info.buy_asset.split(":");
  if (protocol !== "stellar" || !code || !issuer || extra !== undefined)
    throw new Error("The Testnet asset is unsupported.");
  return { code, issuer, contract: info.config.token };
}

function resetWalletSetup() {
  setupEpoch++;
  setupState = undefined;
  automaticFailures = 0;
  automaticProblem = "";
  nextAutomaticCheck = 0;
}

async function inspectWalletSetup(addTrustline = false) {
  const address = flow.view.wallet;
  if (!address) throw new Error("Connect your Testnet wallet first.");
  const epoch = setupEpoch;
  const asset = configuredAsset();
  await walletSetup.ensureFunding(address);
  if (epoch !== setupEpoch || address !== flow.view.wallet)
    throw new Error("Wallet session changed. Connect again.");
  const state = addTrustline
    ? await walletSetup.addTrustline(address, asset)
    : await walletSetup.inspect(address, asset);
  if (epoch !== setupEpoch || address !== flow.view.wallet)
    throw new Error("Wallet session changed. Connect again.");
  setupState = { address, state };
  render();
  return state;
}

function requireTrustline(state: WalletReadiness) {
  if (!state.funded || !state.trustline || !state.authorized || state.pending)
    throw new Error(
      "Finish the mock-USDC setup in Wallet before reserving an order. Existing orders can still be resumed."
    );
}

function tokenUnits(value: string): bigint {
  if (!/^\d+(?:\.\d{1,7})?$/.test(value))
    throw new Error("The wallet returned an invalid token amount.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10000000n + BigInt(fraction.padEnd(7, "0"));
}

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
    screening,
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
  const readiness =
    setupState?.address === address ? setupState.state : undefined;
  const walletReady =
    !!readiness?.funded &&
    readiness.trustline &&
    readiness.authorized &&
    !readiness.pending;
  const screeningReady = !screening || screening.status === "no_match";
  const exchangeReady = walletReady && screeningReady;
  element("wallet").textContent = address || "No wallet connected.";
  element("wallet-card").hidden = !address;
  element("session-options").hidden = !address;
  element("wallet-heading").textContent = !address
    ? "Connect your wallet"
    : !screeningReady
      ? "Review the address precheck"
      : walletReady
        ? "Wallet connected"
        : "Set up your Testnet wallet";
  element("wallet-intro").textContent = !address
    ? "Use Freighter on Stellar Testnet. Signing in does not move funds."
    : !screeningReady
      ? "New exchanges are paused. You can still resume an existing order."
      : walletReady
        ? "Testnet funds and the demo asset are ready."
        : "Test XLM is automatic. Approve the demo asset once in Freighter.";
  element("wallet-setup").hidden = !address;
  element("wallet-setup-status").textContent = !readiness
    ? "Checking your wallet. If interrupted, select Check wallet setup."
    : readiness.pending
      ? "Waiting for Testnet to confirm the demo asset. Checking automatically; no extra signature needed."
      : !readiness.trustline
        ? `${readiness.balance} test XLM available. Add the mock USDC asset to continue.`
        : !readiness.authorized
          ? "This asset is not authorized by its issuer. Contact the demo operator."
          : `Ready: ${readiness.balance} test XLM and ${readiness.tokenBalance} mock USDC.`;
  element("wallet-asset").textContent = info
    ? `Asset: ${tokenName}\nIssuer: ${info.buy_asset.split(":")[2]}`
    : "";
  button("setup-wallet").hidden =
    !address || !!readiness?.trustline || !!readiness?.pending;
  button("setup-wallet").disabled = busy || !address || !readiness;
  button("check-wallet").disabled = busy || !address;
  element("ofac-check").hidden = !address || !screening;
  element("ofac-status").textContent = !screening
    ? ""
    : screening.status === "no_match"
      ? "No listed-address match. This does not establish identity or sanctions compliance."
      : screening.status === "match"
        ? "Listed-address match. New exchanges are blocked; contact the demo operator. Existing orders can still be resumed."
        : "Address precheck unavailable. New exchanges are paused; recheck before continuing. Existing orders can still be resumed.";
  element("ofac-source").textContent = screening
    ? `Source: ${screening.source}\nPublished: ${screening.published_at ?? "unavailable"}\nFetched: ${screening.fetched_at ?? "unavailable"}\nChecked: ${screening.checked_at}\n${screening.fetched_at && screening.digest ? `SDN lists ${screening.stellar_address_count} Stellar addresses; no-match is not identity clearance.` : "List coverage unavailable; no address-clearance conclusion is possible."} This is a backend address precheck, not an onchain identity check.`
    : "";
  button("check-ofac").disabled = busy || !address || !screening;
  const setupLink = element<HTMLAnchorElement>("wallet-setup-tx");
  setupLink.hidden = !readiness?.transactionHash;
  if (readiness?.transactionHash)
    setupLink.href = `https://stellar.expert/explorer/testnet/tx/${readiness.transactionHash}`;
  else setupLink.removeAttribute("href");
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
    ? "No tokens move until you sign the proof transaction."
    : "No funds move yet. Accepting reserves the quoted tokens.";
  element("quote-heading").textContent = quote
    ? "Review your quote"
    : withdrawal
      ? `How much ${tokenName}?`
      : "How much TRY?";
  element("quote-inputs").hidden = !!quote;
  element("settle-heading").textContent = withdrawal
    ? "Complete the withdrawal"
    : "Complete the deposit";
  element("settle-subtitle").textContent = order?.completed
    ? "Your exchange is confirmed on Testnet."
    : withdrawal
      ? order?.receipt_id
        ? "The simulated payout is recorded. Release escrow to finish."
        : authorized
          ? "Record the simulated TRY payout."
          : "Authorize the simulated TRY payout."
      : order?.receipt_id
        ? `The simulated deposit is recorded. Receive mock ${tokenName}.`
        : "Record a simulated bank transfer to continue.";
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
  element("order-summary").hidden = !order;
  element("order-summary").textContent = order ? `${sent} -> ${received}` : "";
  element("quote-card").hidden = !quote;
  element("exchange-summary").hidden = !quote && !order;
  element("exchange").setAttribute("data-summary", String(!!quote || !!order));
  if (info) {
    const policy = info.config.policy;
    element("policy-age").textContent = `${policy.min_age}+`;
    element("policy-nationality").textContent =
      policy.allowed_nationalities.join(", ") || "No predicate";
    element("policy-issuer").textContent =
      policy.allowed_issuers.join(", ") || "No predicate";
    element("proof-requirements").textContent =
      `Age ${policy.min_age}+ / Nationality: ${policy.allowed_nationalities.join(", ") || "any"} / Document issuer: ${policy.allowed_issuers.join(", ") || "any"}`;
    element("quote-requirements").textContent =
      element("proof-requirements").textContent;
    element("policy").textContent =
      `Age: at least ${policy.min_age}\nNationality: ${policy.allowed_nationalities.join(", ") || "No nationality predicate"}\nDocument issuer: ${policy.allowed_issuers.join(", ") || "No issuing-country predicate"}\nSynthetic documents only. Policy expires ${new Date(info.config.policy_valid_until * 1000).toLocaleString()}.${recoveryOnly ? "\nRECOVERY ONLY: policy expired. Connect to refresh or finish an already-authorized withdrawal. New quotes, orders, proofs and payout authorizations are disabled." : ""}`;
  } else {
    for (const id of ["policy-age", "policy-nationality", "policy-issuer"])
      element(id).textContent = "Unavailable";
    element("proof-requirements").textContent =
      "Document requirements unavailable.";
    element("quote-requirements").textContent =
      "Document requirements unavailable.";
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
  if (order?.receipt_id)
    element("order").textContent +=
      `\nSimulated bank receipt ID (not a transaction hash): ${order.receipt_id}`;
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
      ? `Preparing a fresh phone request: ${wait}s. This short delay keeps the proof newer than your order. No action needed yet.`
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
      ? `Simulated TRY payout recorded.\n${order.completed ? "Escrow settlement to the provider is confirmed." : "Release the escrow to complete your withdrawal."}`
      : order?.mock_bank_credit
        ? `MOCK-BANK CREDIT RECORDED LOCALLY\n${order.mock_bank_credit.amount_try} simulated TRY to ${order.mock_bank_credit.destination}\nOnchain receipt is not yet confirmed. Reconcile the existing payout; do not create a replacement order.`
        : authorized
          ? `SIMULATED PAYOUT AUTHORIZED\n${order.amount_try} TRY to ${order.bank_destination}\nNo real bank transfer will occur. This authorization permits completion after the proof deadline.`
          : "Simulated TRY payout remains locked until native eligibility, token escrow and onchain payout authorization are confirmed."
    : order?.bank_instructions && !recoveryOnly
      ? `SIMULATED BANK RECEIPT ONLY\nExact amount: ${order.bank_instructions.amount_try} TRY\nReference: ${order.bank_instructions.reference}\nDo not make a real bank transfer.`
      : order?.receipt_id
        ? `Simulated TRY deposit recorded.\n${order.completed ? "Your mock USDC transfer is confirmed on Testnet." : "Receive your mock USDC to complete the exchange."}`
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
  const orderExpired =
    !!order && !order.completed && (order.expired || order.deadline <= now);
  const preparedExpired = !!prepared && prepared.expires_at <= now;
  const retryablePrepared =
    !!prepared && !preparedExpired && live && !pendingOtherAction;
  const expiredOrderMessage = authorized
    ? "The proof window expired. This already-authorized simulated payout can still finish."
    : "The order deadline passed. Held tokens are not automatically refunded. We are checking its recorded state automatically.";
  const recoveryMessage =
    "The policy expired. Only existing-order recovery and already-authorized payouts remain available.";
  const registrationFailed =
    order?.stage === "registering" &&
    order.actions.filter((action) => action.kind === "create").at(-1)
      ?.status === "failed";
  const registrationFailure =
    "Reservation transaction failed. Contact the demo operator to recover this exact order; do not create a replacement.";
  element("proof-instruction").textContent = registrationFailed
    ? registrationFailure
    : order?.stage === "registering"
      ? "Reserving your quoted exchange on Testnet. This updates automatically; no action needed."
      : pending && !retryablePrepared
        ? "Waiting for Testnet confirmation. We check automatically; no action needed."
        : orderExpired
          ? expiredOrderMessage
          : recoveryOnly
            ? recoveryMessage
            : preparedExpired
              ? "This signature request expired. Show a new QR code to try again."
              : prepared
                ? "Phone proof ready. Sign in Freighter to verify it onchain."
                : phoneUrl
                  ? "Scan with ZKPassport, then approve on your phone. Keep this page open."
                  : wait
                    ? `Preparing your phone request. Ready in ${wait}s. No action needed yet.`
                    : !live
                      ? "This order cannot accept a new proof. Check its status below."
                      : "Select Show QR code, then scan with ZKPassport. Use a matching synthetic document.";
  button("connect").disabled = busy || !info || !!address;
  button("connect").hidden = !!address;
  button("disconnect").hidden = !address;
  button("disconnect").disabled =
    flow.view.reservationPending || (!address && !busy);
  button("quote").disabled =
    busy ||
    !address ||
    !exchangeReady ||
    !!order ||
    recoveryOnly ||
    flow.view.reservationPending ||
    !!quote;
  button("quote").hidden = !!quote || !!order;
  button("edit-quote").hidden = !quote || !!order;
  button("edit-quote").disabled =
    busy || recoveryOnly || flow.view.reservationPending;
  button("reserve").disabled =
    busy ||
    !address ||
    (!exchangeReady && !flow.view.reservationPending) ||
    !quote ||
    !!order ||
    (recoveryOnly && !flow.view.reservationPending) ||
    (quoteExpired && !flow.view.reservationPending);
  button("reserve").hidden = !quote || !!order;
  button("reserve").textContent = flow.view.reservationPending
    ? "Retry original reservation"
    : "Accept quote";
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
  button("prove").hidden =
    !order ||
    !!order.completed ||
    authorized ||
    !!phoneUrl ||
    (!!prepared && !preparedExpired) ||
    pending;
  button("cancel-proof").disabled = !phoneUrl;
  button("cancel-proof").hidden = !phoneUrl;
  element("signature-box").hidden = !prepared;
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
        ? "Sign proof + escrow tokens"
        : "Sign proof in Freighter";
  button("authorize-payout").hidden =
    !withdrawal || !eligible || order?.stage !== "eligible" || !order.escrowed;
  button("authorize-payout").disabled =
    busy ||
    pending ||
    !eligible ||
    order?.stage !== "eligible" ||
    !order.escrowed;
  button("bank-action").textContent = withdrawal
    ? order?.mock_bank_credit
      ? "Reconcile simulated payout receipt"
      : "Simulate TRY payout"
    : "Simulate TRY deposit";
  button("bank-action").disabled =
    busy ||
    pending ||
    (withdrawal
      ? !authorized || order?.stage !== "payout_authorized"
      : !eligible || order?.stage !== "eligible" || !order.bank_instructions);
  button("bank-action").hidden = withdrawal
    ? !authorized || order?.stage !== "payout_authorized"
    : !eligible || order?.stage !== "eligible" || !order.bank_instructions;
  button("settle").textContent = withdrawal
    ? "Release escrow to provider"
    : `Receive mock ${tokenName}`;
  button("settle").disabled =
    busy ||
    pending ||
    !order?.receipt_id ||
    (withdrawal
      ? !authorized || order.stage !== "paid"
      : !eligible || order.stage !== "funded");
  button("settle").hidden =
    !order?.receipt_id ||
    (withdrawal
      ? !authorized || order.stage !== "paid"
      : !eligible || order.stage !== "funded");
  button("refresh").disabled =
    busy ||
    !address ||
    flow.view.reservationPending ||
    !/^[a-f0-9]{64}$/.test(element<HTMLInputElement>("order-id").value.trim());
  button("refresh").hidden = !order || (order.completed && !pending);
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
    ? "No further payment is needed. Your transaction records are below."
    : pending && retryablePrepared
      ? "Return to Verify to sign the exact prepared proof. We also check its status automatically; its outcome is not confirmed."
      : pending
        ? "The transaction outcome is not confirmed. Checking automatically; no action needed."
        : authorized
          ? "This fixed payout is already authorized. Finish its receipt and settlement, even if the proof window has expired."
          : order?.expired
            ? "The order deadline passed. Held tokens are not automatically refunded. Checking automatically; do not create a replacement payment."
            : eligible
              ? "Your proof is verified onchain. Only the simulated bank step and token settlement remain."
              : "";
  const progress: Step =
    !address || (!order && !exchangeReady && !flow.view.reservationPending)
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
        ? !address ||
          (!exchangeReady && !flow.view.reservationPending && !order)
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
    else if (order?.completed)
      statusMessage = pending
        ? "Exchange complete. Updating the transaction evidence automatically. No further payment is needed."
        : "Exchange complete. The token transfer is confirmed on Testnet.";
    else if (pending && retryablePrepared)
      statusMessage =
        "The exact proof transaction is not confirmed. Sign it in Freighter when ready. If already signed, leave this page open while we check automatically.";
    else if (pending)
      statusMessage =
        "The transaction outcome is not confirmed. Checking Testnet automatically; no action needed.";
    else if (registrationFailed) statusMessage = registrationFailure;
    else if (order?.stage === "registering")
      statusMessage =
        "Reserving your exchange on Testnet. Checking automatically; no action needed.";
    else if (orderExpired) statusMessage = expiredOrderMessage;
    else if (recoveryOnly) statusMessage = recoveryMessage;
    else if (preparedExpired)
      statusMessage =
        "This signature request expired. Show a new QR code to prepare a fresh proof.";
    else if (quoteExpired && !order)
      statusMessage =
        "This quote expired. Select Change amount and request a fresh quote before reserving.";
  }
  if (automaticProblem && !busy) statusMessage = automaticProblem;
  if (element("status").textContent !== statusMessage)
    element("status").textContent = statusMessage;
  if (element("status-announcement").textContent !== statusMessage)
    element("status-announcement").textContent = statusMessage;
  element("status-bar").hidden =
    !busy &&
    !element("status").classList.contains("error") &&
    !pending &&
    !flow.view.reservationPending &&
    !recoveryOnly &&
    !(quoteExpired && !order) &&
    !orderExpired &&
    !phoneUrl &&
    !prepared &&
    !wait &&
    order?.stage !== "registering" &&
    !automaticProblem &&
    !/phone|proof|clipboard|QR|session cleared/i.test(statusMessage);
  const transactions = element("transactions");
  element("testnet-activity").hidden = !order;
  const actionName = (kind: string) =>
    ({
      create: "Order reservation",
      prove: "ZKPassport proof verification",
      receipt: "Simulated bank receipt",
      authorize: "Payout authorization",
      settle: "Token settlement",
    })[kind] ?? "Testnet action";
  const latest = order?.actions.at(-1);
  const latestLink = element<HTMLAnchorElement>("latest-transaction");
  latestLink.hidden = !latest;
  if (latest) {
    latestLink.href = `https://stellar.expert/explorer/testnet/tx/${latest.transaction_hash}`;
    latestLink.textContent = `View ${actionName(latest.kind).toLowerCase()}`;
  } else latestLink.removeAttribute("href");
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
      const outcome =
        action.status === "success"
          ? "Confirmed"
          : action.status === "failed"
            ? "Failed"
            : action.status === "prepared"
              ? "Prepared - not confirmed"
              : "Not confirmed yet";
      link.textContent = `${actionName(action.kind)}: ${outcome}${action.ledger === null ? "" : ` / ledger ${action.ledger}`}`;
      link.title = action.transaction_hash;
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

async function run(action: () => Promise<unknown>, progress?: string) {
  if (busy || pageClosed) return;
  busy = true;
  const epoch = setupEpoch;
  const previousStep = selectedStep;
  const focusedControl = document.activeElement;
  element("status").classList.remove("error");
  if (progress) flow.view.message = progress;
  render();
  try {
    await automaticCheck;
    if (pageClosed || epoch !== setupEpoch) return;
    await action();
    if (!pageClosed && epoch === setupEpoch) {
      automaticProblem = "";
      automaticFailures = 0;
    }
  } catch (error) {
    if (pageClosed || epoch !== setupEpoch) return;
    element("status").classList.add("error");
    flow.view.message =
      error instanceof Error && error.name !== "ZodError"
        ? error.message
        : "The anchor returned an unavailable or unsupported policy/response. No payout is assumed.";
  } finally {
    busy = false;
    nextAutomaticCheck = Date.now() + 3000;
    render();
    if (
      !pageClosed &&
      (previousStep !== selectedStep || focusedControl?.closest("[hidden]"))
    )
      element(`${selectedStep}-heading`).focus({ preventScroll: true });
  }
}

async function checkAutomatically() {
  const { wallet: address, order, reservationPending } = flow.view;
  const pendingSetup =
    setupState?.address === address && setupState.state.pending;
  if (
    pageClosed ||
    busy ||
    automaticCheck ||
    !address ||
    (!order && !pendingSetup) ||
    (order?.completed &&
      !order.actions.some(
        (action) => action.status === "pending" || action.status === "prepared"
      )) ||
    reservationPending ||
    document.visibilityState === "hidden" ||
    Date.now() < nextAutomaticCheck
  )
    return;
  const epoch = setupEpoch;
  const focusedControl = document.activeElement;
  const current = () =>
    !pageClosed &&
    epoch === setupEpoch &&
    flow.view.wallet === address &&
    flow.view.order?.id === order?.id;
  automaticCheck = (async () => {
    try {
      if (pendingSetup) {
        const state = await walletSetup.inspect(address, configuredAsset());
        if (!current()) return;
        setupState = { address, state };
        if (!state.pending) {
          element("status").classList.remove("error");
          flow.view.message =
            state.trustline && state.authorized
              ? "Mock-USDC setup confirmed. Choose your exchange amount."
              : "Wallet setup is incomplete. Add the demo asset in Freighter.";
        }
      } else if (order) {
        const previousState = JSON.stringify(order);
        await flow.refresh(order.id, { quiet: true });
        if (current() && previousState !== JSON.stringify(flow.view.order))
          element("status").classList.remove("error");
      }
      if (!current()) return;
      automaticFailures = 0;
      automaticProblem = "";
    } catch {
      if (!current()) return;
      automaticFailures++;
      automaticProblem =
        "Status check interrupted. Retrying automatically; the last confirmed state is unchanged. Do not repeat a payment.";
    } finally {
      automaticCheck = undefined;
      if (current()) {
        nextAutomaticCheck =
          Date.now() + Math.min(30_000, 5000 * 2 ** automaticFailures);
        render();
        if (
          !busy &&
          document.activeElement === focusedControl &&
          focusedControl?.closest("[hidden]")
        )
          element(`${selectedStep}-heading`).focus({ preventScroll: true });
      }
    }
  })();
  await automaticCheck;
}

button("connect").onclick = () => {
  resetWalletSetup();
  void run(async () => {
    await flow.connect();
    await inspectWalletSetup();
  });
};
button("disconnect").onclick = () => {
  resetWalletSetup();
  flow.disconnect();
  element("wallet-heading").focus({ preventScroll: true });
};
button("quote").onclick = () => {
  void run(async () => {
    requireTrustline(await inspectWalletSetup());
    await flow.quote(element<HTMLInputElement>("amount").value.trim());
  });
};
button("reserve").onclick = () => {
  void run(async () => {
    if (!flow.view.reservationPending) {
      const state = await inspectWalletSetup();
      requireTrustline(state);
      const quote = flow.view.quote;
      if (!quote) throw new Error("Request a quote first.");
      if (
        flow.view.direction === "deposit" &&
        tokenUnits(state.receivable) < tokenUnits(quote.buy_amount)
      )
        throw new Error(
          "The mock-USDC trustline has insufficient receiving capacity. Update it in Freighter before reserving."
        );
      if (
        flow.view.direction === "withdrawal" &&
        tokenUnits(state.spendableToken) < tokenUnits(quote.sell_amount)
      )
        throw new Error(
          "Not enough mock USDC for this withdrawal. Deposit first or choose a smaller amount."
        );
    }
    await flow.createOrder(
      flow.view.direction === "withdrawal"
        ? element<HTMLInputElement>("bank-destination").value.trim()
        : undefined
    );
  });
};
button("setup-wallet").onclick = () => {
  void run(async () => {
    const state = await inspectWalletSetup(true);
    if (state.pending) {
      flow.view.message =
        "Waiting for Testnet to confirm wallet setup. Checking automatically.";
      return;
    }
    requireTrustline(state);
    flow.view.message =
      "Mock-USDC setup confirmed on Testnet. Request your quote.";
  });
};
button("check-wallet").onclick = () => {
  void run(async () => {
    const state = await inspectWalletSetup();
    flow.view.message = state.pending
      ? "Wallet setup is still unconfirmed. Check again before retrying."
      : "Wallet setup refreshed.";
  });
};
button("check-ofac").onclick = () => {
  void run(() => flow.checkAccess());
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
  void run(
    () => flow.requestProof(),
    "Creating your private ZKPassport request. Please wait."
  );
};
button("cancel-proof").onclick = () => {
  flow.view.message = "Phone request cancelled. Show a new QR code when ready.";
  flow.cancelPhone();
  element(
    button("prove").hidden || button("prove").disabled
      ? "proof-heading"
      : "prove"
  ).focus({ preventScroll: true });
};
button("sign-proof").onclick = () => {
  const expected = flow.view.prepared?.hash;
  void run(async () => {
    if (
      expected &&
      flow.view.order?.actions.some(
        (action) =>
          action.transaction_hash === expected && action.status === "success"
      )
    )
      return;
    await flow.signProof();
  }, "Approve the proof transaction in Freighter. Then we will check Testnet confirmation automatically.");
};
button("bank-action").onclick = () => {
  void run(
    () => flow.simulateBank(),
    "Recording the simulated bank transfer on Testnet. No real bank transfer occurs."
  );
};
button("authorize-payout").onclick = () => {
  void run(
    () => flow.authorizePayout(),
    "Authorizing this exact simulated TRY payout on Testnet. Please wait."
  );
};
button("settle").onclick = () => {
  void run(
    () => flow.settle(),
    "Completing your token transfer on Testnet. We will show completion only after confirmation."
  );
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
  ) {
    resetWalletSetup();
    flow.disconnect();
  }
});
const timer = setInterval(() => {
  render();
  void checkAutomatically();
}, 1000);
window.addEventListener("pagehide", () => {
  pageClosed = true;
  clearInterval(timer);
  watcher.stop();
  resetWalletSetup();
  flow.disconnect();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});
void run(() => flow.initialize());
