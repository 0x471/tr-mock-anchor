/**
 * Stellar gateway: everything that touches Horizon lives here so the rest of the app
 * (and the tests) can run against an in-memory fake.
 */
import {
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Keypair,
  Memo,
  MuxedAccount,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { fmtUsdc, parseUsdc } from './money.js';
import type { Config } from './config.js';

export interface IncomingPayment {
  txHash: string;
  pagingToken: string;
  from: string;
  amountStroops: bigint;
  memoType?: string;
  memo?: string;
  toMuxedId?: string;
  createdAt: string;
}

export interface SendResult {
  settlement: 'payment' | 'claimable_balance';
  txHash: string;
  claimableBalanceId?: string;
}

export interface StellarGateway {
  readonly mode: 'live' | 'fake';
  readonly treasuryPublicKey: string;
  readonly assetCode: string;
  readonly assetIssuer: string;
  treasuryUsdcBalance(): Promise<bigint>;
  /** Pay USDC to a G... or M... address. Falls back to a claimable balance when the
   *  destination account is missing or has no USDC trustline. */
  sendUsdc(args: { destination: string; amountStroops: bigint; memo?: string }): Promise<SendResult>;
  /** Incoming USDC payments to the treasury after `cursor` (Horizon paging token). */
  incomingUsdc(cursor: string | undefined): Promise<{ payments: IncomingPayment[]; cursor: string | undefined }>;
  /** Signers + thresholds of an account, or null when the account does not exist (SEP-10 verification). */
  accountSigners(accountId: string): Promise<AccountSigners | null>;
}

export interface AccountSigners {
  signers: Array<{ key: string; weight: number; type: string }>;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
}

export class StellarError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public resultCodes?: unknown,
  ) {
    super(message);
    this.name = 'StellarError';
  }
}

export function isStellarAddress(addr: string): boolean {
  return StrKey.isValidEd25519PublicKey(addr) || StrKey.isValidMed25519PublicKey(addr);
}

export function baseAccountOf(addr: string): string {
  return StrKey.isValidMed25519PublicKey(addr) ? MuxedAccount.fromAddress(addr, '0').baseAccount().accountId() : addr;
}

/* ---------------- live (Horizon testnet) ---------------- */

