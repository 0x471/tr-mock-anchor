import {
  Account,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Config } from "./config.js";

export const PASSPORT_VERIFIER =
  "CB2R3TF45CASFOJS7KHFDWOYKDVBHOYBRSIQLSPLE4SDXXT75WUOM7JI";
export const PASSPORT_VK_HASH =
  "013d18b35786455360821b6dbcb40174603cac5893781f0fc1601af4eacb01eb";
export const PASSPORT_PROOF_BYTES = 9888;
export const PASSPORT_INPUT_BYTES = 320;
export type ProofStatus = "math_valid" | "invalid" | "verifier_unavailable";

export interface PassportVerification {
  status: ProofStatus;
  ledger: number | null;
}

export interface PassportVerifier {
  verify(proof: Buffer, publicInputs: Buffer): Promise<PassportVerification>;
}

export function createNativePassportVerifier(
  cfg: Pick<Config, "rpcUrl" | "networkPassphrase">
): PassportVerifier {
  const server = new rpc.Server(cfg.rpcUrl, {
    allowHttp: cfg.rpcUrl.startsWith("http://"),
    timeout: 15_000,
  });
  return {
    async verify(proof, publicInputs) {
      if (cfg.networkPassphrase !== Networks.TESTNET)
        return { status: "verifier_unavailable", ledger: null };
      if (
        proof.length !== PASSPORT_PROOF_BYTES ||
        publicInputs.length !== PASSPORT_INPUT_BYTES
      ) {
        return { status: "invalid", ledger: null };
      }
      try {
        const transaction = new TransactionBuilder(
          new Account(
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            "0"
          ),
          {
            fee: "100",
            networkPassphrase: Networks.TESTNET,
          }
        )
          .addOperation(
            new Contract(PASSPORT_VERIFIER).call(
              "verify",
              xdr.ScVal.scvBytes(proof),
              xdr.ScVal.scvBytes(publicInputs)
            )
          )
          .setTimeout(30)
          .build();
        const result = await server.simulateTransaction(transaction);
        if (rpc.Api.isSimulationRestore(result))
          return {
            status: "verifier_unavailable",
            ledger: result.latestLedger,
          };
        if (
          rpc.Api.isSimulationSuccess(result) &&
          result.result &&
          scValToNative(result.result.retval) === true
        ) {
          return { status: "math_valid", ledger: result.latestLedger };
        }
        // Transport failures and unrelated contract errors are not invalid-proof evidence.
        if (
          rpc.Api.isSimulationError(result) &&
          /Error\(Contract, #2\)/.test(result.error)
        ) {
          return { status: "invalid", ledger: result.latestLedger };
        }
        return {
          status: "verifier_unavailable",
          ledger: result.latestLedger ?? null,
        };
      } catch {
        return { status: "verifier_unavailable", ledger: null };
      }
    },
  };
}
