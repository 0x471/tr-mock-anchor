import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";

const PROVIDER = "GDAHV4MVSXLCR4ELY4JK3F6WNEQCONAZTLTKBGDJZARXBRGWMTTIMK22";
const ISSUER = "GDQYN2SNSRQCGBJYB7SQFQIKKKN4YWZCHYZQ5W7UKAB6P36MSIKCVKQN";
const LIMIT = "1000.0000000";
const asset = new Asset("USDC", ISSUER);
const marker = createHash("sha256")
  .update(JSON.stringify(["sep-anchor-headroom-v1", PROVIDER, ISSUER, LIMIT]))
  .digest("hex");
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const server = new rpc.Server("https://soroban-testnet.stellar.org", {
  timeout: 15_000,
});
class SafeError extends Error {}
const fail = (message) => {
  throw new SafeError(message);
};
function args() {
  const values = process.argv.slice(2);
  if (values.length === 1 && values[0] === "--help") return null;
  const result = { execute: false, keydir: null, journal: null };
  const seen = new Set();
  for (let i = 0; i < values.length; i++) {
    const name = values[i];
    if (seen.has(name)) fail("Repeated option.");
    seen.add(name);
    if (name === "--execute") result.execute = true;
    else if (name === "--keydir" || name === "--journal") {
      const value = values[++i];
      if (!value || value.startsWith("--")) fail("Missing option path.");
      result[name.slice(2)] = resolve(value);
    } else fail("Unsupported option. Use --help.");
  }
  if (!result.keydir || !result.journal)
    fail("Provide --keydir and --journal.");
  return result;
}
function key(keydir, secret = false) {
  let value;
  try {
    value = execFileSync(
      "stellar",
      [
        "keys",
        secret ? "secret" : "public-key",
        "sep-anchor-provider-v1",
        "--config-dir",
        keydir,
        "--quiet",
        "--no-cache",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }
    ).trim();
  } catch {
    fail("The pinned local provider identity could not be loaded.");
  }
  if (!secret) {
    if (value !== PROVIDER) fail("Provider identity mismatch.");
    return;
  }
  let signer;
  try {
    signer = Keypair.fromSecret(value);
  } catch {
    fail("The provider signing identity is invalid.");
  }
  if (signer.publicKey() !== PROVIDER)
    fail("Provider signing identity mismatch.");
  return signer;
}
function amount(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d{1,7})?$/.test(value))
    fail("Invalid account amount.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}
async function snapshot() {
  const [h, r, account] = await Promise.all([
    horizon.root(),
    server.getNetwork(),
    horizon.loadAccount(PROVIDER),
  ]);
  if (
    h.network_passphrase !== Networks.TESTNET ||
    r.passphrase !== Networks.TESTNET
  )
    fail("Both endpoints must identify Stellar Testnet.");
  if (account.accountId() !== PROVIDER) fail("Provider account mismatch.");
  const line = account.balances.find(
    (b) => b.asset_code === "USDC" && b.asset_issuer === ISSUER
  );
  if (!line || line.is_authorized !== true)
    fail("The pinned authorized trustline must already exist.");
  return { account, line };
}
function validate(journal) {
  if (
    !journal ||
    journal.version !== 1 ||
    journal.kind !== "sep-anchor-headroom" ||
    journal.network !== Networks.TESTNET ||
    journal.provider !== PROVIDER ||
    journal.issuer !== ISSUER ||
    journal.limit !== LIMIT ||
    !["prepared", "pending", "success", "failed"].includes(journal.status) ||
    !/^[a-f0-9]{64}$/.test(journal.hash)
  )
    fail("The journal describes a different repair.");
  let transaction;
  try {
    transaction = TransactionBuilder.fromXdr(
      journal.envelope,
      Networks.TESTNET
    );
  } catch {
    fail("The journal envelope is invalid.");
  }
  if (!(transaction instanceof Transaction))
    fail("Expected a plain transaction.");
  const bounds = transaction.timeBounds;
  const op = transaction.operations[0];
  if (
    transaction.source !== PROVIDER ||
    transaction.operations.length !== 1 ||
    Buffer.from(transaction.hash()).toString("hex") !== journal.hash ||
    BigInt(transaction.fee) <= 0n ||
    BigInt(transaction.fee) > 1_000_000n ||
    !bounds ||
    !Number.isSafeInteger(journal.min_time) ||
    !Number.isSafeInteger(journal.expires_at) ||
    Number(bounds.minTime) !== journal.min_time ||
    Number(bounds.maxTime) !== journal.expires_at ||
    journal.min_time < 0 ||
    journal.expires_at <= journal.min_time ||
    journal.expires_at - journal.min_time > 185 ||
    transaction.memo.type !== "hash" ||
    Buffer.from(transaction.memo.value).toString("hex") !== marker ||
    op.type !== "changeTrust" ||
    (op.source && op.source !== PROVIDER) ||
    op.line.getCode() !== "USDC" ||
    op.line.getIssuer() !== ISSUER ||
    op.limit !== LIMIT ||
    !transaction.signatures.some((signature) =>
      Keypair.fromPublicKey(PROVIDER).verify(
        transaction.hash(),
        signature.signature
      )
    )
  )
    fail(
      "The signed journal does not match the exact trustline-only Testnet repair."
    );
  return transaction;
}
function read(path) {
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 64000 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      fail("The journal must be an owned regular 0600 file.");
    const journal = JSON.parse(readFileSync(fd, "utf8"));
    validate(journal);
    return journal;
  } finally {
    closeSync(fd);
  }
}
function save(path, journal) {
  validate(journal);
  if (existsSync(path)) read(path);
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), "r");
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
async function reconcile(journal) {
  try {
    const receipt = await server.getTransaction(journal.hash);
    if (receipt.status === "SUCCESS" || receipt.status === "FAILED") {
      if (!Number.isSafeInteger(receipt.ledger) || receipt.ledger <= 0)
        fail("Invalid RPC confirmation ledger.");
      return {
        status: receipt.status === "SUCCESS" ? "success" : "failed",
        ledger: receipt.ledger,
      };
    }
  } catch (error) {
    if (error instanceof SafeError) throw error;
  }
  try {
    const receipt = await horizon
      .transactions()
      .transaction(journal.hash)
      .call();
    const ledger =
      typeof receipt.ledger === "number" ? receipt.ledger : receipt.ledger_attr;
    if (
      receipt.hash !== journal.hash ||
      typeof receipt.successful !== "boolean" ||
      !Number.isSafeInteger(ledger) ||
      ledger <= 0
    )
      fail("Invalid Horizon confirmation.");
    return {
      status: receipt.successful ? "success" : "failed",
      ledger,
    };
  } catch (error) {
    if (error instanceof SafeError) throw error;
  }
  return { status: journal.status, ledger: journal.ledger };
}
function report(state, journal, submitted) {
  console.log(
    JSON.stringify(
      {
        network: "testnet",
        provider: PROVIDER,
        issuer: ISSUER,
        balance: state.line.balance,
        limit: state.line.limit,
        buying_liabilities: state.line.buying_liabilities ?? "0.0000000",
        remaining_stroops: (
          amount(state.line.limit) -
          amount(state.line.balance) -
          amount(state.line.buying_liabilities ?? "0")
        ).toString(),
        intended_limit: LIMIT,
        minting: false,
        submitted,
        transaction_hash: journal?.hash ?? null,
        status: journal?.status ?? null,
        ledger: journal?.ledger ?? null,
      },
      null,
      2
    )
  );
}
async function main() {
  const options = args();
  if (!options) {
    console.log(
      "Usage: node scripts/repair-sep-headroom.mjs --keydir PATH --journal NEW_FILE [--execute]\nDefault is read-only. Testnet provider only. Raises trustline to 1000 mock USDC; never mints or transfers tokens. Reuse the same private journal after submission; unknown outcomes never create replacement envelopes."
    );
    return;
  }
  key(options.keydir);
  let state = await snapshot();
  let journal = read(options.journal);
  if (!options.execute) {
    if (journal) Object.assign(journal, await reconcile(journal));
    report(state, journal, false);
    return;
  }
  const lockPath = `${options.journal}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    fail(
      "Repair journal is locked. Confirm the previous process stopped before operator recovery."
    );
  }
  try {
    let submitted = false;
    writeFileSync(lock, JSON.stringify({ pid: process.pid }));
    fsyncSync(lock);
    journal = read(options.journal);
    state = await snapshot();
    if (!journal) {
      if (
        state.line.limit !== "100.0000000" ||
        state.line.balance !== "100.0000000" ||
        amount(state.line.buying_liabilities ?? "0") !== 0n ||
        amount(state.line.selling_liabilities ?? "0") !== 0n
      )
        fail(
          "Initial state differs from the reviewed 100-balance, 100-limit, zero-liability repair."
        );
      const timestamp = Number((await server.getLatestLedger()).closeTime);
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0)
        fail("Invalid latest ledger time.");
      const transaction = new TransactionBuilder(state.account, {
        fee: "10000",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.changeTrust({ asset, limit: LIMIT }))
        .addMemo(Memo.hash(marker))
        .setTimebounds(timestamp - 5, timestamp + 180)
        .build();
      transaction.sign(key(options.keydir, true));
      journal = {
        version: 1,
        kind: "sep-anchor-headroom",
        network: Networks.TESTNET,
        provider: PROVIDER,
        issuer: ISSUER,
        limit: LIMIT,
        hash: Buffer.from(transaction.hash()).toString("hex"),
        envelope: transaction.toXdr(),
        min_time: timestamp - 5,
        expires_at: timestamp + 180,
        status: "prepared",
        ledger: null,
      };
      save(options.journal, journal);
    }
    Object.assign(journal, await reconcile(journal));
    save(options.journal, journal);
    if (journal.status === "failed")
      fail(
        "The exact repair failed. Retain the journal; no replacement was created."
      );
    if (journal.status !== "success") {
      const timestamp = Number((await server.getLatestLedger()).closeTime);
      if (!Number.isSafeInteger(timestamp) || timestamp >= journal.expires_at)
        fail(
          "Repair outcome is unknown and the envelope expired. Reconcile the same hash; no replacement was created."
        );
      await snapshot();
      journal.status = "pending";
      save(options.journal, journal);
      try {
        submitted = true;
        const response = await server.sendTransaction(validate(journal));
        if (response.hash && response.hash !== journal.hash)
          fail("Submission returned a different hash.");
      } catch (error) {
        if (error instanceof SafeError) throw error;
      }
      for (let attempt = 0; attempt < 15; attempt++) {
        Object.assign(journal, await reconcile(journal));
        save(options.journal, journal);
        if (journal.status === "failed")
          fail("The exact repair failed onchain. No replacement was created.");
        if (journal.status === "success") break;
        await delay(2000);
      }
    }
    state = await snapshot();
    if (journal.status === "success" && state.line.limit !== LIMIT)
      fail(
        "Repair confirmed but current trustline limit differs. Retain the journal for review."
      );
    report(state, journal, submitted);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
try {
  await main();
} catch (error) {
  console.error(
    error instanceof SafeError
      ? error.message
      : "Repair stopped safely; no raw credential or endpoint output was logged. Retain any existing journal."
  );
  process.exitCode = 1;
}
