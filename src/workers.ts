/**
 * Background loops:
 *  - settleOnramps : pays out pending on-ramps in USDC on Stellar
 *  - watchOfframps : matches inbound USDC payments (by memo id / muxed id) to off-ramps, converts, pays out TRY
 *  - deliverWebhooks : POSTs queued events to partner webhooks with HMAC signatures and retries
 * Each exposes a `*Once()` for tests; `start()` runs them on timers.
 */
import { createHmac } from 'node:crypto';
import type { Deps } from './context.js';
import type { SepContext } from './sepauth.js';
import { createSepContext } from './sepauth.js';
import { bundle, sepStatusOf, sepTransactionOut } from './core/sepstatus.js';
import type { SepTransactionRow } from './core/types.js';
import { kvGet, kvSet, nowIso, tx } from './db.js';
import { newBankReference, newId } from './ids.js';
import { fmtRate, fmtTry, fmtUsdc, parseRate, parseUsdc, usdcToTry } from './money.js';
import { StellarError, type IncomingPayment } from './stellar.js';
import { applyLedger } from './core/ledger.js';
import { emitEvent } from './core/events.js';
import { offrampOut, onrampOut, payoutOut } from './core/serialize.js';
import type { OfframpRow, OnrampRow, PayoutRow, WebhookRow } from './core/types.js';

const MAX_SEND_ATTEMPTS = 5;
const WEBHOOK_BACKOFF_SECONDS = [5, 30, 120, 600];
const CURSOR_KEY = 'horizon_payments_cursor';

