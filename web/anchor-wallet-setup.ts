import {
  Account,
  Asset,
  Networks,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import type { GateWallet } from "./anchor-gate-flow.js";

const horizon = "https://horizon-testnet.stellar.org";
const decimal = z.string().regex(/^(0|[1-9]\d*)\.\d{7}$/);
const balanceSchema = z.object({
  asset_type: z.string(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  balance: decimal,
  selling_liabilities: decimal,
  buying_liabilities: decimal,
  limit: decimal.optional(),
  is_authorized: z.boolean().optional(),
});
const accountSchema = z.object({
  account_id: z.string(),
  sequence: z.string().regex(/^\d+$/),
  subentry_count: z.number().int().nonnegative(),
  num_sponsoring: z.number().int().nonnegative(),
  num_sponsored: z.number().int().nonnegative(),
  balances: z.array(balanceSchema),
});

export interface TestnetAsset {
  code: string;
  issuer: string;
  contract: string;
}

export interface WalletReadiness {
  funded: boolean;
  balance: string;
  spendable: string;
  trustline: boolean;
  authorized: boolean;
  tokenBalance: string;
  limit: string;
  receivable: string;
  spendableToken: string;
  transactionHash?: string;
  pending?: boolean;
}

interface SetupDependencies {
  fetch: typeof fetch;
  wallet: GateWallet;
  changed(message: string): void;
}

const units = (value: string) => BigInt(value.replace(".", ""));
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
function amount(value: bigint) {
  const safe = value < 0n ? 0n : value;
  return `${safe / 10_000_000n}.${(safe % 10_000_000n).toString().padStart(7, "0")}`;
}
const emptyReadiness = (): WalletReadiness => ({
  funded: false,
  balance: "0.0000000",
  spendable: "0.0000000",
  trustline: false,
  authorized: false,
  tokenBalance: "0.0000000",
  limit: "0.0000000",
  receivable: "0.0000000",
  spendableToken: "0.0000000",
});

export function createTestnetWalletSetup(deps: SetupDependencies) {
  const funding = new Map<string, Promise<WalletReadiness>>();
  const lastFundingAttempt = new Map<string, number>();
  const signing = new Map<string, Promise<WalletReadiness>>();
  const pending = new Map<string, { hash: string; expiresAt: number }>();
  const key = (address: string, asset: TestnetAsset) =>
    `${address}:${asset.contract}`;
  async function assertWallet(address: string) {
    if (!StrKey.isValidEd25519PublicKey(address))
      throw new Error("A valid Stellar account is required.");
    const current = await deps.wallet.current();
    if (current.network !== Networks.TESTNET || current.address !== address)
      throw new Error("Keep the same wallet connected on Stellar Testnet.");
  }

  function checkedAsset(asset: TestnetAsset) {
    if (
      !StrKey.isValidEd25519PublicKey(asset.issuer) ||
      !/^[a-zA-Z0-9]{1,12}$/.test(asset.code)
    )
      throw new Error("Invalid demo asset.");
    const token = new Asset(asset.code, asset.issuer);
    if (token.contractId(Networks.TESTNET) !== asset.contract)
      throw new Error("Demo asset does not match its Testnet token contract.");
    return token;
  }

  async function readAccount(address: string) {
    await assertWallet(address);
    const response = await deps.fetch(`${horizon}/accounts/${address}`, {
      signal: AbortSignal.timeout(20_000),
    });
    await assertWallet(address);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Could not check Testnet wallet funds.");
    const account = accountSchema.parse(await response.json());
    await assertWallet(address);
    if (account.account_id !== address)
      throw new Error("Testnet returned a different wallet account.");
    return account;
  }

  function readiness(
    account: z.infer<typeof accountSchema> | null,
    asset?: TestnetAsset
  ): WalletReadiness {
    if (!account) return emptyReadiness();
    const native = account.balances.filter(
      (item) => item.asset_type === "native"
    );
    if (native.length !== 1) throw new Error("Invalid Testnet wallet balance.");
    const xlm = native[0]!;
    const reserveEntries =
      2 +
      account.subentry_count +
      account.num_sponsoring -
      account.num_sponsored;
    if (reserveEntries < 0) throw new Error("Invalid Testnet wallet reserve.");
    const spendable =
      units(xlm.balance) -
      BigInt(reserveEntries) * 5_000_000n -
      units(xlm.selling_liabilities);
    const token = asset
      ? account.balances.find(
          (item) =>
            item.asset_code === asset.code && item.asset_issuer === asset.issuer
        )
      : undefined;
    return {
      funded: true,
      balance: xlm.balance,
      spendable: amount(spendable),
      trustline: Boolean(token),
      authorized: token?.is_authorized === true,
      tokenBalance: token?.balance ?? "0.0000000",
      limit: token?.limit ?? "0.0000000",
      receivable: token?.limit
        ? amount(
            units(token.limit) -
              units(token.balance) -
              units(token.buying_liabilities)
          )
        : "0.0000000",
      spendableToken: token
        ? amount(units(token.balance) - units(token.selling_liabilities))
        : "0.0000000",
    };
  }

  async function inspect(address: string, asset?: TestnetAsset) {
    if (asset) checkedAsset(asset);
    const state = readiness(await readAccount(address), asset);
    const transaction = asset ? pending.get(key(address, asset)) : undefined;
    if (!asset || !transaction) return state;
    let response: Response | undefined;
    try {
      response = await deps.fetch(
        `${horizon}/transactions/${transaction.hash}`,
        {
          signal: AbortSignal.timeout(20_000),
        }
      );
    } catch {
      // Keep an unknown submission locked until Horizon confirms its outcome.
    }
    await assertWallet(address);
    if (!response?.ok)
      return { ...state, pending: true, transactionHash: transaction.hash };
    const result = z
      .object({
        hash: z.literal(transaction.hash),
        successful: z.boolean(),
      })
      .parse(await response.json());
    await assertWallet(address);
    if (!result.successful) {
      pending.delete(key(address, asset));
      throw new Error(
        "The Testnet trustline transaction failed. Wallet setup can be retried."
      );
    }
    const confirmed = readiness(await readAccount(address), asset);
    if (confirmed.trustline && confirmed.authorized) {
      pending.delete(key(address, asset));
      return {
        ...confirmed,
        pending: false,
        transactionHash: transaction.hash,
      };
    }
    return { ...confirmed, pending: true, transactionHash: transaction.hash };
  }

  async function fund(address: string) {
    const before = await inspect(address);
    if (before.funded && units(before.spendable) >= 100_000_000n) return before;
    const lastAttempt = lastFundingAttempt.get(address);
    if (lastAttempt !== undefined && Date.now() - lastAttempt < 60_000) {
      if (before.funded) return before;
      throw new Error(
        "Testnet funding is not confirmed. Wait a minute, then check again."
      );
    }
    await assertWallet(address);
    lastFundingAttempt.set(address, Date.now());
    deps.changed("Adding free Testnet XLM for wallet setup and fees.");
    try {
      await deps.fetch(`https://friendbot.stellar.org/?addr=${address}`, {
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // An uncertain faucet response is resolved by reading the account.
    }
    await assertWallet(address);
    const after = await inspect(address);
    if (!after.funded)
      throw new Error(
        "Free Testnet funding is not confirmed yet. Try wallet setup again in a minute."
      );
    if (units(after.spendable) < 100_000_000n) {
      deps.changed(
        "Automatic Testnet top-up is not confirmed. Your existing balance is still available."
      );
      return after;
    }
    deps.changed("Free Testnet XLM is ready. No real funds were used.");
    return after;
  }

  function ensureFunding(address: string) {
    const existing = funding.get(address);
    if (existing) return existing;
    const request = fund(address).finally(() => funding.delete(address));
    funding.set(address, request);
    return request;
  }

  async function createTrustline(address: string, asset: TestnetAsset) {
    const token = checkedAsset(asset);
    if (pending.has(key(address, asset))) return inspect(address, asset);
    await ensureFunding(address);
    const account = await readAccount(address);
    if (!account) throw new Error("Testnet funding is not confirmed.");
    const before = readiness(account, asset);
    if (before.trustline) {
      if (!before.authorized)
        throw new Error("The demo issuer must authorize this trustline.");
      if (units(before.receivable) === 0n)
        throw new Error("This demo trustline has no receiving capacity.");
      return before;
    }
    if (units(before.spendable) < 5_010_000n)
      throw new Error(
        "Wallet setup needs at least 0.501 spendable Testnet XLM for the new reserve and fee. Free top-up is not confirmed; try again in a minute."
      );
    const transaction = new TransactionBuilder(
      new Account(address, account.sequence),
      { fee: "10000", networkPassphrase: Networks.TESTNET }
    )
      .addOperation(Operation.changeTrust({ asset: token, limit: "1000000" }))
      .setTimeout(180)
      .build();
    const expectedHash = hex(transaction.hash());
    await assertWallet(address);
    deps.changed(
      "Approve the mock-USDC trustline in Freighter. This is not a payment."
    );
    const signedXdr = await deps.wallet.sign(transaction.toXdr(), address);
    await assertWallet(address);
    const signed = TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET);
    if (!(signed instanceof Transaction) || hex(signed.hash()) !== expectedHash)
      throw new Error(
        "The signed trustline transaction changed. Nothing was submitted."
      );
    if (signed.signatures.length === 0)
      throw new Error("The trustline transaction was not signed.");
    await assertWallet(address);
    const expiresAt = Number(transaction.timeBounds!.maxTime);
    if (Math.floor(Date.now() / 1000) >= expiresAt)
      throw new Error(
        "The trustline request expired. Start wallet setup again."
      );
    pending.set(key(address, asset), {
      hash: expectedHash,
      expiresAt,
    });
    let response: Response | undefined;
    try {
      response = await deps.fetch(`${horizon}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ tx: signedXdr }).toString(),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Retain the expected hash instead of creating a replacement transaction.
    }
    await assertWallet(address);
    if (!response?.ok) {
      if (response && (await rejectedBeforeInclusion(response, signedXdr))) {
        await assertWallet(address);
        pending.delete(key(address, asset));
        throw new Error(
          "Testnet rejected the trustline transaction before inclusion. Check Freighter's signing account and try wallet setup again."
        );
      }
      return inspect(address, asset);
    }
    const result = z
      .object({ hash: z.literal(expectedHash), successful: z.literal(true) })
      .parse(await response.json());
    const after = readiness(await readAccount(address), asset);
    if (!after.trustline || !after.authorized)
      return { ...after, pending: true, transactionHash: result.hash };
    pending.delete(key(address, asset));
    return { ...after, pending: false, transactionHash: result.hash };
  }

  async function rejectedBeforeInclusion(
    response: Response,
    signedXdr: string
  ) {
    if (response.status !== 400) return false;
    const codes = {
      tx_bad_auth: "txBadAuth",
      tx_bad_auth_extra: "txBadAuthExtra",
      tx_insufficient_fee: "txInsufficientFee",
      tx_malformed: "txMalformed",
    } as const;
    try {
      const error = z
        .object({
          type: z.literal(
            "https://stellar.org/horizon-errors/transaction_failed"
          ),
          status: z.literal(400),
          extras: z.object({
            envelope_xdr: z.literal(signedXdr),
            result_codes: z.object({
              transaction: z.enum([
                "tx_bad_auth",
                "tx_bad_auth_extra",
                "tx_insufficient_fee",
                "tx_malformed",
              ]),
            }),
            result_xdr: z.string(),
          }),
        })
        .parse(await response.json());
      const result = xdr.TransactionResult.fromXdr(
        error.extras.result_xdr,
        "base64"
      );
      return (
        result.result.type === codes[error.extras.result_codes.transaction]
      );
    } catch {
      return false;
    }
  }

  async function addTrustline(address: string, asset: TestnetAsset) {
    checkedAsset(asset);
    const id = key(address, asset);
    const existing = signing.get(id);
    if (existing) return existing;
    const request = createTrustline(address, asset).finally(() =>
      signing.delete(id)
    );
    signing.set(id, request);
    return request;
  }

  return {
    inspect,
    ensureFunding,
    addTrustline,
  };
}
