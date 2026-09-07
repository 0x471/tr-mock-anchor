/**
 * SEP-10 web authentication. GET issues a challenge transaction signed by the anchor's SIGNING_KEY;
 * POST verifies the client's signatures and returns a JWT the SEP-6/12/38 endpoints accept.
 */
import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { Keypair, StrKey, WebAuth } from '@stellar/stellar-sdk';
import type { AppEnv, Deps } from '../context.js';
import type { SepContext } from '../sepauth.js';
import { signJwt } from '../jwt.js';

const CHALLENGE_TIMEOUT_SECONDS = 900;
const TOKEN_TTL_SECONDS = 24 * 3600;

async function fetchClientDomainSigningKey(clientDomain: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${clientDomain}/.well-known/stellar.toml`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const m = (await res.text()).match(/^\s*SIGNING_KEY\s*=\s*"([A-Z0-9]{56})"/m);
    return m && StrKey.isValidEd25519PublicKey(m[1]!) ? m[1]! : null;
  } catch {
    return null;
  }
}

export function sep10Routes(deps: Deps, sep: SepContext) {
  const { cfg, stellar } = deps;
  const app = new Hono<AppEnv>();
  const server = sep.signingKeypair;
  const homeDomain = sep.homeDomain;
  const err = (c: Context<AppEnv>, status: 400, message: string) => c.json({ error: message }, status);

  app.get('/auth', async (c) => {
    const account = c.req.query('account') ?? '';
    const memo = c.req.query('memo') ?? null;
    const clientDomain = c.req.query('client_domain') ?? null;
    const requestedHome = c.req.query('home_domain');
    if (!StrKey.isValidEd25519PublicKey(account) && !StrKey.isValidMed25519PublicKey(account)) {
      return err(c, 400, "'account' must be a valid Stellar account (G...) or muxed account (M...)");
    }
    if (memo !== null) {
      if (StrKey.isValidMed25519PublicKey(account)) return err(c, 400, "'memo' cannot be used with a muxed account");
      if (!/^\d+$/.test(memo)) return err(c, 400, "'memo' must be an unsigned 64-bit integer (memo type id)");
    }
    if (requestedHome && requestedHome !== homeDomain) return err(c, 400, `unsupported 'home_domain'; expected ${homeDomain}`);
    let clientSigningKey: string | null = null;
    if (clientDomain) {
      clientSigningKey = await fetchClientDomainSigningKey(clientDomain);
      if (!clientSigningKey) return err(c, 400, `could not read SIGNING_KEY from https://${clientDomain}/.well-known/stellar.toml`);
    }
    const transaction = WebAuth.buildChallengeTx(
      server, account, homeDomain, CHALLENGE_TIMEOUT_SECONDS, cfg.networkPassphrase, homeDomain, memo, clientDomain, clientSigningKey,
    );
    return c.json({ transaction, network_passphrase: cfg.networkPassphrase });
  });

  app.post('/auth', async (c) => {
    let transaction = '';
    const ct = c.req.header('content-type') ?? '';
    try {
      if (ct.includes('application/json')) transaction = String(((await c.req.json()) as { transaction?: string }).transaction ?? '');
      else transaction = String((await c.req.parseBody())['transaction'] ?? '');
    } catch {
      return err(c, 400, "request body must contain 'transaction'");
    }
    if (!transaction) return err(c, 400, "request body must contain 'transaction'");

    let read: ReturnType<typeof WebAuth.readChallengeTx>;
    try {
      read = WebAuth.readChallengeTx(transaction, server.publicKey(), cfg.networkPassphrase, homeDomain, homeDomain);
    } catch (e) {
      return err(c, 400, `invalid challenge transaction: ${(e as Error).message}`);
    }
    const clientAccount = read.clientAccountID;
    const baseAccount = StrKey.isValidMed25519PublicKey(clientAccount) ? Keypair.fromPublicKey(clientAccount).publicKey() : clientAccount;

    // Optional client_domain operation (wallet attribution). It adds a second signature from the
    // wallet's domain key. verifyChallengeTx* below auto-detects that op and already requires its
    // signature, so no separate verification is needed. We only read the domain for the JWT claim.
    const clientDomainOp = read.tx.operations.find((op) => op.type === 'manageData' && op.name === 'client_domain') as
      | { source?: string; value?: Buffer | null }
      | undefined;
    const clientDomain = clientDomainOp?.value ? Buffer.from(clientDomainOp.value).toString('utf8') : undefined;

    try {
      const acct = await stellar.accountSigners(baseAccount);
      if (acct) {
        const threshold = acct.thresholds.med_threshold;
        const summary = acct.signers.map((s) => ({ key: s.key, weight: s.weight, type: s.type })) as never;
        WebAuth.verifyChallengeTxThreshold(transaction, server.publicKey(), cfg.networkPassphrase, threshold, summary, homeDomain, homeDomain);
      } else {
        // Unfunded account: the master key must have signed (plus the client_domain key if present,
        // which verifyChallengeTxSigners auto-detects and requires).
        WebAuth.verifyChallengeTxSigners(transaction, server.publicKey(), cfg.networkPassphrase, [baseAccount], homeDomain, homeDomain);
      }
    } catch (e) {
      return err(c, 400, `challenge verification failed: ${(e as Error).message}`);
    }

    const now = Math.floor(Date.now() / 1000);
    const sub = StrKey.isValidMed25519PublicKey(clientAccount) ? clientAccount : read.memo ? `${clientAccount}:${read.memo}` : clientAccount;
    const token = signJwt(
      {
        iss: `${cfg.publicUrl}/auth`,
        sub,
        iat: now,
        exp: now + TOKEN_TTL_SECONDS,
        jti: createHash('sha256').update(transaction).digest('hex'),
        ...(clientDomain ? { client_domain: clientDomain } : {}),
      },
      sep.jwtSecret,
    );
    return c.json({ token });
  });

  return app;
}
