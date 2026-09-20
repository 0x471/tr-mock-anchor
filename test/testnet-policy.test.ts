import { Horizon, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config, type Config } from "../src/config.js";
import {
  createFakeGateway,
  createGateway,
  createLiveGateway,
  type StellarGateway,
} from "../src/stellar.js";

afterEach(() => vi.restoreAllMocks());

const constructors: Array<{
  label: string;
  make: (cfg: Config) => StellarGateway;
}> = [
  { label: "direct live gateway", make: createLiveGateway },
  { label: "direct fake gateway", make: createFakeGateway },
  {
    label: "live gateway factory",
    make: (cfg) => createGateway({ ...cfg, stellarMode: "live" }),
  },
  {
    label: "fake gateway factory",
    make: (cfg) => createGateway({ ...cfg, stellarMode: "fake" }),
  },
];

describe("testnet-only gateway policy", () => {
  it.each(constructors)(
    "$label rejects other networks before setup",
    ({ make }) => {
      const rejectSetup = () => {
        throw new Error("unexpected setup or network call");
      };
      const secret = vi
        .spyOn(Keypair, "fromSecret")
        .mockImplementation(rejectSetup);
      const random = vi
        .spyOn(Keypair, "random")
        .mockImplementation(rejectSetup);
      const horizon = vi
        .spyOn(Horizon.Server.prototype, "loadAccount")
        .mockImplementation(rejectSetup);
      const rpcAccount = vi
        .spyOn(rpc.Server.prototype, "getAccount")
        .mockImplementation(rejectSetup);
      const rpcSubmit = vi
        .spyOn(rpc.Server.prototype, "sendTransaction")
        .mockImplementation(rejectSetup);
      for (const anchorMode of ["legacy", "zkpassport"] as const) {
        for (const networkPassphrase of [
          Networks.PUBLIC,
          Networks.FUTURENET,
          "private network",
          "",
          `${Networks.TESTNET} `,
        ]) {
          for (const treasurySecret of ["not-a-secret", ""]) {
            expect(() =>
              make({
                ...config,
                anchorMode,
                networkPassphrase,
                treasurySecret,
                horizonUrl: "not-a-url",
                rpcUrl: "not-a-url",
              })
            ).toThrow("Only Stellar Testnet is supported");
          }
        }
      }
      for (const call of [secret, random, horizon, rpcAccount, rpcSubmit]) {
        expect(call).not.toHaveBeenCalled();
      }
    }
  );

  it("keeps valid Testnet fake gateways functional without network requests", async () => {
    const network = vi.spyOn(Horizon.Server.prototype, "loadAccount");
    const rpcAccount = vi.spyOn(rpc.Server.prototype, "getAccount");
    const rpcSubmit = vi.spyOn(rpc.Server.prototype, "sendTransaction");
    const cfg: Config = {
      ...config,
      anchorMode: "legacy",
      stellarMode: "fake",
      networkPassphrase: Networks.TESTNET,
      treasurySecret: "",
    };
    for (const make of [createFakeGateway, createGateway]) {
      const gateway = make(cfg);
      expect(gateway.mode).toBe("fake");
      expect(await gateway.treasuryUsdcBalance()).toBe(10_000_000_000_000n);
      expect(
        await gateway.sendUsdc({
          destination: gateway.treasuryPublicKey,
          amountStroops: 1_0000000n,
        })
      ).toMatchObject({ settlement: "payment" });
      expect(await gateway.treasuryUsdcBalance()).toBe(9_999_990_000_000n);
    }
    for (const call of [network, rpcAccount, rpcSubmit]) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});
