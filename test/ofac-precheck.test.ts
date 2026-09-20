import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfacPrecheck } from "../src/ofac-precheck.js";

const listed = "GBDUOR2HI5DUOR2HI5DUOR2HI5DUOR2HI5DUOR2HI5DUOR2HI5DUPJKH";
const unlisted = "GBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQYC7";
const now = Date.parse("2026-09-20T01:00:00Z");
afterEach(() => vi.useRealTimers());

function document(address = listed, currency = "USDC") {
  return `<?xml version="1.0"?>
<sdnList xmlns="https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML">
  <publshInformation>
    <Publish_Date>09/18/2026</Publish_Date><Record_Count>1</Record_Count>
  </publshInformation>
  <sdnEntry><uid>1</uid><lastName>Synthetic demo</lastName>
    <sdnType>Entity</sdnType><programList><program>TEST</program></programList>
    <idList><id><uid>2</uid><idType>Digital Currency Address - ${currency}</idType>
      <idNumber>${address}</idNumber></id></idList>
  </sdnEntry>
</sdnList>`;
}

function feed(xml = document()): typeof fetch {
  return async () => new Response(xml);
}

describe("OFAC listed-address precheck", () => {
  it("matches an exact Stellar address under any digital-currency label", async () => {
    const precheck = createOfacPrecheck({ fetch: feed(), now: () => now });
    expect(await precheck.check(listed)).toMatchObject({
      status: "match",
      checked_at: "2026-09-20T01:00:00.000Z",
      fetched_at: "2026-09-20T01:00:00.000Z",
      published_at: "2026-09-18",
      address_count: 1,
      stellar_address_count: 1,
      xlm_label_count: 0,
      source:
        "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("reports unavailable rather than no match when the feed cannot be fetched", async () => {
    const precheck = createOfacPrecheck({
      now: () => now,
      fetch: async () => {
        throw new Error("upstream offline");
      },
    });
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "unavailable",
      reason: "feed_unavailable",
      fetched_at: null,
      digest: null,
      address_count: 0,
    });
  });

  it.each([
    ["truncated XML", document().replace("</sdnList>", "")],
    ["missing entry", document().replace("<Record_Count>1", "<Record_Count>2")],
    ["empty list", document().replace(/<sdnEntry>[\s\S]*<\/sdnEntry>/, "")],
    ["missing address", document().replace(/<idNumber>[^<]+<\/idNumber>/, "")],
    [
      "no digital IDs",
      document().replace("Digital Currency Address - USDC", "Demo reference"),
    ],
    [
      "invalid publication date",
      document().replace("09/18/2026", "02/30/2026"),
    ],
    ["future publication date", document().replace("09/18/2026", "09/21/2026")],
    ["wrong namespace", document().replace("exports/XML", "exports/WRONG")],
    [
      "DTD declaration",
      document().replace(
        "<sdnList",
        '<!DOCTYPE sdnList [<!ENTITY demo "ignored">]><sdnList'
      ),
    ],
  ])("does not return no match for %s", async (_name, xml) => {
    const precheck = createOfacPrecheck({ fetch: feed(xml), now: () => now });
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "unavailable",
      reason: "invalid_feed",
      fetched_at: null,
    });
  });

  it.each(["", listed.toLowerCase(), `${listed} `, listed.slice(0, -1) + "A"])(
    "does not screen an invalid or noncanonical wallet: %s",
    async (address) => {
      const precheck = createOfacPrecheck({ fetch: feed(), now: () => now });
      expect(await precheck.check(address)).toMatchObject({
        status: "unavailable",
        reason: "invalid_address",
      });
    }
  );

  it("reports only no exact match when no Stellar addresses are listed", async () => {
    const precheck = createOfacPrecheck({
      fetch: feed(document("synthetic-non-stellar-identifier", "TEST")),
      now: () => now,
    });
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "no_match",
      address_count: 1,
      stellar_address_count: 0,
      xlm_label_count: 0,
    });
  });

  it("does not accept a non-success HTTP response with a valid-looking body", async () => {
    const precheck = createOfacPrecheck({
      fetch: async () => new Response(document(), { status: 503 }),
      now: () => now,
    });
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "unavailable",
      reason: "feed_unavailable",
    });
  });

  it("rejects an advertised feed larger than the bounded response limit", async () => {
    const precheck = createOfacPrecheck({
      fetch: async () =>
        new Response(document(), { headers: { "Content-Length": "67108865" } }),
      now: () => now,
    });
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "unavailable",
      reason: "feed_too_large",
    });
  });

  it("stops a streamed oversized feed even without a Content-Length header", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024);
    const precheck = createOfacPrecheck({
      now: () => now,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          })
        ),
    });
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "unavailable",
      reason: "feed_too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("refreshes the shared list after 15 minutes without screening remotely", async () => {
    let clock = now;
    let xml = document();
    const requests: {
      url: string;
      method: string;
      userAgent: string | null;
    }[] = [];
    const precheck = createOfacPrecheck({
      now: () => clock,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          userAgent: new Headers(init?.headers).get("user-agent"),
        });
        return new Response(xml);
      },
    });
    expect((await precheck.check(unlisted)).status).toBe("no_match");
    xml = document(unlisted, "XLM");
    clock += 14 * 60_000;
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "no_match",
      fetched_at: "2026-09-20T01:00:00.000Z",
      checked_at: "2026-09-20T01:14:00.000Z",
    });
    clock += 60_000;
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "match",
      fetched_at: "2026-09-20T01:15:00.000Z",
      xlm_label_count: 1,
    });
    expect(requests).toEqual([
      {
        url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
        method: "GET",
        userAgent: "tr-mock-anchor-testnet/1.0",
      },
      {
        url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML",
        method: "GET",
        userAgent: "tr-mock-anchor-testnet/1.0",
      },
    ]);
  });

  it("coalesces simultaneous checks into one complete source download", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let downloads = 0;
    const precheck = createOfacPrecheck({
      now: () => now,
      fetch: async () => {
        downloads++;
        await pending;
        return new Response(document());
      },
    });
    const first = precheck.check(listed);
    const second = precheck.check(unlisted);
    release?.();
    expect((await first).status).toBe("match");
    expect((await second).status).toBe("no_match");
    expect(downloads).toBe(1);
  });

  it("does not reuse a no-match result when a required refresh fails", async () => {
    let clock = now;
    let available = true;
    const precheck = createOfacPrecheck({
      now: () => clock,
      fetch: async () => {
        if (!available) throw new Error("offline");
        return new Response(document());
      },
    });
    expect((await precheck.check(unlisted)).status).toBe("no_match");
    available = false;
    clock += 15 * 60_000;
    expect(await precheck.check(unlisted)).toMatchObject({
      status: "unavailable",
      reason: "feed_unavailable",
      fetched_at: null,
    });
    clock += 24 * 60 * 60_000;
    expect((await precheck.check(unlisted)).status).toBe("unavailable");
    available = true;
    expect((await precheck.check(unlisted)).status).toBe("no_match");
  });

  it("aborts a feed request after 60 seconds without returning no match", async () => {
    vi.useFakeTimers();
    const precheck = createOfacPrecheck({
      now: () => now,
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true }
          );
        }),
    });
    let outcome: string | undefined;
    const checking = precheck.check(unlisted).then((result) => {
      outcome = result.status;
      return result;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outcome).toBe("unavailable");
    expect(await checking).toMatchObject({ reason: "feed_timeout" });
  });
});
