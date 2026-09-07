/**
 * SEP-6 programmatic deposit/withdraw (TRANSFER_SERVER). Wallet users authenticate with SEP-10.
 *  - /deposit  : opens a deposit and returns bank instructions (IBAN + reference). Since the bank is
 *                simulated, the TRY "arrives" when someone calls the sandbox endpoint or presses the
 *                button on more_info_url; the on-ramp then pays real testnet USDC.
 *  - /withdraw : opens an off-ramp and returns the treasury account + memo id; the real payment is
 *                detected on Horizon and TRY is paid out (simulated FAST).
 */
import { Hono, type Context } from 'hono';
import { StrKey } from '@stellar/stellar-sdk';
import type { Deps } from '../context.js';
import { newId } from '../ids.js';
import { nowIso, tx } from '../db.js';
import { ApiError } from '../errors.js';
import { MoneyError, fmtTry, parseTry, parseUsdc } from '../money.js';
import { makeDepositReference } from '../turkey.js';
import { applyLedger } from '../core/ledger.js';
import { emitEvent } from '../core/events.js';
import { bankTransferOut } from '../core/serialize.js';
import { createOfframp, createOnramp, resolveRate } from '../core/orders.js';
import { TRY_ASSET, usdcAsset } from '../core/sep.js';
import { stellarPayUri } from '../sep7.js';
import { bundle, depositInstructions, loadSepTx, sepStatusOf, sepTransactionOut, type SepBundle } from '../core/sepstatus.js';
import { sepError, sepJwtAuth, subAccount, type SepContext, type SepEnv } from '../sepauth.js';
import type { BankTransferRow, QuoteRow, SepTransactionRow } from '../core/types.js';

const FUNDING_METHOD = 'bank_account';

