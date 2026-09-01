/**
 * Read-only admin data viewer, gated by HTTP Basic auth (ADMIN_USER / ADMIN_PASSWORD).
 * Disabled (404) when either credential is unset. Secrets are masked; the kv table (which holds
 * signing/JWT/session secrets) is never exposed. Nothing here can mutate state.
 */
import { Hono, type Context } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import type { AppEnv, Deps } from '../context.js';

const TABLES = [
  'partners', 'customers', 'ledger', 'bank_transfers', 'quotes',
  'onramps', 'offramps', 'payouts', 'webhooks', 'webhook_deliveries',
  'events', 'unmatched_deposits', 'sep_transactions',
] as const;
// kv is intentionally excluded (holds anchor_signing_secret, jwt_secret, session_secret).

const REDACT_FULL = new Set(['password_hash', 'api_key_hash', 'secret']); // shown as ***
const REDACT_KEY = new Set(['api_key']); // shown as prefix…

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function adminRoutes(deps: Deps) {
  const { db, cfg } = deps;
  const app = new Hono<AppEnv>();
  const enabled = !!(cfg.adminUser && cfg.adminPassword);

  const unauthorized = (c: Context) =>
    c.body('Authentication required', 401, { 'WWW-Authenticate': 'Basic realm="TR Mock Anchor admin", charset="UTF-8"' });

  app.use('/admin', async (c, next) => {
    if (!enabled) return c.notFound();
    const h = c.req.header('authorization') ?? '';
    const m = /^Basic\s+(.+)$/i.exec(h);
    if (!m) return unauthorized(c);
    const [user, ...rest] = Buffer.from(m[1]!, 'base64').toString('utf8').split(':');
    const pass = rest.join(':');
    if (!eq(user ?? '', cfg.adminUser) || !eq(pass, cfg.adminPassword)) return unauthorized(c);
    await next();
  });

  app.get('/admin', (c) => {
    const table = TABLES.includes(c.req.query('table') as never) ? (c.req.query('table') as string) : 'customers';
    const limit = Math.min(500, Math.max(1, Number(c.req.query('limit') ?? 100) || 100));

    const counts: Record<string, number> = {};
    for (const t of TABLES) {
      try {
        counts[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      } catch {
        counts[t] = 0;
      }
    }

    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ${limit}`).all() as Record<string, unknown>[];

    const cell = (col: string, val: unknown) => {
      if (REDACT_FULL.has(col)) return '***';
      if (REDACT_KEY.has(col) && typeof val === 'string') return esc(val.slice(0, 14) + '…');
      const s = String(val ?? '');
      return s.length > 120 ? esc(s.slice(0, 120)) + '…' : esc(s);
    };

    const tabs = TABLES.map(
      (t) => `<a href="/admin?table=${t}" class="${t === table ? 'current' : ''}">${t} <span class="ct">${counts[t]}</span></a>`,
    ).join('');

    const thead = `<tr>${cols.map((c2) => `<th>${esc(c2)}</th>`).join('')}</tr>`;
    const tbody = rows.length
      ? rows.map((r) => `<tr>${cols.map((c2) => `<td>${cell(c2, r[c2])}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cols.length}" class="muted">No rows</td></tr>`;

    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" />
<title>Admin · TR Mock Anchor</title><link rel="stylesheet" href="/static/style.css" />
<style>
  .admin-tabs{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 16px}
  .admin-tabs a{padding:5px 10px;border:1px solid var(--line);border-radius:7px;color:var(--muted);font-size:13px}
  .admin-tabs a:hover{color:var(--text);text-decoration:none}
  .admin-tabs a.current{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
  .admin-tabs .ct{opacity:.7;font-size:11px}
  table{font-size:12px} td,th{white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<div class="wrap" style="max-width:1200px">
  <header class="top">
    <div class="brand"><a href="/" style="color:inherit"><span class="dot"></span> TR Mock Anchor</a> <span class="tag">admin · read-only</span></div>
    <nav aria-label="Primary" class="primary-nav"><a href="/dashboard">Dashboard</a><a href="/">Home</a></nav>
  </header>
  <h1 style="font-size:22px;margin:0 0 4px">Backend data <span class="muted" style="font-size:14px">(SQLite on the Fly volume, read-only)</span></h1>
  <p class="small muted">Secrets are masked; the kv table (signing / JWT / session secrets) is not shown. Showing newest ${limit} rows.</p>
  <div class="admin-tabs">${tabs}</div>
  <h2 style="font-size:16px">${esc(table)} <span class="muted">· ${counts[table]} rows</span></h2>
  <div class="tablewrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>
</div>
<script src="/static/site.js"></script>
</body></html>`);
  });

  return app;
}
