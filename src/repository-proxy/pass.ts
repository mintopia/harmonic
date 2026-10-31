import { createHmac, timingSafeEqual } from 'node:crypto';

export interface RepositoryPass {
  codeRepository: string;
  baseBranch: string;
  ticketBranch: string;
  expiresAt: number;
}

export type PassRejection = 'malformed' | 'bad-signature' | 'expired';

export type PassVerdict =
  | { ok: true; pass: RepositoryPass }
  | { ok: false; reason: PassRejection };

function sign(body: string, key: string): Buffer {
  return createHmac('sha256', key).update(body).digest();
}

export function signPass(pass: RepositoryPass, key: string): string {
  const body = Buffer.from(JSON.stringify(pass)).toString('base64url');
  return `${body}.${sign(body, key).toString('base64url')}`;
}

function isPass(value: unknown): value is RepositoryPass {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.codeRepository === 'string' &&
    typeof v.baseBranch === 'string' &&
    typeof v.ticketBranch === 'string' &&
    typeof v.expiresAt === 'number'
  );
}

export function verifyPass(token: string, key: string, now: number = Date.now()): PassVerdict {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts as [string, string];
  const given = Buffer.from(signature, 'base64url');
  const expected = sign(body, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad-signature' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPass(parsed)) return { ok: false, reason: 'malformed' };
  if (parsed.expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, pass: parsed };
}