export function sep6Routes(deps: Deps, sep: SepContext) {
  const { db, cfg, stellar } = deps;
  const USDC = usdcAsset(stellar.assetCode, stellar.assetIssuer);
  const app = new Hono<SepEnv>();
  const feePercent = cfg.spreadBps / 100;

  app.get('/sep6/info', (c) => {
    const asset = {
      enabled: true,
      authentication_required: true,
      min_amount: Number(cfg.minOnrampTry) / 100, // rough USDC-denominated floor for wallets that display it
      max_amount: Number(cfg.maxOnrampTry) / 10,
      fee_percent: feePercent,
      funding_methods: [FUNDING_METHOD],
    };
    // Some wallets (e.g. the Stellar demo wallet) assume a `type` field with choices exists on the
    // deposit info and read `fields.type.choices` directly. Provide it so those wallets can render
    // the deposit form. Our handler treats `type` as an alias of `funding_method`.
    const depositFields = {
      type: {
        description: 'How the TRY arrives. Only bank_account (bank transfer) is supported.',
        choices: [FUNDING_METHOD],
        optional: false,
      },
    };
    return c.json({
      deposit: { [stellar.assetCode]: { ...asset, fields: depositFields } },
      'deposit-exchange': { [stellar.assetCode]: { ...asset, fields: depositFields } },
      withdraw: { [stellar.assetCode]: { ...asset, types: { [FUNDING_METHOD]: { fields: {} } } } },
      'withdraw-exchange': { [stellar.assetCode]: { ...asset, types: { [FUNDING_METHOD]: { fields: {} } } } },
      fee: { enabled: false, description: 'Fee is a flat spread over the USD/TRY mid rate; see /sep38/price or the fee fields on each transaction.' },
      transactions: { enabled: true, authentication_required: true },
      transaction: { enabled: true, authentication_required: true },
      features: { account_creation: false, claimable_balances: true },
    });
  });

  // Public sandbox helpers: the "bank" and the more_info_url page. Everything else needs a SEP-10 token.
  app.get('/sep6/tx/:id', (c) => {
    const b = loadSepTx(db, c.req.param('id'));
    if (!b) return c.html(page('Transaction not found', '<p>No such transaction.</p>'), 404);
    return c.html(txPage(b));
  });
  app.post('/sep6/tx/:id/simulate-bank-transfer', async (c) => {
    const b = loadSepTx(db, c.req.param('id'));
    if (!b) return sepError(c, 404, 'transaction not found');
    let amount: string | undefined;
    try {
      const ct = c.req.header('content-type') ?? '';
      const body = ct.includes('application/json') ? ((await c.req.json()) as Record<string, unknown>) : ((await c.req.parseBody()) as Record<string, unknown>);
      amount = typeof body.amount === 'string' && body.amount ? body.amount : typeof body.amount === 'number' ? String(body.amount) : undefined;
    } catch {
      /* empty body is fine */
    }
    try {
      const updated = await fundSepDeposit(b, amount);
      const accept = c.req.header('accept') ?? '';
      if (accept.includes('text/html')) return c.redirect(`/sep6/tx/${b.tx.id}`);
      return c.json({ ok: true, transaction: sepTransactionOut(cfg, stellar, updated) });
    } catch (e) {
      if (e instanceof ApiError) return c.json({ error: e.message, code: e.code }, e.status as 400);
      if (e instanceof MoneyError) return sepError(c, 400, e.message);
      throw e;
    }
  });

  app.use('/sep6/*', async (c, next) => {
    if (c.req.path.startsWith('/sep6/tx/') || c.req.path === '/sep6/info') return next();
    return sepJwtAuth(deps, sep)(c, next);
  });

  /* ---------------- deposit ---------------- */

  // The on-chain asset comes from a different query param per endpoint: `asset_code` for plain
  // deposit/withdraw, `destination_asset` for deposit-exchange, `source_asset` for withdraw-exchange
  // (the -exchange endpoints have no `asset_code`; the off-chain leg is the other SEP-38 param).
  function parseCommon(c: Context<SepEnv>, onchainAssetParam: string) {
    const q = (k: string) => c.req.query(k);
    const assetCode = q(onchainAssetParam);
    if (!assetCode) return { error: `'${onchainAssetParam}' is required` };
    if (assetCode !== stellar.assetCode) return { error: `unsupported ${onchainAssetParam} '${assetCode}'; this anchor ramps ${stellar.assetCode}` };
    const funding = q('funding_method') ?? q('type');
    if (funding && funding !== FUNDING_METHOD) return { error: `unsupported funding_method '${funding}'; use ${FUNDING_METHOD}` };
    const lang = q('lang') ?? null;
    const callback = q('on_change_callback') ?? null;
    if (callback && callback !== 'postMessage' && !/^https?:\/\//.test(callback)) return { error: "'on_change_callback' must be a URL" };
    return { assetCode, funding: funding ?? FUNDING_METHOD, lang, callback };
  }

  function insertSepTx(row: Omit<SepTransactionRow, 'created_at' | 'updated_at' | 'completed_at' | 'last_callback_status' | 'status_override' | 'message'>) {
    const ts = nowIso();
    db.prepare(
      `INSERT INTO sep_transactions(id, partner_id, customer_id, stellar_account, kind, account, memo, memo_type, amount_expected, source_asset, destination_asset, quote_id, funding_method, claimable_balance_supported, on_change_callback, lang, reference, refund_memo, refund_memo_type, onramp_id, offramp_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.id, row.partner_id, row.customer_id, row.stellar_account, row.kind, row.account, row.memo, row.memo_type, row.amount_expected,
      row.source_asset, row.destination_asset, row.quote_id, row.funding_method, row.claimable_balance_supported, row.on_change_callback,
      row.lang, row.reference, row.refund_memo, row.refund_memo_type, row.onramp_id, row.offramp_id, ts, ts,
    );
  }

  async function deposit(c: Context<SepEnv>, exchange: boolean) {
    const common = parseCommon(c, exchange ? 'destination_asset' : 'asset_code');
    if ('error' in common) return sepError(c, 400, common.error as string);
    const q = (k: string) => c.req.query(k);
    const customer = c.get('sepCustomer');
    const account: string = q('account') ?? subAccount(c.get('sepSub'));
    if (!StrKey.isValidEd25519PublicKey(account) && !StrKey.isValidMed25519PublicKey(account)) {
      return sepError(c, 400, "'account' must be a Stellar G... or M... address (contract addresses are not supported)");
    }
    const memoType = q('memo_type') ?? null;
    const memo = q('memo') ?? null;
    if (memo && memoType && !['text', 'id', 'hash'].includes(memoType)) return sepError(c, 400, "'memo_type' must be text, id or hash");

    let amount: string | null = null;
    let quote: QuoteRow | null = null;
    if (exchange) {
      // destination_asset (the on-chain USDC code) is validated in parseCommon; here we check the
      // off-chain leg. source_asset is the SEP-38 identifier for TRY.
      if (q('source_asset') !== TRY_ASSET) return sepError(c, 400, `'source_asset' must be ${TRY_ASSET}`);
      if (!q('amount')) return sepError(c, 400, "'amount' is required for /deposit-exchange");
      if (q('quote_id')) {
        quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND customer_id = ?').get(q('quote_id')!, customer.id) as unknown as QuoteRow | undefined ?? null;
        if (!quote) return sepError(c, 400, 'quote_id not found for this account');
        if (quote.side !== 'buy') return sepError(c, 400, 'quote_id must sell TRY and buy USDC for a deposit');
        if (quote.consumed_by) return sepError(c, 400, 'quote_id was already used');
        if (new Date(quote.expires_at).getTime() < Date.now()) return sepError(c, 400, 'quote_id has expired');
        if (quote.source_amount !== fmtTry(parseTry(q('amount')!))) return sepError(c, 400, `amount must equal the quote's sell_amount (${quote.source_amount})`);
      }
    }
    if (q('amount')) {
      try {
        const kurus = parseTry(q('amount')!, 'amount');
        if (kurus < parseTry(cfg.minOnrampTry)) return sepError(c, 400, `amount below minimum (${cfg.minOnrampTry} TRY)`);
        if (kurus > parseTry(cfg.maxOnrampTry)) return sepError(c, 400, `amount above maximum (${cfg.maxOnrampTry} TRY)`);
        amount = fmtTry(kurus);
      } catch (e) {
        return sepError(c, 400, (e as Error).message);
      }
    }

    const id = newId('sep');
    const reference = makeDepositReference();
    insertSepTx({
      id,
      partner_id: customer.partner_id,
      customer_id: customer.id,
      stellar_account: c.get('sepSub'),
      kind: 'deposit',
      account,
      memo,
      memo_type: memo ? memoType ?? 'text' : null,
      amount_expected: amount,
      source_asset: TRY_ASSET,
      destination_asset: USDC,
      quote_id: quote?.id ?? null,
      funding_method: common.funding,
      claimable_balance_supported: q('claimable_balance_supported') === 'true' ? 1 : 0,
      on_change_callback: common.callback,
      lang: common.lang,
      reference,
      refund_memo: null,
      refund_memo_type: null,
      onramp_id: null,
      offramp_id: null,
    });
    const moreInfo = `${cfg.publicUrl}/sep6/tx/${id}`;
    return c.json({
      id,
      how: `Send TRY to IBAN ${cfg.anchorIban} (${cfg.bankName}) with "${reference}" in the transfer description. Sandbox: simulate the transfer at ${moreInfo}`,
      instructions: depositInstructions(cfg, reference),
      eta: 5,
      min_amount: Number(cfg.minOnrampTry),
      max_amount: Number(cfg.maxOnrampTry),
      fee_percent: feePercent,
      extra_info: {
        message: `This is a sandbox: no real bank exists. Simulate the incoming TRY transfer at ${moreInfo} (or POST ${moreInfo}/simulate-bank-transfer). Real testnet ${stellar.assetCode} is then paid to ${account}.`,
      },
    });
  }

  app.get('/sep6/deposit', (c) => deposit(c, false));
  app.get('/sep6/deposit-exchange', (c) => deposit(c, true));

  /** The simulated bank: TRY arrives for a SEP deposit -> credit, then on-ramp for the arrived amount. */
  async function fundSepDeposit(b: SepBundle, amount?: string): Promise<SepBundle> {
    if (b.tx.kind !== 'deposit') throw new ApiError(400, 'not_a_deposit', 'Only deposits receive bank transfers');
    if (b.tx.onramp_id) throw new ApiError(409, 'already_funded', 'This deposit already received its bank transfer');
    if (b.tx.status_override) throw new ApiError(409, 'not_pending', `Deposit is ${b.tx.status_override}`);
    const kurus = parseTry(amount ?? b.tx.amount_expected ?? '1000.00', 'amount');
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.tx.customer_id) as unknown as import('../core/types.js').CustomerRow;
    let quote: QuoteRow | null = null;
    if (b.tx.quote_id) {
      const qrow = db.prepare('SELECT * FROM quotes WHERE id = ?').get(b.tx.quote_id) as unknown as QuoteRow | undefined;
      if (qrow && !qrow.consumed_by && new Date(qrow.expires_at).getTime() >= Date.now() && qrow.source_amount === fmtTry(kurus)) quote = qrow;
    }
    const rate = await resolveRate(deps, 'buy', quote);
    tx(db, () => {
      const ts = nowIso();
      const bt: BankTransferRow = {
        id: newId('bt'),
        partner_id: customer.partner_id,
        customer_id: customer.id,
        reference: b.tx.reference,
        amount_try: fmtTry(kurus),
        sender_name: 'Wallet user (simulated)',
        sender_iban: null,
        status: 'matched',
        created_at: ts,
        matched_at: ts,
      };
      applyLedger(db, customer.id, 'TRY', kurus, 'bank_transfer', bt.id);
      db.prepare(
        'INSERT INTO bank_transfers(id, partner_id, customer_id, reference, amount_try, sender_name, sender_iban, status, created_at, matched_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(bt.id, bt.partner_id, bt.customer_id, bt.reference, bt.amount_try, bt.sender_name, bt.sender_iban, bt.status, bt.created_at, bt.matched_at);
      emitEvent(db, customer.partner_id, 'bank_transfer.received', bankTransferOut(bt));
      const onramp = createOnramp(deps, customer, {
        kurus,
        rate,
        destination: b.tx.account!,
        memo: b.tx.memo_type === 'text' ? b.tx.memo : null,
        // Respect SEP-6 claimable_balance_supported: when the wallet did not opt in, hold the USDC
        // in pending_trust until a trustline exists instead of sending a claimable balance.
        claimableBalanceSupported: b.tx.claimable_balance_supported === 1,
      });
      const note = b.tx.quote_id && !quote ? 'Quote expired or amount differed; converted at the live rate.' : null;
      db.prepare('UPDATE sep_transactions SET onramp_id = ?, message = ?, updated_at = ? WHERE id = ?').run(onramp.id, note, ts, b.tx.id);
    });
    return loadSepTx(db, b.tx.id)!;
  }

  /* ---------------- withdraw ---------------- */

  async function withdraw(c: Context<SepEnv>, exchange: boolean) {
    const common = parseCommon(c, exchange ? 'source_asset' : 'asset_code');
    if ('error' in common) return sepError(c, 400, common.error as string);
    const q = (k: string) => c.req.query(k);
    const customer = c.get('sepCustomer');
    const account: string = q('account') ?? subAccount(c.get('sepSub'));
    let expected: bigint | null = null;
    let quote: QuoteRow | null = null;
    if (exchange) {
      // source_asset (the on-chain USDC code) is validated in parseCommon; here we check the
      // off-chain leg. destination_asset is the SEP-38 identifier for TRY.
      if (q('destination_asset') !== TRY_ASSET) return sepError(c, 400, `'destination_asset' must be ${TRY_ASSET}`);
      if (!q('amount')) return sepError(c, 400, "'amount' is required for /withdraw-exchange");
      if (q('quote_id')) {
        quote = db.prepare('SELECT * FROM quotes WHERE id = ? AND customer_id = ?').get(q('quote_id')!, customer.id) as unknown as QuoteRow | undefined ?? null;
        if (!quote) return sepError(c, 400, 'quote_id not found for this account');
        if (quote.side !== 'sell') return sepError(c, 400, 'quote_id must sell USDC and buy TRY for a withdrawal');
        if (quote.consumed_by) return sepError(c, 400, 'quote_id was already used');
        if (new Date(quote.expires_at).getTime() < Date.now()) return sepError(c, 400, 'quote_id has expired');
      }
    }
    if (q('amount')) {
      try {
        expected = parseUsdc(q('amount')!, 'amount');
      } catch (e) {
        return sepError(c, 400, (e as Error).message);
      }
    }
    const refundMemo = q('refund_memo') ?? null;
    const refundMemoType = q('refund_memo_type') ?? null;
    if (refundMemo && refundMemoType && !['text', 'id', 'hash'].includes(refundMemoType)) return sepError(c, 400, "'refund_memo_type' must be text, id or hash");

    try {
      const rate = await resolveRate(deps, 'sell', quote);
      const id = newId('sep');
      const offramp = tx(db, () => {
        const row = createOfframp(deps, customer, { expected, rate, autoPayout: true, payoutIban: customer.iban });
        insertSepTx({
          id,
          partner_id: customer.partner_id,
          customer_id: customer.id,
          stellar_account: c.get('sepSub'),
          kind: 'withdrawal',
          account,
          memo: null,
          memo_type: null,
          amount_expected: expected === null ? null : row.expected_usdc,
          source_asset: USDC,
          destination_asset: TRY_ASSET,
          quote_id: quote?.id ?? null,
          funding_method: common.funding,
          claimable_balance_supported: 0,
          on_change_callback: common.callback,
          lang: common.lang,
          reference: null,
          refund_memo: refundMemo,
          refund_memo_type: refundMemo ? refundMemoType ?? 'text' : null,
          onramp_id: null,
          offramp_id: row.id,
        });
        return row;
      });
      return c.json({
        account_id: offramp.deposit_address,
        memo_type: 'id',
        memo: offramp.memo_id,
        id,
        eta: 10,
        min_amount: Number(cfg.minOfframpUsdc),
        fee_percent: feePercent,
        extra_info: {
          message: `Send ${offramp.expected_usdc ?? 'any amount of'} ${stellar.assetCode} to ${offramp.deposit_address} with memo (type id) ${offramp.memo_id}. Rate ${offramp.rate} TRY/USDC locked until ${offramp.rate_locked_until}. TRY is paid (simulated) to ${customer.iban}.`,
          payment_uri: stellarPayUri({ destination: offramp.deposit_address, assetCode: stellar.assetCode, assetIssuer: stellar.assetIssuer, memoId: offramp.memo_id, amount: offramp.expected_usdc, msg: 'TR Mock Anchor withdrawal' }),
        },
      });
    } catch (e) {
      if (e instanceof ApiError) return c.json({ error: e.message }, e.status === 422 ? 400 : (e.status as 400));
      throw e;
    }
  }

  app.get('/sep6/withdraw', (c) => withdraw(c, false));
  app.get('/sep6/withdraw-exchange', (c) => withdraw(c, true));

  /* ---------------- transactions ---------------- */

  app.get('/sep6/transactions', (c) => {
    const q = (k: string) => c.req.query(k);
    if (!q('asset_code')) return sepError(c, 400, "'asset_code' is required");
    if (q('asset_code') !== stellar.assetCode) return sepError(c, 400, `unsupported asset_code '${q('asset_code')}'`);
    const customer = c.get('sepCustomer');
    const kind = q('kind');
    if (kind && kind !== 'deposit' && kind !== 'withdrawal') return sepError(c, 400, "'kind' must be deposit or withdrawal");
    const limit = Math.min(200, Math.max(1, Number(q('limit') ?? 50) || 50));
    const noOlderThan = q('no_older_than') ?? null;
    if (noOlderThan && Number.isNaN(new Date(noOlderThan).getTime())) return sepError(c, 400, "'no_older_than' must be an ISO 8601 timestamp");
    let pagingBefore: string | null = null;
    if (q('paging_id')) {
      const ref = db.prepare('SELECT created_at FROM sep_transactions WHERE id = ? AND customer_id = ?').get(q('paging_id')!, customer.id) as { created_at: string } | undefined;
      if (!ref) return sepError(c, 400, "'paging_id' does not refer to one of your transactions");
      pagingBefore = ref.created_at;
    }
    const rows = db
      .prepare(
        `SELECT * FROM sep_transactions WHERE customer_id = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR created_at >= ?) AND (? IS NULL OR created_at < ?)
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(customer.id, kind ?? null, kind ?? null, noOlderThan ? new Date(noOlderThan).toISOString() : null, noOlderThan ? new Date(noOlderThan).toISOString() : null, pagingBefore, pagingBefore, limit) as unknown as SepTransactionRow[];
    return c.json({ transactions: rows.map((r) => sepTransactionOut(cfg, stellar, bundle(db, r))) });
  });

  app.get('/sep6/transaction', (c) => {
    const q = (k: string) => c.req.query(k);
    const customer = c.get('sepCustomer');
    let row: SepTransactionRow | undefined;
    if (q('id')) row = db.prepare('SELECT * FROM sep_transactions WHERE id = ? AND customer_id = ?').get(q('id')!, customer.id) as unknown as SepTransactionRow | undefined;
    else if (q('stellar_transaction_id')) {
      row = db
        .prepare(
          `SELECT s.* FROM sep_transactions s
           LEFT JOIN onramps o ON o.id = s.onramp_id LEFT JOIN offramps f ON f.id = s.offramp_id
           WHERE s.customer_id = ? AND (o.tx_hash = ? OR f.tx_hash = ?) LIMIT 1`,
        )
        .get(customer.id, q('stellar_transaction_id')!, q('stellar_transaction_id')!) as unknown as SepTransactionRow | undefined;
    } else if (q('external_transaction_id')) {
      row = db
        .prepare(
          `SELECT s.* FROM sep_transactions s
           LEFT JOIN offramps f ON f.id = s.offramp_id LEFT JOIN payouts p ON p.id = f.payout_id
           WHERE s.customer_id = ? AND (s.reference = ? OR p.bank_reference = ?) LIMIT 1`,
        )
        .get(customer.id, q('external_transaction_id')!, q('external_transaction_id')!) as unknown as SepTransactionRow | undefined;
    } else return sepError(c, 400, "provide 'id', 'stellar_transaction_id' or 'external_transaction_id'");
    if (!row) return sepError(c, 404, 'transaction not found');
    return c.json({ transaction: sepTransactionOut(cfg, stellar, bundle(db, row)) });
  });

  /* ---------------- more_info_url page ---------------- */

  function page(title: string, body: string, extraHead = '') {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · TR Mock Anchor</title><link rel="stylesheet" href="/static/style.css"><script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script>${extraHead}</head><body><div class="wrap" style="max-width:760px"><header class="top"><div class="brand"><a href="/" style="color:inherit"><span class="dot"></span> TR Mock Anchor</a> <span class="tag">SEP-6 transaction</span></div><nav><a href="/guide#sep6">Guide</a></nav></header>${body}<footer>Testnet sandbox. No real money moves.</footer></div></body></html>`;
  }
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

  function txPage(b: SepBundle) {
    const t = sepTransactionOut(cfg, stellar, b) as Record<string, unknown>;
    const status = sepStatusOf(b);
    const rows = Object.entries(t)
      .filter(([k, v]) => v !== null && v !== undefined && typeof v !== 'object' && !['more_info_url', 'refunded'].includes(k))
      .map(([k, v]) => {
        const val = k === 'stellar_transaction_id' ? `<a class="mono" target="_blank" rel="noopener" href="https://stellar.expert/explorer/testnet/tx/${esc(v)}">${esc(v)}</a>` : `<span class="mono">${esc(v)}</span>`;
        return `<dt>${esc(k)}</dt><dd>${val}</dd>`;
      })
      .join('');
    let action = '';
    if (b.tx.kind === 'deposit' && status === 'pending_user_transfer_start') {
      const instr = depositInstructions(cfg, b.tx.reference!);
      action = `<section class="panel accent"><h3>Play the bank</h3><p>In real life the customer now sends TRY to <span class="mono">${esc(instr.bank_account_number.value)}</span> with <b class="mono">${esc(b.tx.reference)}</b> in the description. This is a sandbox, so press the button and the anchor will treat the transfer as received, then pay real testnet ${esc(stellar.assetCode)} to <span class="mono">${esc(b.tx.account)}</span>.</p>
        <form method="post" action="/sep6/tx/${esc(b.tx.id)}/simulate-bank-transfer" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><input type="hidden" name="_" value="1"><label for="amt" class="small">TRY amount</label><input id="amt" name="amount" type="number" step="0.01" min="${esc(cfg.minOnrampTry)}" value="${esc(b.tx.amount_expected ?? '1000.00')}" style="max-width:160px"><button class="primary" type="submit">Simulate incoming TRY transfer</button></form></section>`;
    } else if (b.tx.kind === 'withdrawal' && status === 'pending_user_transfer_start') {
      const uri = stellarPayUri({ destination: b.offramp!.deposit_address, assetCode: stellar.assetCode, assetIssuer: stellar.assetIssuer, memoId: b.offramp!.memo_id, amount: b.offramp!.expected_usdc, msg: 'TR Mock Anchor withdrawal' });
      action = `<section class="panel accent"><h3>Waiting for your USDC</h3><p>Send <b>${esc(b.offramp?.expected_usdc ?? 'any amount of')} ${esc(stellar.assetCode)}</b> from your wallet to <span class="mono">${esc(b.offramp?.deposit_address)}</span> with memo (type <b>id</b>) <b class="mono">${esc(b.offramp?.memo_id)}</b>.</p>
        <p><a class="btn" href="${esc(uri)}">Open in a Stellar wallet</a> <button class="small" type="button" onclick="navigator.clipboard.writeText(${JSON.stringify(uri)});this.textContent='Copied'">Copy pay link</button></p>
        <div id="qr" style="background:#fff;display:inline-block;padding:10px;border-radius:10px"></div>
        <p class="muted small">Scan with a Stellar wallet, or click above. This page refreshes every 5 seconds.</p>
        <script>try{var q=qrcode(0,'M');q.addData(${JSON.stringify(uri)});q.make();document.getElementById('qr').innerHTML=q.createImgTag(4,10);}catch(e){document.getElementById('qr').remove();}</script></section>`;
    } else if (status === 'completed') {
      action = `<section class="panel"><h3 class="ok">Completed</h3><p>${esc(t.message)}</p></section>`;
    }
    const refresh = status.startsWith('pending') ? '<meta http-equiv="refresh" content="5">' : '';
    return page(`${b.tx.kind} ${b.tx.id}`, `<h1 style="font-size:24px">${esc(b.tx.kind)} · <span class="status ${esc(status)}">${esc(status)}</span></h1>${action}<section class="panel" style="margin-top:14px"><dl class="kv">${rows}</dl></section>`, refresh);
  }

  return app;
}
