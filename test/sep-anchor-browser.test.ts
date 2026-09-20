import { afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";

const orderId = "ab".repeat(32);
const wallet = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const token = new Asset("USDC", issuer).contractId(Networks.TESTNET);
const policy = {
  min_age: 18,
  allowed_nationalities: ["ZKR"],
  allowed_issuers: ["ZKR"],
  mock_only: true,
  max_proof_age: 600,
  verifier_vk_hash: "cd".repeat(32),
};

interface PageNode {
  tag: string;
  parent?: PageNode;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  value: string;
  href: string;
  addEventListener(name: string, callback: () => void): void;
  trigger(name: string): void;
  setAttribute(): void;
  removeAttribute(): void;
  replaceChildren(): void;
  append(): void;
  getContext(): { clearRect(): void };
}
function node(tag: string, parent?: PageNode): PageNode {
  const events = new Map<string, () => void>();
  return {
    tag,
    parent,
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    href: "",
    addEventListener(name: string, callback: () => void) {
      events.set(name, callback);
    },
    trigger(name: string) {
      events.get(name)?.();
    },
    setAttribute() {},
    removeAttribute() {},
    replaceChildren() {},
    append() {},
    getContext() {
      return { clearRect() {} };
    },
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock("@stellar/freighter-api");
  vi.doUnmock("@zkpassport/sdk");
  vi.doUnmock("qrcode");
  vi.resetModules();
});

async function page(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.useFakeTimers();
  const html = await readFile(
    new URL("../web/sep-anchor.html", import.meta.url),
    "utf8"
  );
  const nodes = new Map<string, PageNode>();
  const stack: PageNode[] = [];
  let end = 0;
  for (const match of html.matchAll(/<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi)) {
    const content = html.slice(end, match.index).replace(/\s+/g, " ").trim();
    if (content && stack.length) stack.at(-1)!.textContent += content;
    end = match.index + match[0].length;
    const [, closing, tag, attributes] = match;
    if (closing) {
      while (stack.length && stack.pop()!.tag !== tag) {}
      continue;
    }
    const current = node(tag!, stack.at(-1));
    current.hidden = /\bhidden\b/.test(attributes!);
    const id = /\bid="([^"]+)"/.exec(attributes!)?.[1];
    if (id) nodes.set(id, current);
    if (!["input", "br", "meta", "link", "img", "hr"].includes(tag!))
      stack.push(current);
  }
  const get = (id: string) => {
    const result = nodes.get(id);
    if (!result) throw new Error(`Unknown page element ${id}`);
    return result;
  };
  const visible = (id: string) => {
    let current: PageNode | undefined = get(id);
    while (current) {
      if (current.hidden) return false;
      current = current.parent;
    }
    return true;
  };
  let transaction = {
    id: orderId,
    kind: "withdrawal",
    status: "pending_user",
    wallet,
    quote_id: "qt_fixture",
    amount_in: "2.0000000",
    amount_out: "79.60",
    amount_in_asset: `stellar:USDC:${issuer}`,
    amount_out_asset: "iso4217:TRY",
    message: "Exact escrow can be refunded before payout authorization.",
    policy,
    native: { eligible: false, valid_until: null, confirmed_ledger: null },
    ready_for_payment: false,
    recovery_required: false,
    escrowed: true,
    payout_authorized: false,
    can_refund: true,
    withdraw_anchor_account: null,
    withdraw_memo: null,
    withdraw_memo_type: null,
    actions: [],
    ...overrides,
  };
  const location = new URL(
    `http://localhost:8787/sep24/interactive/${orderId}`
  );
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    if (url.pathname === `/sep24/interactive/${orderId}/state`)
      return Response.json({ transaction, csrf_token: "ef".repeat(32) });
    if (url.pathname === "/sep24/info")
      return Response.json({
        network: "testnet",
        network_passphrase: Networks.TESTNET,
        asset: { code: "USDC", issuer, contract: token },
        config: {
          contract: StrKey.encodeContract(Buffer.alloc(32, 7)),
          domain: "localhost",
          scope: "synthetic-test",
          policy,
          proof_bytes: 10240,
          external_inputs: 12,
          policy_valid_until: Math.floor(Date.now() / 1000) + 600,
        },
      });
    if (
      url.pathname === `/sep24/interactive/${orderId}/refund` &&
      init?.method === "POST"
    ) {
      if (new Headers(init.headers).get("X-CSRF-Token") !== "ef".repeat(32))
        return Response.json(
          { error: "Session binding missing" },
          { status: 403 }
        );
      transaction = {
        ...transaction,
        status: transaction.kind === "deposit" ? "expired" : "refunded",
        escrowed: false,
        can_refund: false,
      };
      return Response.json({ transaction });
    }
    throw new Error(`Unexpected browser HTTP request: ${url.pathname}`);
  };
  vi.doMock("@stellar/freighter-api", () => ({}));
  vi.doMock("@zkpassport/sdk", () => ({
    VERSION: "0.17.1",
    ZKPassport: class {},
  }));
  vi.doMock("qrcode", () => ({ default: {} }));
  const pageEvents = new Map<string, () => void>();
  vi.stubGlobal("window", {
    location,
    fetch: fetcher,
    addEventListener(name: string, callback: () => void) {
      pageEvents.set(name, callback);
    },
  });
  vi.stubGlobal("location", location);
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("document", {
    getElementById: get,
    createElement: node,
    querySelectorAll: () =>
      [...nodes.values()].filter((value) => value.tag === "button"),
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  cleanups.push(() => pageEvents.get("pagehide")?.());
  const entry = "../web/sep-anchor.js";
  await import(entry);
  await vi.waitFor(() => expect(get("refund").disabled).toBe(false));
  return {
    get,
    visible,
    async click(id: string) {
      expect(visible(id)).toBe(true);
      expect(get(id).disabled).toBe(false);
      get(id).trigger("click");
      await vi.waitFor(() => expect(get(id).disabled).toBe(false));
    },
    async update(changes: Record<string, unknown>) {
      transaction = { ...transaction, ...changes };
      await vi.advanceTimersByTimeAsync(2600);
    },
  };
}

it("keeps an expired-grant escrow refund visible and submits it from the production page", async () => {
  const browser = await page();
  expect(browser.visible("finish-section")).toBe(true);
  expect(browser.visible("refund")).toBe(true);
  expect(browser.visible("mock-bank")).toBe(false);
  expect(browser.get("step").textContent).toBe("3 / TRANSFER");
  await browser.click("refund");
  expect(browser.get("heading").textContent).toBe("Refund confirmed");
  expect(browser.get("step").textContent).toBe("CONFIRMED");
  expect(browser.visible("refund")).toBe(false);
});

it.each(["pending_stellar", "pending_user"])(
  "reconciles an authorized payout in %s after eligibility expiry without asking for a new proof",
  async (status) => {
    const browser = await page({
      status,
      payout_authorized: true,
      can_refund: false,
    });
    expect(browser.visible("finish-section")).toBe(true);
    expect(browser.visible("proof-section")).toBe(false);
    expect(browser.visible("mock-bank")).toBe(false);
    expect(browser.visible("refund")).toBe(false);
    expect(browser.get("heading").textContent).toBe(
      "Completing authorized payout"
    );
    expect(browser.get("step").textContent).toBe("3 / TRANSFER");
    expect(browser.get("next-action").textContent).toBe(
      "Payout is already authorized. Receipt and settlement are reconciling automatically; no new proof or payment is needed."
    );
    await browser.update({ status: "completed", escrowed: false });
    expect(browser.get("heading").textContent).toBe("Exchange complete");
    expect(browser.get("step").textContent).toBe("CONFIRMED");
    expect(browser.visible("proof-section")).toBe(false);
  }
);

it("keeps first-time unfunded orders at proof onboarding", async () => {
  const browser = await page({
    status: "incomplete",
    escrowed: false,
    can_refund: false,
  });
  expect(browser.visible("proof-section")).toBe(true);
  expect(browser.visible("finish-section")).toBe(false);
  expect(browser.visible("refund")).toBe(false);
  expect(browser.get("heading").textContent).toBe("Verify privately");
  expect(browser.get("step").textContent).toBe("2 / VERIFY");
});

it("labels a held deposit cancellation as releasing a reservation rather than a wallet refund", async () => {
  const browser = await page({
    kind: "deposit",
    amount_in: "100.00",
    amount_out: "2.4875621",
    amount_in_asset: "iso4217:TRY",
    amount_out_asset: `stellar:USDC:${issuer}`,
  });
  expect(browser.visible("refund")).toBe(true);
  expect(browser.get("refund").textContent).toBe("Cancel unused reservation");
  expect(browser.get("step").textContent).toBe("3 / TRANSFER");
  await browser.click("refund");
  expect(browser.get("heading").textContent).toBe("Order expired");
  expect(browser.visible("proof-section")).toBe(false);
  expect(browser.visible("refund")).toBe(false);
});