export function createLiveGateway(cfg: Config): StellarGateway {
  if (!cfg.treasurySecret) throw new Error('TREASURY_SECRET is required when STELLAR_MODE=live (run: npm run setup:treasury)');
  const treasury = Keypair.fromSecret(cfg.treasurySecret);
  const server = new Horizon.Server(cfg.horizonUrl);
  const asset = new Asset(cfg.usdcCode, cfg.usdcIssuer);
  const fee = String(Number(BASE_FEE) * 100); // 10_000 stroops = 0.001 XLM; generous so testnet surges don't stall us

  const isUsdc = (b: { asset_type: string; asset_code?: string; asset_issuer?: string }) =>
    b.asset_type !== 'native' && b.asset_code === cfg.usdcCode && b.asset_issuer === cfg.usdcIssuer;

  async function loadOrNull(accountId: string) {
    try {
      return await server.loadAccount(accountId);
    } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status === 404) return null;
      throw new StellarError(`horizon loadAccount failed: ${(e as Error).message}`, true);
    }
  }

  async function submit(build: (b: TransactionBuilder) => TransactionBuilder) {
    const source = await server.loadAccount(treasury.publicKey());
    const tx = build(new TransactionBuilder(source, { fee, networkPassphrase: cfg.networkPassphrase }))
      .setTimeout(60)
      .build();
    tx.sign(treasury);
    try {
      return await server.submitTransaction(tx);
    } catch (e) {
      const data = (e as { response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } } })
        .response?.data;
      const codes = data?.extras?.result_codes;
      const txCode = codes?.transaction ?? '';
      const retryable = !codes || txCode === 'tx_bad_seq' || txCode === 'tx_too_late' || txCode === 'tx_insufficient_fee';
      throw new StellarError(`submit failed: ${txCode || (e as Error).message} ${codes?.operations?.join(',') ?? ''}`.trim(), retryable, codes);
    }
  }

  /** Balance id (hex, with the 4-byte type prefix) of the claimable balance a transaction created. */
  async function claimableBalanceIdOf(txHash: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const effects = await server.effects().forTransaction(txHash).limit(50).call();
      const created = effects.records.find((e) => e.type === 'claimable_balance_created') as { balance_id?: string } | undefined;
      if (created?.balance_id) return created.balance_id;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return undefined;
  }

  return {
    mode: 'live',
    treasuryPublicKey: treasury.publicKey(),
    assetCode: cfg.usdcCode,
    assetIssuer: cfg.usdcIssuer,

    async treasuryUsdcBalance() {
      const acct = await server.loadAccount(treasury.publicKey());
      const bal = acct.balances.find((b) => isUsdc(b as never)) as { balance: string } | undefined;
      return bal ? parseUsdc(bal.balance) : 0n;
    },

    async sendUsdc({ destination, amountStroops, memo }) {
      const amount = fmtUsdc(amountStroops);
      const base = baseAccountOf(destination);
      const acct = await loadOrNull(base);
      const hasTrustline = !!acct?.balances.some((b) => isUsdc(b as never));

      if (acct && hasTrustline) {
        const res = await submit((b) => {
          b.addOperation(Operation.payment({ destination, asset, amount }));
          if (memo) b.addMemo(Memo.text(memo.slice(0, 28)));
          return b;
        });
        return { settlement: 'payment', txHash: res.hash };
      }

      // Destination is unfunded or lacks the USDC trustline: park the funds in a claimable balance.
      const res = await submit((b) =>
        b.addOperation(
          Operation.createClaimableBalance({
            asset,
            amount,
            claimants: [new Claimant(base, Claimant.predicateUnconditional())],
          }),
        ),
      );
      // The transaction is on-chain from here on: nothing below may throw, or a retry would pay twice.
      let balanceId: string | undefined;
      try {
        balanceId = await claimableBalanceIdOf(res.hash);
      } catch {
        balanceId = undefined;
      }
      return { settlement: 'claimable_balance', txHash: res.hash, claimableBalanceId: balanceId };
    },

    async accountSigners(accountId) {
      const acct = await loadOrNull(accountId);
      if (!acct) return null;
      return { signers: acct.signers.map((x) => ({ key: x.key, weight: x.weight, type: x.type })), thresholds: acct.thresholds };
    },

    async incomingUsdc(cursor) {
      let call = server.payments().forAccount(treasury.publicKey()).join('transactions').order('asc').limit(200);
      let last = cursor;
      if (cursor) call = call.cursor(cursor);
      else {
        // First run: skip history, start from the latest payment. Return that token as the new
        // cursor even when nothing follows it, so the caller persists it and later ticks move forward.
        const latest = await server.payments().forAccount(treasury.publicKey()).order('desc').limit(1).call();
        const tok = latest.records[0]?.paging_token;
        if (tok) {
          call = call.cursor(tok);
          last = tok;
        }
      }
      const page = await call.call();
      const payments: IncomingPayment[] = [];
      for (const r of page.records as unknown as HorizonPaymentRecord[]) {
        last = r.paging_token;
        const isPayment = r.type === 'payment' || r.type === 'path_payment_strict_send' || r.type === 'path_payment_strict_receive';
        if (!isPayment || r.to !== treasury.publicKey() || !isUsdc(r)) continue;
        payments.push({
          txHash: r.transaction_hash,
          pagingToken: r.paging_token,
          from: r.from,
          amountStroops: parseUsdc(r.amount),
          memoType: r.transaction_attr?.memo_type,
          memo: r.transaction_attr?.memo,
          toMuxedId: r.to_muxed_id,
          createdAt: r.created_at,
        });
      }
      return { payments, cursor: last };
    },
  };
}

