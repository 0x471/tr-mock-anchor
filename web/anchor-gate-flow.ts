import {
  Address,
  Asset,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
import { z } from "zod";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const hashString = z.string().regex(/^[a-f0-9]{64}$/);
const countries = z
  .array(z.string().regex(/^[A-Z]{3}$/))
  .max(10)
  .refine((list) => list.every((code, i) => i === 0 || list[i - 1]! < code));
const policySchema = z
  .object({
    min_age: z.number().int().min(1).max(120),
    allowed_nationalities: countries,
    allowed_issuers: countries,
    mock_only: z.literal(true),
    max_proof_age: z.number().int().positive(),
    verifier_vk_hash: hashString,
  })
  .passthrough();
const infoSchema = z.object({
  enabled: z.literal(true),
  network: z.literal("testnet"),
  network_passphrase: z.literal(Networks.TESTNET),
  buy_asset: z.string(),
  sell_asset: z.literal("iso4217:TRY"),
  max_fee_stroops: z.string().regex(/^\d+$/),
  config: z
    .object({
      contract: z.string(),
      token: z.string(),
      domain: z.string(),
      scope: z.string(),
      policy: policySchema,
      proof_bytes: z.number().int(),
      external_inputs: z.number().int(),
      policy_valid_until: z.number().int(),
      max_try_minor: z.string().regex(/^\d+$/),
      max_amount: z.string().regex(/^\d+$/),
    })
    .passthrough(),
});
const quoteSchema = z.object({
  id: z.string(),
  sell_asset: z.string(),
  buy_asset: z.string(),
  sell_amount: z.string(),
  buy_amount: z.string(),
  expires_at: z.string(),
  fee: z.object({ total: z.string(), asset: z.string() }),
});
const orderSchema = z.object({
  id: hashString,
  quote_id: z.string(),
  recipient: z.string(),
  amount_try: z.string(),
  amount_token: z.string(),
  source_asset: z.string(),
  direction: z.enum(["deposit", "withdrawal"]),
  bank_destination: z.string().nullable(),
  bank_destination_hash: hashString,
  escrowed: z.boolean(),
  payout_authorized_at: z.number().int().nullable(),
  mock_bank_credit: z
    .object({
      destination: z.string(),
      amount_try: z.string(),
      credited_at: z.string().datetime(),
    })
    .nullable(),
  token: z.string(),
  contract: z.string(),
  stage: z.enum([
    "registering",
    "created",
    "eligible",
    "funded",
    "payout_authorized",
    "paid",
    "settled",
  ]),
  expired: z.boolean(),
  created_at: z.number().int().nullable(),
  deadline: z.number().int(),
  network: z.literal("testnet"),
  eligibility_expires_at: z.number().int().nullable(),
  receipt_id: z.string().nullable(),
  bank_instructions: z
    .object({
      simulated: z.literal(true),
      amount_try: z.string(),
      reference: z.string(),
    })
    .nullable(),
  completed: z.boolean(),
  confirmed_ledger: z.number().int().nullable(),
  actions: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      transaction_hash: hashString,
      status: z.string(),
      ledger: z.number().int().nullable(),
      expires_at: z.number().int(),
    })
  ),
});
const phoneSchema = z.object({
  domain: z.string(),
  scope: z.string(),
  custom_data: hashString,
  policy: policySchema,
  created_at: z.number().int(),
  expires_at: z.number().int(),
  proof_bytes: z.number().int(),
  external_inputs: z.number().int(),
  dev_mode: z.literal(true),
  proof_type: z.literal("compressed-evm"),
  nullifier_type: z.literal(2),
});
const preparedSchema = z.object({
  action_id: z.string(),
  transaction: z.string(),
  hash: hashString,
  expires_at: z.number().int(),
  network_passphrase: z.literal(Networks.TESTNET),
});
export type PhoneRequest = z.infer<typeof phoneSchema>;
export interface PhoneEvents {
  event(message: string): void;
  proof(value: unknown): Promise<void>;
  rejected(): void;
}
export interface GatePhone {
  request(
    config: PhoneRequest,
    events: PhoneEvents
  ): Promise<{ url: string; cancel(): void }>;
}
export interface GateView {
  wallet: string;
  info: z.infer<typeof infoSchema> | null;
  quote: z.infer<typeof quoteSchema> | null;
  order: z.infer<typeof orderSchema> | null;
  phoneUrl: string;
  prepared: z.infer<typeof preparedSchema> | null;
  message: string;
  direction: "deposit" | "withdrawal";
}