export function createWorkers(deps: Deps, sep: SepContext = createSepContext(deps)) {
  const { db, stellar, rates, log } = deps;

  /* ---------------- on-ramps ---------------- */

  async function settleOnrampsOnce(): Promise<number> {
    const rows = db.prepare("SELECT * FROM onramps WHERE status = 'pending' ORDER BY created_at ASC LIMIT 20").all() as unknown as OnrampRow[];
    if (!rows.length) return 0;
    let treasury: bigint;
    try {
      treasury = await stellar.treasuryUsdcBalance();
    } catch (e) {
      log.warn(`treasury balance check failed: ${(e as Error).message}`);
      return 0;
    }
    let settled = 0;
    for (const row of rows) {
      const stroops = parseUsdc(row.amount_usdc);
      if (stroops > treasury) {
        db.prepare("UPDATE onramps SET pending_reason = 'treasury_low', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
        log.warn(`onramp ${row.id} waiting: treasury has ${fmtUsdc(treasury)} USDC, needs ${row.amount_usdc}`);
        continue;
      }
      try {
        const res = await stellar.sendUsdc({
          destination: row.destination_address,
          amountStroops: stroops,
          memo: row.memo ?? undefined,
          allowClaimableBalance: row.claimable_balance_supported !== 0,
        });
        if (res.settlement === 'awaiting_trust') {
          // Wallet did not opt into claimable balances and has no trustline yet. Hold (no funds move,
          // no attempt spent); a later tick pays directly once the trustline appears.
          if (row.pending_reason !== 'awaiting_trust') {
            db.prepare("UPDATE onramps SET pending_reason = 'awaiting_trust', updated_at = ? WHERE id = ?").run(nowIso(), row.id);
            log.info(`onramp ${row.id} awaiting a USDC trustline on ${row.destination_address}`);
          }
          continue;
        }
        treasury -= stroops;
        const ts = nowIso();
        const done: OnrampRow = {
          ...row,
          status: 'completed',
          pending_reason: null,
          settlement: res.settlement,
          tx_hash: res.txHash ?? null,
          claimable_balance_id: res.claimableBalanceId ?? null,
          updated_at: ts,
          completed_at: ts,
        };
        tx(db, () => {
          db.prepare(
            `UPDATE onramps SET status = 'completed', pending_reason = NULL, settlement = ?, tx_hash = ?, claimable_balance_id = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
          ).run(done.settlement, done.tx_hash, done.claimable_balance_id, ts, ts, row.id);
          emitEvent(db, row.partner_id, 'onramp.completed', onrampOut(done));
        });
        settled++;
        log.info(`onramp ${row.id} completed: ${row.amount_usdc} USDC -> ${row.destination_address} via ${res.settlement} (${res.txHash})`);
      } catch (e) {
        const err = e as Error;
        const retryable = err instanceof StellarError ? err.retryable : true;
        const attempts = row.attempts + 1;
        if (retryable && attempts < MAX_SEND_ATTEMPTS) {
          db.prepare("UPDATE onramps SET attempts = ?, pending_reason = ?, updated_at = ? WHERE id = ?").run(attempts, `retrying: ${err.message}`.slice(0, 200), nowIso(), row.id);
          log.warn(`onramp ${row.id} attempt ${attempts} failed (will retry): ${err.message}`);
        } else {
          const ts = nowIso();
          const failed: OnrampRow = { ...row, status: 'failed', pending_reason: null, failure_reason: err.message.slice(0, 500), attempts, updated_at: ts };
          tx(db, () => {
            db.prepare("UPDATE onramps SET status = 'failed', pending_reason = NULL, failure_reason = ?, attempts = ?, updated_at = ? WHERE id = ?").run(
              failed.failure_reason, attempts, ts, row.id,
            );
            // Give the TRY back.
            applyLedger(db, row.customer_id, 'TRY', BigInt(row.amount_try.replace('.', '')), 'onramp_refund', row.id);
            emitEvent(db, row.partner_id, 'onramp.failed', onrampOut(failed));
          });
          log.error(`onramp ${row.id} failed: ${err.message}`);
        }
      }
    }
    return settled;
  }

  /* ---------------- off-ramps ---------------- */

  async function handleIncoming(p: IncomingPayment): Promise<void> {
    const key = p.memoType === 'id' && p.memo ? p.memo : p.toMuxedId;
    const already = db.prepare('SELECT id FROM offramps WHERE tx_hash = ?').get(p.txHash);
    if (already) return;

    const offramp = key ? (db.prepare('SELECT * FROM offramps WHERE memo_id = ?').get(key) as OfframpRow | undefined) : undefined;
    if (!offramp || offramp.status !== 'awaiting_deposit') {
      const reason = !key ? 'missing_memo' : !offramp ? 'no_matching_offramp' : `offramp_${offramp.status}`;
      db.prepare(
        'INSERT INTO unmatched_deposits(id, tx_hash, from_address, amount_usdc, memo_type, memo, to_muxed_id, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      ).run(newId('umd'), p.txHash, p.from, fmtUsdc(p.amountStroops), p.memoType ?? null, p.memo ?? null, p.toMuxedId ?? null, reason, nowIso());
      log.warn(`unmatched USDC deposit ${fmtUsdc(p.amountStroops)} tx ${p.txHash}: ${reason}`);
      return;
    }

    let rateMicro = parseRate(offramp.rate);
    let repriced = false;
    if (new Date(offramp.rate_locked_until).getTime() < Date.now()) {
      rateMicro = (await rates.quote('sell')).rateMicro;
      repriced = true;
    }
    const kurus = usdcToTry(p.amountStroops, rateMicro);
    const ts = nowIso();

    tx(db, () => {
      // USDC lands on the customer's balance, is sold for TRY at the locked rate...
      applyLedger(db, offramp.customer_id, 'USDC', p.amountStroops, 'offramp_deposit', offramp.id);
      applyLedger(db, offramp.customer_id, 'USDC', -p.amountStroops, 'offramp_convert', offramp.id);
      applyLedger(db, offramp.customer_id, 'TRY', kurus, 'offramp_convert', offramp.id);
      const received: OfframpRow = {
        ...offramp,
        received_usdc: fmtUsdc(p.amountStroops),
        amount_try: fmtTry(kurus),
        rate: fmtRate(rateMicro),
        repriced: repriced ? 1 : 0,
        tx_hash: p.txHash,
        from_address: p.from,
        updated_at: ts,
      };
      emitEvent(db, offramp.partner_id, 'offramp.deposit_received', offrampOut(received, stellar.assetCode, stellar.assetIssuer));

      // ...and, if requested, is paid out to the customer's IBAN right away.
      let payoutId: string | null = null;
      if (offramp.auto_payout && offramp.payout_iban) {
        const payout: PayoutRow = {
          id: newId('po'),
          partner_id: offramp.partner_id,
          customer_id: offramp.customer_id,
          offramp_id: offramp.id,
          amount_try: fmtTry(kurus),
          iban: offramp.payout_iban,
          bank_reference: newBankReference(),
          status: 'completed',
          created_at: ts,
        };
        applyLedger(db, offramp.customer_id, 'TRY', -kurus, 'payout', payout.id);
        db.prepare(
          'INSERT INTO payouts(id, partner_id, customer_id, offramp_id, amount_try, iban, bank_reference, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        ).run(payout.id, payout.partner_id, payout.customer_id, payout.offramp_id, payout.amount_try, payout.iban, payout.bank_reference, payout.status, payout.created_at);
        emitEvent(db, offramp.partner_id, 'payout.completed', payoutOut(payout));
        payoutId = payout.id;
      }

      const completed: OfframpRow = { ...received, status: 'completed', payout_id: payoutId, completed_at: ts };
      db.prepare(
        `UPDATE offramps SET status = 'completed', received_usdc = ?, amount_try = ?, rate = ?, repriced = ?, tx_hash = ?, from_address = ?, payout_id = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      ).run(completed.received_usdc, completed.amount_try, completed.rate, completed.repriced, completed.tx_hash, completed.from_address, payoutId, ts, ts, offramp.id);
      emitEvent(db, offramp.partner_id, 'offramp.completed', offrampOut(completed, stellar.assetCode, stellar.assetIssuer));
    });
    log.info(`offramp ${offramp.id} completed: received ${fmtUsdc(p.amountStroops)} USDC -> ${fmtTry(kurus)} TRY${repriced ? ' (repriced)' : ''} tx ${p.txHash}`);
  }

  async function watchOfframpsOnce(): Promise<number> {
    const cursor = kvGet(db, CURSOR_KEY);
    const { payments, cursor: next } = await stellar.incomingUsdc(cursor);
    for (const p of payments) {
      try {
        await handleIncoming(p);
      } catch (e) {
        log.error(`failed to process incoming payment ${p.txHash}: ${(e as Error).message}`);
      }
    }
    if (next && next !== cursor) kvSet(db, CURSOR_KEY, next);
    return payments.length;
  }

  /* ---------------- webhooks ---------------- */

  interface DeliveryRow {
    id: string;
    webhook_id: string;
    event_type: string;
    payload: string;
    attempts: number;
  }

  async function deliverWebhooksOnce(): Promise<number> {
    const due = db
      .prepare("SELECT id, webhook_id, event_type, payload, attempts FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT 20")
      .all(nowIso()) as unknown as DeliveryRow[];
    let delivered = 0;
    for (const d of due) {
      const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND active = 1').get(d.webhook_id) as WebhookRow | undefined;
      if (!hook) {
        db.prepare("UPDATE webhook_deliveries SET status = 'cancelled' WHERE id = ?").run(d.id);
        continue;
      }
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', hook.secret).update(`${t}.${d.payload}`).digest('hex');
      let statusCode: number | null = null;
      let error: string | null = null;
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': 'tr-mock-anchor-webhooks/1.0',
            'x-trma-signature': `t=${t},v1=${sig}`,
            'x-trma-event': d.event_type,
            'x-trma-delivery': d.id,
          },
          body: d.payload,
          signal: AbortSignal.timeout(8000),
        });
        statusCode = res.status;
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = (e as Error).message;
      }
      const attempts = d.attempts + 1;
      if (!error) {
        db.prepare("UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_status_code = ?, last_error = NULL, delivered_at = ? WHERE id = ?").run(attempts, statusCode, nowIso(), d.id);
        delivered++;
      } else if (attempts > WEBHOOK_BACKOFF_SECONDS.length) {
        db.prepare("UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_status_code = ?, last_error = ? WHERE id = ?").run(attempts, statusCode, error, d.id);
        log.warn(`webhook ${hook.id} delivery ${d.id} gave up after ${attempts} attempts: ${error}`);
      } else {
        const wait = WEBHOOK_BACKOFF_SECONDS[attempts - 1]!;
        db.prepare("UPDATE webhook_deliveries SET attempts = ?, last_status_code = ?, last_error = ?, next_attempt_at = ? WHERE id = ?").run(
          attempts, statusCode, error, new Date(Date.now() + wait * 1000).toISOString(), d.id,
        );
      }
    }
    return delivered;
  }

  /* ---------------- SEP-6 on_change_callback ---------------- */

  /** POST the SEP-6 transaction object to the wallet's callback whenever the status changes. */
  async function sepCallbacksOnce(): Promise<number> {
    const rows = db
      .prepare("SELECT * FROM sep_transactions WHERE on_change_callback IS NOT NULL AND on_change_callback != 'postMessage'")
      .all() as unknown as SepTransactionRow[];
    let sent = 0;
    for (const row of rows) {
      const b = bundle(db, row);
      const status = sepStatusOf(b);
      if (status === row.last_callback_status) continue;
      const body = JSON.stringify({ transaction: sepTransactionOut(deps.cfg, stellar, b) });
      const t = Math.floor(Date.now() / 1000);
      const host = safeHost(row.on_change_callback!);
      const sig = Buffer.from(sep.signingKeypair.sign(Buffer.from(`${t}.${host}.${body}`))).toString('base64');
      try {
        const res = await fetch(row.on_change_callback!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Signature: `t=${t}, s=${sig}`, 'X-Stellar-Signature': `t=${t}, s=${sig}` },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        sent++;
      } catch (e) {
        log.warn(`sep callback for ${row.id} failed: ${(e as Error).message}`);
      }
      // Record the attempt either way so a dead callback does not spin every tick.
      db.prepare('UPDATE sep_transactions SET last_callback_status = ? WHERE id = ?').run(status, row.id);
      if (status === 'completed' || status === 'error') {
        db.prepare('UPDATE sep_transactions SET completed_at = COALESCE(completed_at, ?) WHERE id = ?').run(nowIso(), row.id);
      }
    }
    return sent;
  }
  function safeHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }

  /* ---------------- runner ---------------- */

  function loop(name: string, fn: () => Promise<unknown>, ms: number) {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (e) {
        log.error(`${name} tick failed: ${(e as Error).message}`);
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  let stops: Array<() => void> = [];
  return {
    settleOnrampsOnce,
    watchOfframpsOnce,
    deliverWebhooksOnce,
    sepCallbacksOnce,
    start() {
      stops = [
        loop('settleOnramps', settleOnrampsOnce, deps.cfg.pollMs.onramp),
        loop('watchOfframps', watchOfframpsOnce, deps.cfg.pollMs.offramp),
        loop('deliverWebhooks', deliverWebhooksOnce, deps.cfg.pollMs.webhook),
        loop('sepCallbacks', sepCallbacksOnce, deps.cfg.pollMs.webhook),
      ];
      log.info('workers started');
    },
    stop() {
      for (const s of stops) s();
      stops = [];
    },
  };
}

export type Workers = ReturnType<typeof createWorkers>;