interface HorizonPaymentRecord {
  type: string;
  paging_token: string;
  transaction_hash: string;
  created_at: string;
  from: string;
  to: string;
  to_muxed_id?: string;
  amount: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  transaction_attr?: { memo_type?: string; memo?: string };
}

/* ---------------- fake (in-memory) ---------------- */

export interface FakeGateway extends StellarGateway {
  /** Register an account as existing (SEP-10 threshold path); unknown accounts count as unfunded. */
  registerAccount(accountId: string, signers?: AccountSigners): void;
  /** Queue a simulated inbound USDC payment to the treasury. */
  simulateIncoming(p: { from?: string; amount: string; memoId?: string; toMuxedId?: string; memoType?: string; memo?: string }): IncomingPayment;
  /** Mark an address as unfunded / lacking a trustline so sendUsdc uses a claimable balance. */
  markNoTrustline(address: string): void;
  sent: Array<{ destination: string; amount: string; memo?: string; result: SendResult }>;
}

export function createFakeGateway(cfg: Config, initialBalance = '1000000.0000000'): FakeGateway {
  const treasury = cfg.treasurySecret ? Keypair.fromSecret(cfg.treasurySecret) : Keypair.random();
  let balance = parseUsdc(initialBalance);
  const noTrust = new Set<string>();
  const accounts = new Map<string, AccountSigners>();
  const queue: IncomingPayment[] = [];
  let seq = 0;
  const sent: FakeGateway['sent'] = [];

  return {
    mode: 'fake',
    treasuryPublicKey: treasury.publicKey(),
    assetCode: cfg.usdcCode,
    assetIssuer: cfg.usdcIssuer,
    sent,
    async treasuryUsdcBalance() {
      return balance;
    },
    async sendUsdc({ destination, amountStroops, memo }) {
      if (amountStroops > balance) throw new StellarError('submit failed: op_underfunded', false);
      balance -= amountStroops;
      const txHash = `fake${(++seq).toString().padStart(4, '0')}${'0'.repeat(56)}`.slice(0, 64);
      const result: SendResult = noTrust.has(baseAccountOf(destination))
        ? { settlement: 'claimable_balance', txHash, claimableBalanceId: `00000000${txHash}` }
        : { settlement: 'payment', txHash };
      sent.push({ destination, amount: fmtUsdc(amountStroops), memo, result });
      return result;
    },
    async accountSigners(accountId) {
      return accounts.get(accountId) ?? null;
    },
    registerAccount(accountId, signers) {
      accounts.set(accountId, signers ?? { signers: [{ key: accountId, weight: 1, type: 'ed25519_public_key' }], thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 } });
    },
    async incomingUsdc(cursor) {
      const start = cursor ? Number(cursor) : 0;
      const payments = queue.filter((p) => Number(p.pagingToken) > start);
      const last = payments.length ? payments[payments.length - 1]!.pagingToken : cursor;
      return { payments, cursor: last };
    },
    simulateIncoming(p) {
      const stroops = parseUsdc(p.amount);
      balance += stroops;
      const payment: IncomingPayment = {
        txHash: `fakein${(++seq).toString().padStart(4, '0')}${'0'.repeat(56)}`.slice(0, 64),
        pagingToken: String(seq),
        from: p.from ?? Keypair.random().publicKey(),
        amountStroops: stroops,
        memoType: p.memoType ?? (p.memoId ? 'id' : undefined),
        memo: p.memo ?? p.memoId,
        toMuxedId: p.toMuxedId,
        createdAt: new Date().toISOString(),
      };
      queue.push(payment);
      return payment;
    },
    markNoTrustline(address) {
      noTrust.add(address);
    },
  };
}

export function createGateway(cfg: Config): StellarGateway {
  return cfg.stellarMode === 'fake' ? createFakeGateway(cfg) : createLiveGateway(cfg);
}
