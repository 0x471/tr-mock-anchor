import { serve } from '@hono/node-server';
import { config } from './config.js';
import { openDb } from './db.js';
import { createGateway } from './stellar.js';
import { createRateService } from './rates.js';
import { createLogger, type Deps } from './context.js';
import { createApp } from './app.js';
import { createWorkers } from './workers.js';
import { fmtRate, fmtUsdc } from './money.js';

export async function main() {
  const log = createLogger();
  const db = openDb(config.dbPath);
  const stellar = createGateway(config);
  const rates = createRateService(config, (m) => log.warn(m));
  const deps: Deps = { cfg: config, db, stellar, rates, log };
  const app = createApp(deps);

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log.info(`tr-mock-anchor listening on http://localhost:${info.port} (public: ${config.publicUrl})`);
    log.info(`stellar: mode=${stellar.mode} asset=${stellar.assetCode}:${stellar.assetIssuer}`);
    log.info(`treasury: ${stellar.treasuryPublicKey}`);
  });

  void stellar
    .treasuryUsdcBalance()
    .then((b) => {
      log.info(`treasury USDC balance: ${fmtUsdc(b)}`);
      if (b < 100_0000000n) log.warn('treasury is low: fund it (Circle faucet: https://faucet.circle.com, Stellar testnet) or run npm run sweep');
    })
    .catch((e) => log.error(`treasury balance check failed: ${(e as Error).message} (is the account funded with a USDC trustline? run npm run setup:treasury)`));
  void rates.getMid().then((r) => log.info(`USD/TRY mid ${fmtRate(r.midMicro)} (source: ${r.source})`));

  const workers = createWorkers(deps);
  if (config.workers) workers.start();
  else log.warn('WORKERS=false: on-ramps will not settle and off-ramps will not be detected');

  const shutdown = () => {
    log.info('shutting down');
    workers.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
