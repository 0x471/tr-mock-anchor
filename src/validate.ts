import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { badRequest } from './errors.js';

export async function parseBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest('invalid_json', 'Request body is not valid JSON');
    }
  }
  const res = schema.safeParse(raw);
  if (!res.success) {
    throw badRequest('validation_error', 'Invalid request body', res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return res.data;
}

export function pageParams(c: Context): { limit: number; offset: number } {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  return { limit, offset };
}
