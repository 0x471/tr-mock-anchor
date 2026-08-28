/** Minimal HS256 JWT (SEP-10 tokens). No external deps. */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64u = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export interface JwtClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti?: string;
  client_domain?: string;
  [k: string]: unknown;
}

export function signJwt(claims: JwtClaims, secret: string): string {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify(claims));
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp < now) return null;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    return claims;
  } catch {
    return null;
  }
}
