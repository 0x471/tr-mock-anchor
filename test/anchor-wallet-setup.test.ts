import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { createTestnetWalletSetup } from "../web/anchor-wallet-setup.js";

const owner = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const issuer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 12)).publicKey();
const address = owner.publicKey();
const asset = {
  code: "USDC",
  issuer,
  contract: new Asset("USDC", issuer).contractId(Networks.TESTNET),
};
const account = (balance = "100.0000000") => ({
  account_id: address,
  sequence: "123",
  subentry_count: 0,
  num_sponsoring: 0,
  num_sponsored: 0,
  balances: [
    {
      asset_type: "native",
      balance,
      selling_liabilities: "0.0000000",
      buying_liabilities: "0.0000000",
    },
  ],
});

function wallet(network = Networks.TESTNET) {
  return {
    connect: async () => address,
    current: async () => ({ address, network }),
    sign: async () => {
      throw new Error("Unexpected signature request");
    },
  };
}

describe("Testnet wallet setup", () => {
  it("allows another approval after an envelope-bound validation rejection", async () => {
    let signatures = 0;
    const setup = createTestnetWalletSetup({
      wallet: {
        ...wallet(),
        sign: async (value) => {
          signatures++;
          const tx = TransactionBuilder.fromXdr(value, Networks.TESTNET);
          tx.sign(owner);
          return tx.toXdr();
        },
      },
      changed() {},
      fetch: async (input, init) => {
        if (String(input).endsWith("/transactions")) {
          return Response.json(
            {
              type: "https://stellar.org/horizon-errors/transaction_failed",
              status: 400,
              extras: {
                envelope_xdr: new URLSearchParams(String(init?.body)).get("tx"),
                result_codes: { transaction: "tx_bad_auth" },
                result_xdr: new xdr.TransactionResult({
                  feeCharged: 0n,
                  result: xdr.TransactionResultResult.txBadAuth(),
                  ext: xdr.TransactionResultExt.v0(),
                }).toXdr("base64"),
              },
            },
            { status: 400 }
          );
        }
        if (String(input).includes("/transactions/"))
          return new Response(null, { status: 404 });
        return Response.json(account());
      },
    });
    await expect(setup.addTrustline(address, asset)).rejects.toThrow(
      "rejected"
    );
    await expect(setup.addTrustline(address, asset)).rejects.toThrow(
      "rejected"
    );
    expect(signatures).toBe(2);
  });

  it.each([
    "unbound envelope",
    "malformed result",
    "bad sequence",
    "unstructured error",
  ])(
    "keeps a %s locked instead of guessing the submission failed",
    async (fault) => {
      let signatures = 0;
      const setup = createTestnetWalletSetup({
        wallet: {
          ...wallet(),
          sign: async (value) => {
            signatures++;
            const tx = TransactionBuilder.fromXdr(value, Networks.TESTNET);
            tx.sign(owner);
            return tx.toXdr();
          },
        },
        changed() {},
        fetch: async (input, init) => {
          if (String(input).endsWith("/transactions")) {
            return Response.json(
              fault === "unstructured error"
                ? { error: "Bad request" }
                : {
                    type: "https://stellar.org/horizon-errors/transaction_failed",
                    status: 400,
                    extras: {
                      envelope_xdr:
                        fault === "unbound envelope"
                          ? "not-the-signed-envelope"
                          : new URLSearchParams(String(init?.body)).get("tx"),
                      result_codes: {
                        transaction:
                          fault === "bad sequence"
                            ? "tx_bad_seq"
                            : "tx_bad_auth",
                      },
                      result_xdr:
                        fault === "malformed result"
                          ? "invalid"
                          : new xdr.TransactionResult({
                              feeCharged: 0n,
                              result:
                                fault === "bad sequence"
                                  ? xdr.TransactionResultResult.txBadSeq()
                                  : xdr.TransactionResultResult.txBadAuth(),
                              ext: xdr.TransactionResultExt.v0(),
                            }).toXdr("base64"),
                    },
                  },
              { status: 400 }
            );
          }
          if (String(input).includes("/transactions/"))
            return new Response(null, { status: 404 });
          return Response.json(account());
        },
      });
      expect(await setup.addTrustline(address, asset)).toMatchObject({
        pending: true,
      });
      expect(await setup.addTrustline(address, asset)).toMatchObject({
        pending: true,
      });
      expect(signatures).toBe(1);
    }
  );

  it("leaves a sufficiently funded wallet alone", async () => {
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) => {
        expect(String(input)).toBe(
          `https://horizon-testnet.stellar.org/accounts/${address}`
        );
        return Response.json(account());
      },
    });

    expect(await setup.ensureFunding(address)).toMatchObject({
      funded: true,
      balance: "100.0000000",
      spendable: "99.0000000",
      trustline: false,
    });
  });

  it("automatically funds an absent Testnet wallet and confirms its balance", async () => {
    let funded = false;
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) => {
        if (
          String(input) === `https://friendbot.stellar.org/?addr=${address}`
        ) {
          funded = true;
          return Response.json({ successful: true });
        }
        expect(String(input)).toBe(
          `https://horizon-testnet.stellar.org/accounts/${address}`
        );
        return funded
          ? Response.json(account("10000.0000000"))
          : new Response(null, { status: 404 });
      },
    });

    expect(await setup.ensureFunding(address)).toMatchObject({
      funded: true,
      balance: "10000.0000000",
      spendable: "9999.0000000",
    });
  });

  it("never funds or requests a signature on Mainnet", async () => {
    const setup = createTestnetWalletSetup({
      wallet: wallet(Networks.PUBLIC),
      changed() {},
      fetch: async () => {
        throw new Error("Unexpected network access");
      },
    });
    await expect(setup.ensureFunding(address)).rejects.toThrow(
      "Stellar Testnet"
    );
  });

  it("creates only the configured Testnet trustline and confirms it on Horizon", async () => {
    let trustline = false;
    let expectedHash = "";
    const setup = createTestnetWalletSetup({
      wallet: {
        ...wallet(),
        sign: async (xdr, signer) => {
          expect(signer).toBe(address);
          const transaction = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
          expect(transaction).toBeInstanceOf(Transaction);
          if (!(transaction instanceof Transaction))
            throw new Error("Wrong envelope");
          expect(transaction.source).toBe(address);
          expect(transaction.fee).toBe("10000");
          expect(transaction.operations).toHaveLength(1);
          const operation = transaction.operations[0]!;
          expect(operation.type).toBe("changeTrust");
          if (operation.type !== "changeTrust")
            throw new Error("Wrong operation");
          expect(operation.line).toEqual(new Asset("USDC", issuer));
          expect(operation.limit).toBe("1000000.0000000");
          expectedHash = Buffer.from(transaction.hash()).toString("hex");
          transaction.sign(owner);
          return transaction.toXdr();
        },
      },
      changed() {},
      fetch: async (input, init) => {
        if (String(input).endsWith("/transactions")) {
          expect(init?.method).toBe("POST");
          const xdr = new URLSearchParams(String(init?.body)).get("tx")!;
          const transaction = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
          expect(transaction.signatures).toHaveLength(1);
          expect(Buffer.from(transaction.hash()).toString("hex")).toBe(
            expectedHash
          );
          trustline = true;
          return Response.json({ hash: expectedHash, successful: true });
        }
        return Response.json({
          ...account(),
          subentry_count: trustline ? 1 : 0,
          balances: [
            ...account().balances,
            ...(trustline
              ? [
                  {
                    asset_type: "credit_alphanum4",
                    asset_code: "USDC",
                    asset_issuer: issuer,
                    balance: "0.0000000",
                    limit: "1000000.0000000",
                    is_authorized: true,
                    selling_liabilities: "0.0000000",
                    buying_liabilities: "0.0000000",
                  },
                ]
              : []),
          ],
        });
      },
    });
    expect(await setup.addTrustline(address, asset)).toMatchObject({
      trustline: true,
      authorized: true,
      limit: "1000000.0000000",
      tokenBalance: "0.0000000",
      receivable: "1000000.0000000",
      spendableToken: "0.0000000",
      transactionHash: expectedHash,
    });
  });

  it("reconciles a timed-out trustline without asking for another signature", async () => {
    let signatures = 0;
    let transactionHash = "";
    let confirmed = false;
    const setup = createTestnetWalletSetup({
      wallet: {
        ...wallet(),
        sign: async (xdr) => {
          signatures += 1;
          const transaction = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
          transactionHash = Buffer.from(transaction.hash()).toString("hex");
          transaction.sign(owner);
          return transaction.toXdr();
        },
      },
      changed() {},
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/transactions")) throw new Error("Timed out");
        if (url.includes("/transactions/")) {
          expect(url).toBe(
            `https://horizon-testnet.stellar.org/transactions/${transactionHash}`
          );
          return confirmed
            ? Response.json({ hash: transactionHash, successful: true })
            : new Response(null, { status: 404 });
        }
        return Response.json({
          ...account(),
          balances: [
            ...account().balances,
            ...(confirmed
              ? [
                  {
                    asset_type: "credit_alphanum4",
                    asset_code: "USDC",
                    asset_issuer: issuer,
                    balance: "0.0000000",
                    limit: "1000000.0000000",
                    is_authorized: true,
                    selling_liabilities: "0.0000000",
                    buying_liabilities: "0.0000000",
                  },
                ]
              : []),
          ],
        });
      },
    });
    expect(await setup.addTrustline(address, asset)).toMatchObject({
      pending: true,
      trustline: false,
    });
    expect(await setup.addTrustline(address, asset)).toMatchObject({
      pending: true,
    });
    expect(signatures).toBe(1);
    confirmed = true;
    expect(await setup.inspect(address, asset)).toMatchObject({
      pending: false,
      trustline: true,
      authorized: true,
      transactionHash,
    });
    await setup.addTrustline(address, asset);
    expect(signatures).toBe(1);
  });

  it("rejects a wallet changing the trustline transaction before broadcast", async () => {
    const setup = createTestnetWalletSetup({
      wallet: {
        ...wallet(),
        sign: async () => {
          const changed = new TransactionBuilder(new Account(address, "123"), {
            fee: "10000",
            networkPassphrase: Networks.TESTNET,
          })
            .addOperation(
              Operation.changeTrust({
                asset: new Asset("WRONG", issuer),
                limit: "1000000",
              })
            )
            .setTimeout(180)
            .build();
          changed.sign(owner);
          return changed.toXdr();
        },
      },
      changed() {},
      fetch: async (input, init) => {
        expect(init?.method).not.toBe("POST");
        expect(String(input)).toContain("/accounts/");
        return Response.json(account());
      },
    });
    await expect(setup.addTrustline(address, asset)).rejects.toThrow(
      "transaction changed"
    );
  });

  it("does not broadcast when the wallet switches networks after signing", async () => {
    let network = Networks.TESTNET;
    const setup = createTestnetWalletSetup({
      wallet: {
        ...wallet(),
        current: async () => ({ address, network }),
        sign: async (xdr) => {
          const tx = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
          tx.sign(owner);
          network = Networks.PUBLIC;
          return tx.toXdr();
        },
      },
      changed() {},
      fetch: async (input, init) => {
        expect(init?.method).not.toBe("POST");
        expect(String(input)).toContain("/accounts/");
        return Response.json(account());
      },
    });
    await expect(setup.addTrustline(address, asset)).rejects.toThrow(
      "Stellar Testnet"
    );
  });

  it("fails closed for a different wallet account or token contract", async () => {
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async () => Response.json({ ...account(), account_id: issuer }),
    });
    await expect(setup.inspect(address, asset)).rejects.toThrow(
      "different wallet"
    );
    await expect(
      setup.addTrustline(address, {
        ...asset,
        contract: new Asset("WRONG", issuer).contractId(Networks.TESTNET),
      })
    ).rejects.toThrow("token contract");
  });

  it("deduplicates funding and waits after an unconfirmed faucet attempt", async () => {
    let faucetRequests = 0;
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) => {
        if (String(input).startsWith("https://friendbot.stellar.org/")) {
          faucetRequests += 1;
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 404 });
      },
    });
    const first = setup.ensureFunding(address);
    const concurrent = setup.ensureFunding(address);
    await expect(first).rejects.toThrow("not confirmed yet");
    await expect(concurrent).rejects.toThrow("not confirmed yet");
    await expect(setup.ensureFunding(address)).rejects.toThrow("Wait a minute");
    expect(faucetRequests).toBe(1);
  });

  it("keeps a funded wallet usable when an automatic top-up is unavailable", async () => {
    let requests = 0;
    const messages: string[] = [];
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed: (message) => messages.push(message),
      fetch: async (input) => {
        if (String(input).startsWith("https://friendbot.stellar.org/")) {
          requests++;
          return new Response(null, { status: 503 });
        }
        return Response.json(account("5.0000000"));
      },
    });
    expect(await setup.ensureFunding(address)).toMatchObject({
      funded: true,
      spendable: "4.0000000",
    });
    expect(await setup.ensureFunding(address)).toMatchObject({
      funded: true,
      spendable: "4.0000000",
    });
    expect(requests).toBe(1);
    expect(messages).toContain(
      "Automatic Testnet top-up is not confirmed. Your existing balance is still available."
    );
  });

  it("requires the new trustline reserve and fee before requesting approval", async () => {
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) =>
        String(input).startsWith("https://friendbot.stellar.org/")
          ? new Response(null, { status: 503 })
          : Response.json(account("1.5009999")),
    });
    await expect(setup.ensureFunding(address)).resolves.toMatchObject({
      funded: true,
    });
    await expect(setup.addTrustline(address, asset)).rejects.toThrow(
      "0.501 spendable Testnet XLM"
    );
  });

  it("does not submit a trustline that expired while awaiting wallet approval", async () => {
    vi.useFakeTimers();
    try {
      const setup = createTestnetWalletSetup({
        wallet: {
          ...wallet(),
          sign: async (xdr) => {
            const tx = TransactionBuilder.fromXdr(xdr, Networks.TESTNET);
            tx.sign(owner);
            vi.setSystemTime(Date.now() + 181_000);
            return tx.toXdr();
          },
        },
        changed() {},
        fetch: async (input, init) => {
          expect(init?.method).not.toBe("POST");
          expect(String(input)).toContain("/accounts/");
          return Response.json(account());
        },
      });
      await expect(setup.addTrustline(address, asset)).rejects.toThrow(
        "expired"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports exact receiving and spending capacity without replacing an existing trustline", async () => {
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) => {
        expect(String(input)).toContain("/accounts/");
        return Response.json({
          ...account(),
          subentry_count: 1,
          balances: [
            ...account().balances,
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: issuer,
              balance: "3.0000001",
              limit: "100.0000000",
              is_authorized: true,
              selling_liabilities: "2.0000000",
              buying_liabilities: "4.0000000",
            },
          ],
        });
      },
    });
    expect(await setup.addTrustline(address, asset)).toMatchObject({
      spendable: "98.5000000",
      receivable: "92.9999999",
      spendableToken: "1.0000001",
    });
  });

  it("does not try to override issuer authorization on an existing trustline", async () => {
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) => {
        expect(String(input)).toContain("/accounts/");
        return Response.json({
          ...account(),
          balances: [
            ...account().balances,
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: issuer,
              balance: "0.0000000",
              limit: "100.0000000",
              is_authorized: false,
              selling_liabilities: "0.0000000",
              buying_liabilities: "0.0000000",
            },
          ],
        });
      },
    });
    await expect(setup.addTrustline(address, asset)).rejects.toThrow(
      "issuer must authorize"
    );
  });

  it("tops up low spendable XLM even when reserves and liabilities hide a larger balance", async () => {
    let funded = false;
    const setup = createTestnetWalletSetup({
      wallet: wallet(),
      changed() {},
      fetch: async (input) => {
        if (String(input).startsWith("https://friendbot.stellar.org/")) {
          funded = true;
          return Response.json({ successful: true });
        }
        const state = account(funded ? "10000.0000000" : "100.0000000");
        state.subentry_count = 2;
        state.num_sponsoring = 4;
        state.num_sponsored = 2;
        state.balances[0]!.selling_liabilities = "90.0000000";
        return Response.json(state);
      },
    });
    expect(await setup.ensureFunding(address)).toMatchObject({
      spendable: "9907.0000000",
    });
  });
});
