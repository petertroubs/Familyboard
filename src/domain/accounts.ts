import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Db } from '../db/index.ts';
import { getProvider } from '../providers/index.ts';
import type { Account, AccountKind, ProviderId, SyncDirection, TokenSet } from './types.ts';

/** Marge de sécurité avant expiration : on rafraîchit un peu en avance. */
const REFRESH_MARGIN_SECONDS = 120;

export function listAccounts(db: Db, householdId: number): Account[] {
  return db
    .prepare<[number], Account>(
      'SELECT * FROM accounts WHERE household_id = ? ORDER BY provider, kind',
    )
    .all(householdId);
}

export function getAccount(db: Db, householdId: number, id: number): Account | undefined {
  return db
    .prepare<[number, number], Account>('SELECT * FROM accounts WHERE id = ? AND household_id = ?')
    .get(id, householdId);
}

/** Lecture sans portée, réservée aux traitements de fond (synchronisation périodique). */
export function getAccountUnscoped(db: Db, id: number): Account | undefined {
  return db.prepare<[number], Account>('SELECT * FROM accounts WHERE id = ?').get(id);
}

export interface UpsertAccountInput {
  householdId: number;
  userId: number | null;
  provider: ProviderId;
  kind: AccountKind;
  memberId: number | null;
  accountEmail: string;
  displayName: string;
  tokens: TokenSet;
  calendarId?: string;
  calendarName?: string;
}

/**
 * Crée ou met à jour un compte lié. Relier deux fois le même compte (même
 * provider/adresse/usage) rafraîchit les jetons sans dupliquer la ligne.
 */
export function upsertAccount(db: Db, input: UpsertAccountInput): Account {
  // Un même agenda peut être relié par deux foyers distincts : l'unicité est
  // évaluée à l'intérieur du foyer.
  const existing = db
    .prepare<[number, string, string, string], Account>(
      `SELECT * FROM accounts
       WHERE household_id = ? AND provider = ? AND account_email = ? AND kind = ?`,
    )
    .get(input.householdId, input.provider, input.accountEmail, input.kind);

  if (existing) {
    db.prepare(
      `UPDATE accounts SET member_id = @member_id, user_id = @user_id, display_name = @display_name,
              access_token = @access_token,
              refresh_token = CASE WHEN @refresh_token = '' THEN refresh_token ELSE @refresh_token END,
              expires_at = @expires_at, scope = @scope, last_sync_error = NULL
       WHERE id = @id`,
    ).run({
      id: existing.id,
      member_id: input.memberId,
      user_id: input.userId,
      display_name: input.displayName,
      access_token: input.tokens.accessToken,
      refresh_token: input.tokens.refreshToken ?? '',
      expires_at: input.tokens.expiresAt,
      scope: input.tokens.scope,
    });
    return getAccount(db, input.householdId, existing.id)!;
  }

  const info = db
    .prepare(
      `INSERT INTO accounts (household_id, user_id, member_id, provider, kind, account_email,
                             display_name, calendar_id, calendar_name, access_token,
                             refresh_token, expires_at, scope)
       VALUES (@household_id, @user_id, @member_id, @provider, @kind, @account_email,
               @display_name, @calendar_id, @calendar_name, @access_token,
               @refresh_token, @expires_at, @scope)`,
    )
    .run({
      household_id: input.householdId,
      user_id: input.userId,
      member_id: input.memberId,
      provider: input.provider,
      kind: input.kind,
      account_email: input.accountEmail,
      display_name: input.displayName,
      calendar_id: input.calendarId ?? '',
      calendar_name: input.calendarName ?? '',
      access_token: input.tokens.accessToken,
      refresh_token: input.tokens.refreshToken ?? '',
      expires_at: input.tokens.expiresAt,
      scope: input.tokens.scope,
    });
  return getAccount(db, input.householdId, Number(info.lastInsertRowid))!;
}

