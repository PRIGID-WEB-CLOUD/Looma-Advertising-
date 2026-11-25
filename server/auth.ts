import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';

const RUNTIME_SECRET = process.env.LOOMA_SESSION_SECRET || crypto.randomBytes(32).toString('hex');
export const TRACKING_SECRET = process.env.LOOMA_TRACKING_SECRET || crypto.randomBytes(32).toString('hex');

export interface SessionPayload {
  userId: string;
  email: string;
  role: 'advertiser' | 'publisher' | 'admin';
  jti?: string;
  iat?: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  auth?: SessionPayload;
  rawToken?: string;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(password, salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

export function timingSafeSecretMatch(input: string, secret: string): boolean {
  if (!input || !secret) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

export function signSessionToken(
  payload: Omit<SessionPayload, 'exp' | 'iat' | 'jti'>,
  minIat?: number
): string {
  const now = Math.max(Date.now(), minIat ?? 0);
  const fullPayload: SessionPayload = {
    ...payload,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 1000 * 60 * 60 * 24, // 24 hours
  };
  const encoded = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');
  const sig = crypto.createHmac('sha256', RUNTIME_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', RUNTIME_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.exp || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function revokeSessionToken(db: DatabaseSync, token: string, expMs: number): void {
  const tokenHash = hashToken(token);
  const expSec = Math.floor(Math.max(Date.now(), expMs) / 1000);
  db.prepare(
    `INSERT OR REPLACE INTO revoked_tokens (token_hash, expires_at)
     VALUES (?, datetime(?, 'unixepoch'))`
  ).run(tokenHash, expSec);
}

export function authenticateBearerToken(db: DatabaseSync, authorizationHeader: string | undefined): {
  ok: true;
  session: SessionPayload;
  rawToken: string;
} | {
  ok: false;
  status: number;
  error: string;
} {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  const token = authorizationHeader.slice('Bearer '.length).trim();
  const session = verifySessionToken(token);
  if (!session) {
    return { ok: false, status: 401, error: 'Invalid or expired session token' };
  }

  const revoked = db.prepare('SELECT token_hash FROM revoked_tokens WHERE token_hash = ?').get(hashToken(token));
  if (revoked) {
    return { ok: false, status: 401, error: 'Session has been revoked. Please sign in again.' };
  }

  const userRow = db
    .prepare(
      `SELECT u.id, u.status, u.token_valid_after, r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = ?`
    )
    .get(session.userId) as
    | { id: string; status: string; token_valid_after: number; role: 'advertiser' | 'publisher' | 'admin' }
    | undefined;

  if (!userRow || userRow.status !== 'active') {
    return { ok: false, status: 403, error: 'Account is suspended or unavailable' };
  }

  if (userRow.role !== session.role) {
    return { ok: false, status: 401, error: 'Account permissions changed. Please sign in again.' };
  }

  const issuedAt = typeof session.iat === 'number' ? session.iat : 0;
  if (userRow.token_valid_after > 0 && issuedAt < userRow.token_valid_after) {
    return { ok: false, status: 401, error: 'Session invalidated after security update. Please sign in again.' };
  }

  return { ok: true, session, rawToken: token };
}

export function createAuthMiddleware(db: DatabaseSync) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const result = authenticateBearerToken(db, req.headers.authorization);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    req.auth = result.session;
    req.rawToken = result.rawToken;
    next();
  };
}

export function requireRole(...allowedRoles: Array<'advertiser' | 'publisher' | 'admin'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Insufficient permissions for this workspace' });
      return;
    }
    next();
  };
}

export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(`looma-ip:${ip}`).digest('hex').slice(0, 24);
}