export interface GateWallet {
  connect(): Promise<string>;
  current(): Promise<{ address: string; network: string }>;
  sign(transaction: string, address: string): Promise<string>;
}

interface FlowDependencies {
  origin: string;
  fetch: typeof fetch;
  wallet: GateWallet;
  phone: GatePhone;
  changed(): void;
  now?(): number;
}

export function createAnchorGateFlow(deps: FlowDependencies) {
  const view: GateView = {
    wallet: "",
    info: null,
    quote: null,
    order: null,
    phoneUrl: "",
    prepared: null,
    message: "Loading Testnet policy.",
    direction: "deposit",
  };
  const origin = new URL(deps.origin).origin;
  if (
    origin !== deps.origin ||
    !(origin.startsWith("https://") || new URL(origin).hostname === "localhost")
  )
    throw new Error("Use HTTPS or the localhost Testnet origin.");
  let token = "";
  let generation = 0;
  let phoneGeneration = 0;
  let phoneSession: { cancel(): void } | undefined;
  let idempotencyKey = "";
  let preparedInputs: { proof: string; public_inputs: string } | undefined;
  let requestedDestination: string | undefined;
  const now = () => Math.floor((deps.now?.() ?? Date.now()) / 1000);
  function units(value: string, decimals: number) {
    if (!new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`).test(value))
      throw new Error(`Enter an amount with at most ${decimals} decimals.`);
    const [whole, fraction = ""] = value.split(".");
    return (
      BigInt(whole!) * 10n ** BigInt(decimals) +
      BigInt(fraction.padEnd(decimals, "0"))
    );
  }
  const change = (message: string) => {
    view.message = message;
    deps.changed();
  };
  function cancelPhone() {
    phoneGeneration++;
    phoneSession?.cancel();
    phoneSession = undefined;
    view.phoneUrl = "";
    deps.changed();
  }
  function requireInfo() {
    if (!view.info) throw new Error("The Testnet gate is unavailable.");
    return view.info;
  }
  function requireOrder(allowAuthorizedCompletion = false) {
    const irreversibleWithdrawal =
      allowAuthorizedCompletion &&
      view.order?.direction === "withdrawal" &&
      ["payout_authorized", "paid"].includes(view.order.stage) &&
      view.order.escrowed &&
      view.order.payout_authorized_at !== null;
    if (
      !view.order ||
      (!irreversibleWithdrawal &&
        (view.order.expired || view.order.deadline <= now()))
    )
      throw new Error(
        "The order is missing or expired. No refund or payout is implied."
      );
    return view.order;
  }
  async function request(
    path: string,
    body?: unknown,
    authenticated = true,
    extraHeaders: Record<string, string> = {}
  ) {
    if (authenticated && !token)
      throw new Error("Connect and authenticate your wallet first.");
    const response = await deps.fetch(`${origin}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Anchor request failed (${response.status}). Reconcile before retrying.`
      );
    return response;
  }
  async function sameWallet(address: string) {
    const current = await deps.wallet.current();
    if (current.network !== Networks.TESTNET || current.address !== address)
      throw new Error("Select the same wallet on Stellar Testnet.");
  }
  function acceptOrder(value: unknown) {
    const order = orderSchema.parse(value);
    const info = requireInfo();
    if (
      order.recipient !== view.wallet ||
      order.contract !== info.config.contract ||
      order.token !== info.config.token ||
      order.source_asset !==
        (order.direction === "deposit" ? info.sell_asset : info.buy_asset) ||
      order.completed !== (order.stage === "settled")
    )
      throw new Error("Order does not match this wallet and vault.");
    view.order = order;
    view.direction = order.direction;
    change(
      order.completed
        ? "Settlement confirmed on Testnet."
        : `Onchain order stage: ${order.stage}.`
    );
    return order;
  }
  async function orderAction(path: string, allowAuthorizedCompletion = false) {
    const order = requireOrder(allowAuthorizedCompletion);
    const session = generation;
    await sameWallet(view.wallet);
    const value = await (
      await request(`/anchor-gate/orders/${order.id}/${path}`, {})
    ).json();
    if (session !== generation) throw new Error("Wallet session changed.");
    return acceptOrder(value);
  }
  const flow = {
    view,
    async initialize() {
      const info = infoSchema.parse(
        await (await request("/anchor-gate/info", undefined, false)).json()
      );
      const parts = info.buy_asset.split(":");
      if (
        parts.length !== 3 ||
        parts[0] !== "stellar" ||
        !StrKey.isValidEd25519PublicKey(parts[2]!) ||
        new Asset(parts[1]!, parts[2]!).contractId(Networks.TESTNET) !==
          info.config.token ||
        !StrKey.isValidContract(info.config.contract) ||
        info.config.domain !== new URL(origin).hostname ||
        info.config.policy_valid_until <= now()
      )
        throw new Error(
          "The published gate policy does not match this origin or asset."
        );
      const count =
        10 +
        Number(info.config.policy.allowed_nationalities.length > 0) +
        Number(info.config.policy.allowed_issuers.length > 0);
      if (
        info.config.external_inputs !== count ||
        info.config.proof_bytes !== (count === 10 ? 9888 : 10240)
      )
        throw new Error("Unsupported native proof profile.");
      view.info = info;
      change(
        "Synthetic documents, simulated TRY, Testnet tokens only. Connect Freighter on Testnet."
      );
    },
    async connect() {
      flow.disconnect();
      const session = ++generation;
      token = "";
      view.wallet = "";
      const address = await deps.wallet.connect();
      if (!StrKey.isValidEd25519PublicKey(address))
        throw new Error("A plain G-account wallet is required.");
      await sameWallet(address);
      const toml = await (
        await request("/.well-known/stellar.toml", undefined, false)
      ).text();
      const value = (key: string) => {
        const matches = [
          ...toml.matchAll(new RegExp(`^${key}="([^"\\r\\n]*)"\\s*$`, "gm")),
        ];
        if (matches.length !== 1)
          throw new Error("Invalid SEP-1 discovery metadata.");
        return matches[0]![1]!;
      };
      const signer = value("SIGNING_KEY");
      if (
        !StrKey.isValidEd25519PublicKey(signer) ||
        value("NETWORK_PASSPHRASE") !== Networks.TESTNET ||
        value("WEB_AUTH_ENDPOINT") !== `${origin}/auth`
      )
        throw new Error("Anchor discovery does not match this Testnet origin.");
      const challenge = z
        .object({
          transaction: z.string(),
          network_passphrase: z.literal(Networks.TESTNET),
        })
        .parse(
          await (
            await request(
              `/auth?account=${encodeURIComponent(address)}`,
              undefined,
              false
            )
          ).json()
        );
      const home = new URL(origin).host;
      const checked = WebAuth.readChallengeTx(
        challenge.transaction,
        signer,
        Networks.TESTNET,
        home,
        home
      );
      if (
        checked.clientAccountID !== address ||
        checked.memo !== null ||
        checked.tx.operations.length !== 2
      )
        throw new Error("The authentication challenge is not for this wallet.");
      await sameWallet(address);
      if (session !== generation) throw new Error("Wallet session changed.");
      const signed = await deps.wallet.sign(challenge.transaction, address);
      await sameWallet(address);
      if (
        session !== generation ||
        hex(TransactionBuilder.fromXdr(signed, Networks.TESTNET).hash()) !==
          hex(checked.tx.hash())
      )
        throw new Error("Wallet changed the authentication challenge.");
      const authenticated = z
        .object({ token: z.string().min(1) })
        .parse(
          await (await request("/auth", { transaction: signed }, false)).json()
        );
      if (session !== generation)
        throw new Error("Wallet authentication was not confirmed.");
      token = authenticated.token;
      view.wallet = address;
      change("Wallet authenticated. Login does not approve a transfer.");
    },
    disconnect() {
      generation++;
      cancelPhone();
      token = "";
      view.wallet = "";
      view.quote = null;
      view.order = null;
      view.prepared = null;
      preparedInputs = undefined;
      idempotencyKey = "";
      requestedDestination = undefined;
      change(
        "Wallet session cleared. Existing onchain reservations are unchanged."
      );
    },
    selectDirection(direction: "deposit" | "withdrawal") {
      if (view.order)
        throw new Error("An existing order's direction cannot change.");
      view.direction = direction;
      view.quote = null;
      idempotencyKey = "";
      requestedDestination = undefined;
      change("Request a fresh quote for the selected direction.");
    },
    async quote(
      amount: string,
      direction: "deposit" | "withdrawal" = view.direction
    ) {
      const info = requireInfo();
      const decimals = direction === "deposit" ? 2 : 7;
      const requestedUnits = units(amount, decimals);
      if (
        requestedUnits <= 0n ||
        requestedUnits >
          BigInt(
            direction === "deposit"
              ? info.config.max_try_minor
              : info.config.max_amount
          )
      )
        throw new Error("Amount exceeds the configured Testnet policy.");
      if (view.order)
        throw new Error(
          "Finish or explicitly leave the current order before another quote."
        );
      const sellAsset =
        direction === "deposit" ? info.sell_asset : info.buy_asset;
      const buyAsset =
        direction === "deposit" ? info.buy_asset : info.sell_asset;
      const session = generation;
      await sameWallet(view.wallet);
      const quote = quoteSchema.parse(
        await (
          await request("/sep38/quote", {
            sell_asset: sellAsset,
            buy_asset: buyAsset,
            sell_amount: amount,
          })
        ).json()
      );
      if (
        session !== generation ||
        units(quote.sell_amount, decimals) !== requestedUnits ||
        units(quote.buy_amount, direction === "deposit" ? 7 : 2) <= 0n ||
        units(
          direction === "deposit" ? quote.buy_amount : quote.sell_amount,
          7
        ) > BigInt(info.config.max_amount) ||
        units(
          direction === "deposit" ? quote.sell_amount : quote.buy_amount,
          2
        ) > BigInt(info.config.max_try_minor) ||
        units(quote.fee.total, decimals) > requestedUnits ||
        quote.sell_asset !== sellAsset ||
        quote.buy_asset !== buyAsset ||
        quote.fee.asset !== sellAsset ||
        !Number.isFinite(Date.parse(quote.expires_at)) ||
        Date.parse(quote.expires_at) <= now() * 1000
      )
        throw new Error("Quote does not match this request.");
      view.quote = quote;
      view.direction = direction;
      requestedDestination = undefined;
      idempotencyKey = crypto.randomUUID();
      change("Review the exact quote before reserving an order.");
    },
    async createOrder(bankDestination?: string) {
      if (!view.quote || !idempotencyKey || view.order)
        throw new Error("Request and review a fresh quote first.");
      if (
        view.direction === "withdrawal"
          ? !bankDestination ||
            !/^demo:[A-Za-z0-9_-]{1,64}$/.test(bankDestination)
          : bankDestination !== undefined
      )
        throw new Error(
          "Withdrawals require a synthetic demo: reference; deposits cannot specify a bank destination."
        );
      if (
        requestedDestination !== undefined &&
        requestedDestination !== bankDestination
      )
        throw new Error(
          "Do not change the destination when retrying an existing reservation."
        );
      requestedDestination = bankDestination;
      const session = generation;
      await sameWallet(view.wallet);
      const value = await (
        await request(
          "/anchor-gate/orders",
          {
            quote_id: view.quote.id,
            direction: view.direction,
            ...(bankDestination ? { bank_destination: bankDestination } : {}),
          },
          true,
          { "Idempotency-Key": idempotencyKey }
        )
      ).json();
      if (session !== generation) throw new Error("Wallet session changed.");
      const order = orderSchema.parse(value);
      if (
        order.quote_id !== view.quote.id ||
        order.direction !== view.direction ||
        order.amount_try !==
          (view.direction === "deposit"
            ? view.quote.sell_amount
            : view.quote.buy_amount) ||
        order.amount_token !==
          (view.direction === "deposit"
            ? view.quote.buy_amount
            : view.quote.sell_amount) ||
        order.bank_destination !== (bankDestination ?? null)
      )
        throw new Error(
          "Reserved order does not match the accepted quote and destination."
        );
      acceptOrder(value);
    },
    async refresh(id = view.order?.id) {
      if (!id || !/^[a-f0-9]{64}$/.test(id))
        throw new Error("Enter a valid order ID.");
      const session = generation;
      await sameWallet(view.wallet);
      const value = await (await request(`/anchor-gate/orders/${id}`)).json();
      if (session !== generation) throw new Error("Wallet session changed.");
      return acceptOrder(value);
    },
    cancelPhone,
    async requestProof() {
      const order = requireOrder();
      const info = requireInfo();
      if (
        !(
          order.direction === "deposit"
            ? ["created", "eligible", "funded"]
            : ["created", "eligible"]
        ).includes(order.stage) ||
        order.created_at === null ||
        order.created_at + 30 > now()
      )
        throw new Error(
          "Wait 30 seconds after confirmed order creation before requesting a phone proof."
        );
      await sameWallet(view.wallet);
      cancelPhone();
      view.prepared = null;
      preparedInputs = undefined;
      const session = generation;
      const phoneId = phoneGeneration;
      const config = phoneSchema.parse(
        await (
          await request(`/anchor-gate/orders/${order.id}/proof-request`)
        ).json()
      );
      const fingerprint = (policy: PhoneRequest["policy"]) =>
        JSON.stringify([
          policy.min_age,
          policy.allowed_nationalities,
          policy.allowed_issuers,
          policy.mock_only,
          policy.max_proof_age,
          policy.verifier_vk_hash,
        ]);
      if (
        session !== generation ||
        phoneId !== phoneGeneration ||
        config.domain !== info.config.domain ||
        config.scope !== info.config.scope ||
        fingerprint(config.policy) !== fingerprint(info.config.policy) ||
        config.expires_at > order.deadline ||
        config.expires_at <= now() ||
        config.created_at !== order.created_at ||
        config.proof_bytes !== info.config.proof_bytes ||
        config.external_inputs !== info.config.external_inputs
      )
        throw new Error("Phone request differs from the order policy.");
      const active = () =>
        session === generation &&
        phoneId === phoneGeneration &&
        now() < config.expires_at;
      let received = false;
      const created = await deps.phone.request(config, {
        event(message) {
          if (active() && !received) change(message);
        },
        rejected() {
          if (active()) {
            cancelPhone();
            change(
              "Phone request rejected. No eligibility or payout was granted."
            );
          }
        },
        async proof(value) {
          if (!active() || received) return;
          received = true;
          view.phoneUrl = "";
          phoneSession?.cancel();
          try {
            const parsed = z
              .object({
                name: z.string(),
                version: z.literal("0.20.0"),
                vkeyHash: z.string(),
                proof: z.string().max(22000),
              })
              .parse(value);
            const raw = parsed.proof.replace(/^0x/, "").toLowerCase();
            if (
              parsed.name !== `outer_evm_count_${config.external_inputs - 5}` ||
              parsed.vkeyHash.replace(/^0x/, "").toLowerCase() !==
                config.policy.verifier_vk_hash ||
              !/^[a-f0-9]+$/.test(raw) ||
              raw.length !==
                (config.proof_bytes + config.external_inputs * 32) * 2
            )
              throw new Error(
                "The phone returned an unsupported proof profile."
              );
            const inputs = {
              public_inputs: raw.slice(0, config.external_inputs * 64),
              proof: raw.slice(config.external_inputs * 64),
            };
            const proofTime = Number(
              BigInt(`0x${inputs.public_inputs.slice(128, 192)}`)
            );
            if (
              !Number.isSafeInteger(proofTime) ||
              proofTime < config.created_at ||
              proofTime > now() ||
              proofTime + config.policy.max_proof_age <= now()
            )
              throw new Error(
                "Phone proof timestamp is stale or predates the order. Wait and request a fresh proof."
              );
            await sameWallet(view.wallet);
            if (!active()) return;
            const prepared = preparedSchema.parse(
              await (
                await request(
                  `/anchor-gate/orders/${order.id}/prepare-proof`,
                  inputs
                )
              ).json()
            );
            if (!active()) return;
            view.prepared = prepared;
            preparedInputs = inputs;
            change(
              "Proof received, not yet accepted. Review and sign the exact Testnet invocation in Freighter."
            );
          } catch (error) {
            if (active())
              change(
                error instanceof Error && error.message.includes("timestamp")
                  ? error.message
                  : "Proof preparation failed. No eligibility was granted; reconcile or request a fresh proof."
              );
          }
        },
      });
      if (!active() || received) {
        created.cancel();
        return;
      }
      phoneSession = created;
      view.phoneUrl = created.url;
      change(
        "Scan the QR in ZKPassport using a synthetic document. Keep this browser open."
      );
    },
    async signProof() {
      const order = requireOrder();
      const info = requireInfo();
      const prepared = view.prepared;
      const inputs = preparedInputs;
      const session = generation;
      if (!prepared || !inputs || prepared.expires_at <= now())
        throw new Error("Prepare a fresh proof transaction first.");
      const transaction = TransactionBuilder.fromXdr(
        prepared.transaction,
        Networks.TESTNET
      );
      if (
        !(transaction instanceof Transaction) ||
        transaction.source !== view.wallet ||
        transaction.operations.length !== 1 ||
        transaction.memo.type !== "none" ||
        hex(transaction.hash()) !== prepared.hash ||
        BigInt(transaction.fee) > BigInt(info.max_fee_stroops) ||
        !transaction.timeBounds ||
        Number(transaction.timeBounds.maxTime) !== prepared.expires_at ||
        prepared.expires_at > order.deadline
      )
        throw new Error("Unexpected Testnet proof invocation.");
      const operation = transaction.operations[0]!;
      if (
        operation.type !== "invokeHostFunction" ||
        (operation.source && operation.source !== view.wallet) ||
        operation.func.type !== "hostFunctionTypeInvokeContract"
      )
        throw new Error("Unexpected Testnet proof invocation.");
      const invocation = operation.func.value;
      const args = invocation.args;
      if (
        Address.fromScAddress(invocation.contractAddress).toString() !==
          order.contract ||
        invocation.functionName.toString() !== "prove_order" ||
        args.length !== 3 ||
        args[0]?.type !== "scvBytes" ||
        args[1]?.type !== "scvBytes" ||
        args[2]?.type !== "scvBytes" ||
        hex(args[0].value.toBytes()) !== order.id ||
        hex(args[1].value.toBytes()) !== inputs.proof ||
        hex(args[2].value.toBytes()) !== inputs.public_inputs ||
        operation.auth?.some(
          (auth) => auth.credentials.type !== "sorobanCredentialsSourceAccount"
        )
      )
        throw new Error("Unexpected Testnet proof invocation.");
      await sameWallet(view.wallet);
      if (session !== generation) throw new Error("Wallet session changed.");
      const signed = await deps.wallet.sign(prepared.transaction, view.wallet);
      await sameWallet(view.wallet);
      if (
        session !== generation ||
        prepared.expires_at <= now() ||
        hex(TransactionBuilder.fromXdr(signed, Networks.TESTNET).hash()) !==
          prepared.hash
      )
        throw new Error(
          "Wallet changed the proof invocation or the request expired."
        );
      const value = await (
        await request(`/anchor-gate/orders/${order.id}/submit`, {
          action_id: prepared.action_id,
          signed_transaction: signed,
        })
      ).json();
      if (session !== generation) return;
      view.prepared = null;
      preparedInputs = undefined;
      cancelPhone();
      acceptOrder(value);
    },
    async authorizePayout() {
      const order = requireOrder();
      if (
        order.direction !== "withdrawal" ||
        order.stage !== "eligible" ||
        !order.escrowed ||
        !order.eligibility_expires_at ||
        order.eligibility_expires_at <= now()
      )
        throw new Error(
          "Current eligibility and confirmed token escrow are required to authorize simulated TRY payout."
        );
      return orderAction("authorize-payout");
    },
    async simulateBank() {
      const order = requireOrder(true);
      if (order.direction === "withdrawal") {
        if (
          order.stage !== "payout_authorized" ||
          !order.escrowed ||
          order.payout_authorized_at === null
        )
          throw new Error(
            "The withdrawal must be authorized onchain before simulated TRY payout."
          );
        return orderAction("simulate-bank", true);
      }
      if (
        order.stage !== "eligible" ||
        !order.bank_instructions ||
        !order.eligibility_expires_at ||
        order.eligibility_expires_at <= now()
      )
        throw new Error(
          "A confirmed, current native eligibility grant is required before simulated TRY receipt."
        );
      return orderAction("simulate-bank");
    },
    async settle() {
      const order = requireOrder(true);
      if (order.direction === "withdrawal") {
        if (
          order.stage !== "paid" ||
          !order.receipt_id ||
          !order.escrowed ||
          order.payout_authorized_at === null
        )
          throw new Error(
            "A confirmed simulated payout receipt is required to release withdrawal escrow to the provider."
          );
        return orderAction("settle", true);
      }
      if (
        order.stage !== "funded" ||
        !order.receipt_id ||
        !order.eligibility_expires_at ||
        order.eligibility_expires_at <= now()
      )
        throw new Error(
          "A confirmed mock-bank receipt and current eligibility are required for settlement."
        );
      return orderAction("settle");
    },
  };
  return flow;
}
