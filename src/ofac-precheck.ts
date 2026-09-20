import { createHash } from "node:crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { XMLParser, XMLValidator } from "fast-xml-parser";

const source =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML";
const maxFeedBytes = 64 * 1024 * 1024;
const refreshMs = 15 * 60 * 1000;

export type OfacCheck = {
  status: "no_match" | "match" | "unavailable";
  checked_at: string;
  fetched_at: string | null;
  published_at: string | null;
  source: string;
  digest: string | null;
  address_count: number;
  stellar_address_count: number;
  xlm_label_count: number;
  reason?: string;
};

export type OfacPrecheck = {
  check(address: string): Promise<OfacCheck>;
};

type Snapshot = {
  addresses: Set<string>;
  publishedAt: string;
  digest: string;
  stellarAddresses: number;
  xlmLabels: number;
};
type CachedSnapshot = Snapshot & { fetchedAt: number };

class FeedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedError("invalid_feed");
  }
  return value as Record<string, unknown>;
}

function parseFeed(bytes: Buffer, now: number): Snapshot {
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) ||
    XMLValidator.validate(xml) !== true
  ) {
    throw new FeedError("invalid_feed");
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => name === "sdnEntry" || name === "id",
  });
  const parsed = record(parser.parse(xml));
  const root = record(parsed.sdnList);
  if (
    Object.keys(parsed).length !== 1 ||
    root["@_xmlns"] !==
      "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/XML"
  ) {
    throw new FeedError("invalid_feed");
  }
  const publication = record(root.publshInformation);
  const count = publication.Record_Count;
  const entries = root.sdnEntry;
  if (
    typeof count !== "string" ||
    !/^[1-9][0-9]*$/.test(count) ||
    !Number.isSafeInteger(Number(count)) ||
    !Array.isArray(entries) ||
    Number(count) !== entries.length
  ) {
    throw new FeedError("invalid_feed");
  }
  const date = publication.Publish_Date;
  if (typeof date !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    throw new FeedError("invalid_feed");
  }
  const [month, day, year] = date.split("/");
  const publishedAt = `${year}-${month}-${day}`;
  const publishedMs = Date.parse(publishedAt);
  if (
    !Number.isFinite(publishedMs) ||
    new Date(publishedMs).toISOString().slice(0, 10) !== publishedAt ||
    publishedAt > new Date(now).toISOString().slice(0, 10)
  ) {
    throw new FeedError("invalid_feed");
  }
  const addresses = new Set<string>();
  const entryIds = new Set<string>();
  let xlmLabels = 0;
  for (const value of entries) {
    const entry = record(value);
    if (typeof entry.uid !== "string" || entryIds.has(entry.uid)) {
      throw new FeedError("invalid_feed");
    }
    entryIds.add(entry.uid);
    if (entry.idList === undefined) continue;
    const ids = record(entry.idList).id;
    if (ids === undefined) continue;
    if (!Array.isArray(ids)) throw new FeedError("invalid_feed");
    for (const value of ids) {
      const id = record(value);
      if (id.idType === undefined) continue;
      if (typeof id.idType !== "string") throw new FeedError("invalid_feed");
      if (!id.idType.startsWith("Digital Currency Address")) continue;
      if (
        !/^Digital Currency Address - [A-Za-z0-9]+$/.test(id.idType) ||
        typeof id.idNumber !== "string" ||
        !/^[\x21-\x7e]{1,256}$/.test(id.idNumber)
      ) {
        throw new FeedError("invalid_feed");
      }
      addresses.add(id.idNumber);
      if (id.idType === "Digital Currency Address - XLM") xlmLabels++;
    }
  }
  if (addresses.size === 0) throw new FeedError("invalid_feed");
  return {
    addresses,
    publishedAt,
    digest: createHash("sha256").update(bytes).digest("hex"),
    stellarAddresses: [...addresses].filter((value) =>
      StrKey.isValidEd25519PublicKey(value)
    ).length,
    xlmLabels,
  };
}

async function readFeed(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new FeedError("feed_unavailable");
  if (Number(response.headers.get("content-length")) > maxFeedBytes) {
    await response.body.cancel();
    throw new FeedError("feed_too_large");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maxFeedBytes) {
        await reader.cancel();
        throw new FeedError("feed_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export function createOfacPrecheck(
  options: { fetch?: typeof fetch; now?: () => number } = {}
): OfacPrecheck {
  const fetchFeed = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: CachedSnapshot | undefined;
  let pending: Promise<CachedSnapshot> | undefined;

  async function download(): Promise<CachedSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetchFeed(source, {
        headers: { "User-Agent": "tr-mock-anchor-testnet/1.0" },
        signal: controller.signal,
      });
      const bytes = await readFeed(response);
      let snapshot: Snapshot;
      try {
        snapshot = parseFeed(bytes, now());
      } catch {
        throw new FeedError("invalid_feed");
      }
      cached = { ...snapshot, fetchedAt: now() };
      return cached;
    } catch (error) {
      if (controller.signal.aborted) throw new FeedError("feed_timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh(): Promise<CachedSnapshot> {
    if (
      cached &&
      now() >= cached.fetchedAt &&
      now() - cached.fetchedAt < refreshMs
    ) {
      return cached;
    }
    pending ??= download().finally(() => {
      pending = undefined;
    });
    return pending;
  }

  return {
    async check(address) {
      try {
        if (!StrKey.isValidEd25519PublicKey(address)) {
          throw new FeedError("invalid_address");
        }
        const snapshot = await refresh();
        return {
          status: snapshot.addresses.has(address) ? "match" : "no_match",
          checked_at: new Date(now()).toISOString(),
          fetched_at: new Date(snapshot.fetchedAt).toISOString(),
          published_at: snapshot.publishedAt,
          source,
          digest: snapshot.digest,
          address_count: snapshot.addresses.size,
          stellar_address_count: snapshot.stellarAddresses,
          xlm_label_count: snapshot.xlmLabels,
        };
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            error instanceof FeedError ? error.reason : "feed_unavailable",
          checked_at: new Date(now()).toISOString(),
          fetched_at: null,
          published_at: null,
          source,
          digest: null,
          address_count: 0,
          stellar_address_count: 0,
          xlm_label_count: 0,
        };
      }
    },
  };
}
