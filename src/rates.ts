/**
 * USD/TRY mid rate. Primary source: Reflector's FX oracle on Stellar MAINNET, read via
 * simulateTransaction (no keys, no fees). Falls back to a static rate when the oracle is
 * unreachable, and always when RATE_SOURCE=static.
 */
import { Account, Contract, TransactionBuilder, Networks, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';
import { applySpread, fmtRate, parseRate, type Side } from './money.js';
import type { Config } from './config.js';

export type RateSource = 'reflector' | 'static' | 'static_fallback';

export interface MidRate {
  midMicro: bigint;
  source: RateSource;
  oracleTimestamp?: number;
  fetchedAt: number;
}

export interface RateService {
  getMid(): Promise<MidRate>;
  quote(side: Side): Promise<{ rateMicro: bigint; mid: MidRate; spreadBps: number }>;
}

// Simulation only needs a syntactically valid source account.
const PLACEHOLDER_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const fxAsset = (code: string) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Other'), xdr.ScVal.scvSymbol(code)]);

async function simCall(server: rpc.Server, contractId: string, method: string, ...args: xdr.ScVal[]) {
  const tx = new TransactionBuilder(new Account(PLACEHOLDER_ACCOUNT, '0'), {
    fee: '100',
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`${method}() simulation failed`);
  return scValToNative(sim.result!.retval);
}

export function createRateService(cfg: Config, log: (msg: string) => void = () => {}): RateService {
  const staticMicro = parseRate(cfg.staticUsdTry, 'STATIC_USDTRY');
  let cache: MidRate | null = null;
  let inflight: Promise<MidRate> | null = null;

  async function fetchReflector(): Promise<MidRate> {
    let lastErr: unknown;
    for (const url of cfg.reflectorRpcUrls) {
      try {
        const server = new rpc.Server(url);
        const decimals = Number(await simCall(server, cfg.reflectorFxContract, 'decimals'));
        const last = await simCall(server, cfg.reflectorFxContract, 'lastprice', fxAsset('TRY'));
        if (!last) throw new Error('lastprice(TRY) returned None');
        // price = USD per 1 TRY scaled by 10^decimals  =>  USD/TRY = 10^decimals / price
        const price = BigInt(last.price);
        const midMicro = (10n ** BigInt(decimals) * 1_000_000n) / price;
        return { midMicro, source: 'reflector', oracleTimestamp: Number(last.timestamp), fetchedAt: Date.now() };
      } catch (e) {
        lastErr = e;
        log(`reflector rpc ${url} failed: ${(e as Error).message}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all reflector RPCs failed');
  }

  async function getMid(): Promise<MidRate> {
    if (cfg.rateSource === 'static') return { midMicro: staticMicro, source: 'static', fetchedAt: Date.now() };
    if (cache && Date.now() - cache.fetchedAt < cfg.rateCacheSeconds * 1000) return cache;
    if (inflight) return inflight;
    inflight = fetchReflector()
      .catch((e) => {
        log(`falling back to static USD/TRY ${fmtRate(staticMicro)}: ${(e as Error).message}`);
        return { midMicro: staticMicro, source: 'static_fallback' as RateSource, fetchedAt: Date.now() };
      })
      .then((r) => {
        cache = r;
        inflight = null;
        return r;
      });
    return inflight;
  }

  return {
    getMid,
    async quote(side) {
      const mid = await getMid();
      return { rateMicro: applySpread(mid.midMicro, cfg.spreadBps, side), mid, spreadBps: cfg.spreadBps };
    },
  };
}
