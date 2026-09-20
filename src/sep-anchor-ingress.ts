import { Horizon, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import type { Config } from "./config.js";
import type {
  SepAnchorIngress,
  SepIncomingPayment,
} from "./sep-anchor-types.js";
import { parseUsdc } from "./money.js";

interface PaymentRecord {
  id: string;
  paging_token: string;
  type: string;
  transaction_hash: string;
  transaction_successful: boolean;
  from: string;
  to: string;
  to_muxed?: string;
  from_muxed?: string;
  amount: string;
  asset_code?: string;
  asset_issuer?: string;
  created_at: string;
  transaction_attr?: {
    successful: boolean;
    hash: string;
    memo_type: string;
    memo?: string;
  };
}

export function createSepAnchorIngress(
  cfg: Config
): SepAnchorIngress | undefined {
  if (!cfg.sepAnchorContract) return undefined;
  if (cfg.networkPassphrase !== Networks.TESTNET)
    throw new Error("SEP ingress requires Testnet");
  const account = Keypair.fromSecret(cfg.sepAnchorProviderSecret).publicKey();
  const asset = `stellar:${cfg.usdcCode}:${cfg.usdcIssuer}`;
  const server = new Horizon.Server(cfg.horizonUrl);
  return {
    account,
    asset,
    async recipientStatus(recipient, amount) {
      if (
        !StrKey.isValidEd25519PublicKey(recipient) ||
        !/^[1-9]\d*$/.test(amount)
      )
        throw new Error("Invalid recipient readiness request");
      if ((await server.root()).network_passphrase !== Networks.TESTNET)
        throw new Error("Horizon is not Testnet");
      let state;
      try {
        state = await server.loadAccount(recipient);
      } catch (error) {
        if (
          (error as { response?: { status?: number } }).response?.status === 404
        )
          return "missing_account";
        throw error;
      }
      const line = state.balances.find(
        (balance) =>
          "asset_code" in balance &&
          balance.asset_code === cfg.usdcCode &&
          balance.asset_issuer === cfg.usdcIssuer
      );
      if (!line || !("asset_code" in line)) return "missing_trustline";
      if (!line.is_authorized) return "unauthorized";
      const remaining =
        parseUsdc(line.limit) -
        parseUsdc(line.balance) -
        parseUsdc(line.buying_liabilities ?? "0");
      return remaining >= BigInt(amount) ? "ready" : "insufficient_limit";
    },
    async payments(cursor) {
      const network = await server.root();
      if (network.network_passphrase !== Networks.TESTNET)
        throw new Error("Horizon is not Testnet");
      const page = await server
        .payments()
        .forAccount(account)
        .join("transactions")
        .order("asc")
        .limit(200)
        .cursor(cursor ?? "0")
        .call();
      const payments: SepIncomingPayment[] = [];
      let next = cursor;
      for (const r of page.records as unknown as PaymentRecord[]) {
        if (!/^\d+$/.test(r.paging_token) || !/^\d+$/.test(r.id))
          throw new Error("Invalid Horizon payment identity");
        next = r.paging_token;
        if (
          ![
            "payment",
            "path_payment_strict_send",
            "path_payment_strict_receive",
          ].includes(r.type) ||
          r.to !== account ||
          r.asset_code !== cfg.usdcCode ||
          r.asset_issuer !== cfg.usdcIssuer
        )
          continue;
        const t = r.transaction_attr;
        if (
          !r.transaction_successful ||
          !t?.successful ||
          t.hash !== r.transaction_hash ||
          !/^[a-f0-9]{64}$/.test(r.transaction_hash)
        )
          throw new Error("Incoming payment confirmation unavailable");
        if (!Number.isFinite(Date.parse(r.created_at)))
          throw new Error("Invalid payment time");
        payments.push({
          operation_id: r.id,
          paging_token: r.paging_token,
          transaction_hash: r.transaction_hash,
          from: r.from_muxed ?? r.from,
          to: r.to_muxed ?? r.to,
          asset,
          amount: parseUsdc(r.amount).toString(),
          memo_type: t.memo_type,
          memo: t.memo ?? null,
          created_at: r.created_at,
        });
      }
      return { payments, cursor: next };
    },
  };
}
