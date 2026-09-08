import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DateTime } from 'luxon';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { Household, User } from '../domain/types.ts';

export interface SessionContext {
  user: User;
  household: Household;
  sessionId: number;
}

/** Le jeton de session n'est stocké que haché : la base ne permet pas de le rejouer. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  token: string;
  maxAgeSeconds: number;
}

export function createSession(db: Db, userId: number, userAgent = ''): IssuedSession {
  const token = randomBytes(32).toString('base64url');
  const maxAgeSeconds = config.auth.sessionTtlDays * 24 * 3600;
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, datetime('now'), ?)`,
  ).run(
    hashToken(token),
    userId,
    DateTime.utc().plus({ days: config.auth.sessionTtlDays }).toISO(),
    userAgent.slice(0, 200),
  );
  purgeExpiredSessions(db);
  return { token, maxAgeSeconds };
}

interface SessionRow {
  id: number;
  user_id: number;
  expires_at: string;
}

/** Résout une session valide, ou undefined si le jeton est inconnu ou expiré. */
export function resolveSession(db: Db, token: string | undefined): SessionContext | undefined {
  if (!token) return undefined;
  const row = db
    .prepare<[string], SessionRow>('SELECT id, user_id, expires_at FROM sessions WHERE token_hash = ?')
    .get(hashToken(token));
  if (!row) return undefined;
  // Une échéance illisible est traitée comme expirée : en cas de donnée
  // corrompue, la session est refusée plutôt que rendue éternelle.
  const expiresAt = DateTime.fromISO(row.expires_at, { zone: 'utc' });
  if (!expiresAt.isValid || expiresAt <= DateTime.utc()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    return undefined;
  }

  const user = db.prepare<[number], User>('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return undefined;
  const household = db
    .prepare<[number], Household>('SELECT * FROM households WHERE id = ?')
    .get(user.household_id);
  if (!household) return undefined;

  db.prepare(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`).run(row.id);
  return { user, household, sessionId: row.id };
}

export function destroySession(db: Db, token: string | undefined): void {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Déconnecte toutes les sessions d'un compte (retrait du foyer, incident). */
export function destroyUserSessions(db: Db, userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions(db: Db): void {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
}

/** Comparaison à temps constant, pour les codes d'invitation. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