export interface AccountSettings {
  calendarId?: string;
  calendarName?: string;
  memberId?: number | null;
  syncEnabled?: boolean;
  syncDirection?: SyncDirection;
}

export function updateAccountSettings(
  db: Db,
  householdId: number,
  id: number,
  settings: AccountSettings,
): Account | undefined {
  const current = getAccount(db, householdId, id);
  if (!current) return undefined;
  db.prepare(
    `UPDATE accounts SET calendar_id = @calendar_id, calendar_name = @calendar_name,
            member_id = @member_id, sync_enabled = @sync_enabled, sync_direction = @sync_direction
     WHERE id = @id`,
  ).run({
    id,
    calendar_id: settings.calendarId ?? current.calendar_id,
    calendar_name: settings.calendarName ?? current.calendar_name,
    member_id: settings.memberId === undefined ? current.member_id : settings.memberId,
    sync_enabled:
      settings.syncEnabled === undefined ? current.sync_enabled : settings.syncEnabled ? 1 : 0,
    sync_direction: settings.syncDirection ?? current.sync_direction,
  });
  return getAccount(db, householdId, id);
}

export function deleteAccount(db: Db, householdId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM accounts WHERE id = ? AND household_id = ?').run(id, householdId)
      .changes > 0
  );
}

export function recordSyncResult(db: Db, id: number, error?: string): void {
  db.prepare(
    `UPDATE accounts SET last_sync_at = datetime('now'), last_sync_error = ? WHERE id = ?`,
  ).run(error ? error.slice(0, 500) : null, id);
}

function isExpired(account: Account, now: DateTime): boolean {
  if (!account.expires_at) return false;
  const expiry = DateTime.fromISO(account.expires_at, { zone: 'utc' });
  return !expiry.isValid || expiry.minus({ seconds: REFRESH_MARGIN_SECONDS }) <= now;
}

/**
 * Renvoie un jeton d'accès valide, en le rafraîchissant si nécessaire.
 * Les nouveaux jetons sont persistés immédiatement.
 */
export async function getAccessToken(
  db: Db,
  account: Account,
  now: DateTime = DateTime.utc(),
): Promise<string> {
  if (account.access_token && !isExpired(account, now)) return account.access_token;
  if (!account.refresh_token) {
    throw new Error(
      `Le compte ${account.account_email} doit être reconnecté (aucun jeton de rafraîchissement).`,
    );
  }
  const tokens = await getProvider(account.provider).refreshTokens(account.refresh_token);
  db.prepare(
    `UPDATE accounts SET access_token = @access_token,
            refresh_token = CASE WHEN @refresh_token = '' THEN refresh_token ELSE @refresh_token END,
            expires_at = @expires_at
     WHERE id = @id`,
  ).run({
    id: account.id,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken ?? '',
    expires_at: tokens.expiresAt,
  });
  return tokens.accessToken;
}

// ─── States OAuth (anti-CSRF) ────────────────────────────────────────────────

export function createOAuthState(
  db: Db,
  provider: ProviderId,
  kind: AccountKind,
  scope: { householdId: number; userId: number; memberId: number | null },
): string {
  const state = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO oauth_states (state, provider, kind, member_id, household_id, user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(state, provider, kind, scope.memberId, scope.householdId, scope.userId);
  // Purge des states abandonnés (plus de 30 minutes).
  db.prepare(`DELETE FROM oauth_states WHERE created_at < datetime('now', '-30 minutes')`).run();
  return state;
}

export interface ConsumedState {
  provider: ProviderId;
  kind: AccountKind;
  member_id: number | null;
  household_id: number | null;
  user_id: number | null;
}

/** Valide et consomme un state : un state ne peut servir qu'une fois. */
export function consumeOAuthState(db: Db, state: string): ConsumedState | undefined {
  const row = db
    .prepare<[string], ConsumedState>(
      'SELECT provider, kind, member_id, household_id, user_id FROM oauth_states WHERE state = ?',
    )
    .get(state);
  if (!row) return undefined;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(state);
  return row;
}
