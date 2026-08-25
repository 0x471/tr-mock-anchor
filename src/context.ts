import type { Config } from './config.js';
import type { DB } from './db.js';
import type { RateService } from './rates.js';
import type { StellarGateway } from './stellar.js';
import type { PartnerRow } from './core/types.js';

export interface Logger {
  info: (msg: string, extra?: unknown) => void;
  warn: (msg: string, extra?: unknown) => void;
  error: (msg: string, extra?: unknown) => void;
}

export interface Deps {
  cfg: Config;
  db: DB;
  stellar: StellarGateway;
  rates: RateService;
  log: Logger;
}

export type AppEnv = { Variables: { partner: PartnerRow } };

export function createLogger(silent = false): Logger {
  const line = (level: string, msg: string, extra?: unknown) => {
    if (silent) return;
    const ts = new Date().toISOString();
    const tail = extra === undefined ? '' : ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra));
    (level === 'error' ? console.error : console.log)(`${ts} ${level.padEnd(5)} ${msg}${tail}`);
  };
  return {
    info: (m, e) => line('info', m, e),
    warn: (m, e) => line('warn', m, e),
    error: (m, e) => line('error', m, e),
  };
}
