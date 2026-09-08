import { DateTime } from 'luxon';
import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { getProvider, ProviderError, type CalendarProvider } from '../providers/index.ts';
import { getAccessToken, recordSyncResult } from './accounts.ts';
import { getEvent, resolvePushTargets, toCalendarPayload } from './events.ts';
import { syncRemindersForEvent } from './reminders.ts';
import type { Account, EventLink, EventRow, ExternalEvent, ProviderId } from './types.ts';

/** Dépendances injectables : les tests fournissent un provider et un jeton factices. */
export interface SyncDeps {
  provider?: (id: ProviderId) => CalendarProvider;
  accessToken?: (db: Db, account: Account) => Promise<string>;
  now?: () => Date;
}

function resolveDeps(deps: SyncDeps = {}) {
  return {
    provider: deps.provider ?? getProvider,
    accessToken: deps.accessToken ?? getAccessToken,
    now: deps.now ?? (() => new Date()),
  };
}

export interface SyncWindow {
  from: string;
  to: string;
}

/** Fenêtre synchronisée par défaut : une semaine en arrière, six mois en avant. */
export function defaultWindow(now: Date = new Date()): SyncWindow {
  const base = DateTime.fromJSDate(now, { zone: 'utc' });
  return { from: base.minus({ days: 7 }).toISO()!, to: base.plus({ days: 180 }).toISO()! };
}

function getLink(db: Db, eventId: number, accountId: number): EventLink | undefined {
  return db
    .prepare<[number, number], EventLink>(
      'SELECT * FROM event_links WHERE event_id = ? AND account_id = ?',
    )
    .get(eventId, accountId);
}

function requireCalendarId(account: Account): string {
  // Les deux API acceptent l'alias du calendrier par défaut.
  if (account.calendar_id) return account.calendar_id;
  return account.provider === 'google' ? 'primary' : 'calendar';
}

export type PushStatus = 'created' | 'updated' | 'unchanged' | 'error';

export interface PushOutcome {
  accountId: number;
  provider: ProviderId;
  kind: string;
  accountEmail: string;
  status: PushStatus;
  externalId?: string;
  error?: string;
}

/**
 * Pousse un événement FamilyBoard vers les agendas liés (Google perso, Outlook pro).
 * Crée la copie distante la première fois, la met à jour ensuite.
 */
export async function pushEvent(
  db: Db,
  eventId: number,
  accountIds?: number[],
  deps: SyncDeps = {},
): Promise<PushOutcome[]> {
  const { provider, accessToken, now } = resolveDeps(deps);
  const event = getEvent(db, eventId);
  if (!event) throw new Error(`Événement introuvable : ${eventId}`);

  const outcomes: PushOutcome[] = [];
  for (const account of resolvePushTargets(db, accountIds)) {
    const base = {
      accountId: account.id,
      provider: account.provider,
      kind: account.kind,
      accountEmail: account.account_email,
    };
    const link = getLink(db, eventId, account.id);
    // Un événement importé d'un agenda n'est pas renvoyé tel quel à sa source.
    if (link && event.source === account.provider && !hasLocalChangeSincePull(event, link)) {
      outcomes.push({ ...base, status: 'unchanged', externalId: link.external_id });
      continue;
    }
    try {
      const token = await accessToken(db, account);
      const api = provider(account.provider);
      const calendarId = requireCalendarId(account);
      const payload = toCalendarPayload(event);
      const remote = link
        ? await api.updateEvent(token, calendarId, link.external_id, payload)
        : await api.createEvent(token, calendarId, payload);
      saveLink(db, eventId, account.id, remote, now());
      recordSyncResult(db, account.id);
      outcomes.push({
        ...base,
        status: link ? 'updated' : 'created',
        externalId: remote.externalId,
      });
    } catch (error) {
      const message = describeError(error);
      recordSyncResult(db, account.id, message);
      outcomes.push({ ...base, status: 'error', error: message });
    }
  }
  return outcomes;
}

function hasLocalChangeSincePull(event: EventRow, link: EventLink): boolean {
  if (!link.last_pulled_at) return true;
  return new Date(`${event.updated_at.replace(' ', 'T')}Z`) > new Date(link.last_pulled_at);
}

function saveLink(
  db: Db,
  eventId: number,
  accountId: number,
  remote: ExternalEvent,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO event_links (event_id, account_id, external_id, external_updated_at, last_pushed_at)
     VALUES (@event_id, @account_id, @external_id, @external_updated_at, @last_pushed_at)
     ON CONFLICT (event_id, account_id) DO UPDATE SET
       external_id         = excluded.external_id,
       external_updated_at = excluded.external_updated_at,
       last_pushed_at      = excluded.last_pushed_at`,
  ).run({
    event_id: eventId,
    account_id: accountId,
    external_id: remote.externalId,
    external_updated_at: remote.updatedAt,
    last_pushed_at: now.toISOString(),
  });
}

/** Supprime les copies distantes d'un événement avant sa suppression locale. */
export async function deleteRemoteCopies(
  db: Db,
  eventId: number,
  deps: SyncDeps = {},
): Promise<void> {
  const { provider, accessToken } = resolveDeps(deps);
  const links = db
    .prepare<[number], EventLink & { account: string }>(
      'SELECT * FROM event_links WHERE event_id = ?',
    )
    .all(eventId);
  for (const link of links) {
    const account = db
      .prepare<[number], Account>('SELECT * FROM accounts WHERE id = ?')
      .get(link.account_id);
    if (!account || account.sync_enabled === 0) continue;
    if (!['push', 'both'].includes(account.sync_direction)) continue;
    try {
      const token = await accessToken(db, account);
      await provider(account.provider).deleteEvent(
        token,
        requireCalendarId(account),
        link.external_id,
      );
    } catch (error) {
      // Une copie distante déjà supprimée (404) ne doit pas bloquer la suppression locale.
      if (error instanceof ProviderError && error.status === 404) continue;
      recordSyncResult(db, account.id, describeError(error));
    }
  }
}

export interface PullReport {
  accountId: number;
  provider: ProviderId;
  kind: string;
  accountEmail: string;
  created: number;
  updated: number;
  deleted: number;
  error?: string;
}

/**
 * Importe les événements d'un agenda lié dans FamilyBoard.
 *
 * C'est ce chemin qui permet d'ajouter une date depuis Outlook pro : l'événement
 * créé dans Outlook apparaît dans l'agenda familial, avec ses rappels planifiés.
 */
export async function pullAccount(
  db: Db,
  accountId: number,
  deps: SyncDeps = {},
  window?: SyncWindow,
): Promise<PullReport> {
  const { provider, accessToken, now } = resolveDeps(deps);
  const account = db
    .prepare<[number], Account>('SELECT * FROM accounts WHERE id = ?')
    .get(accountId);
  if (!account) throw new Error(`Compte introuvable : ${accountId}`);

  const report: PullReport = {
    accountId: account.id,
    provider: account.provider,
    kind: account.kind,
    accountEmail: account.account_email,
    created: 0,
    updated: 0,
    deleted: 0,
  };

  const currentTime = now();
  const range = window ?? defaultWindow(currentTime);
  let remoteEvents: ExternalEvent[];
  try {
    const token = await accessToken(db, account);
    remoteEvents = await provider(account.provider).listEvents(
      token,
      requireCalendarId(account),
      range,
    );
  } catch (error) {
    report.error = describeError(error);
    recordSyncResult(db, account.id, report.error);
    return report;
  }

  const seen = new Set<string>();
  for (const remote of remoteEvents) {
    seen.add(remote.externalId);
    const link = db
      .prepare<[number, string], EventLink>(
        'SELECT * FROM event_links WHERE account_id = ? AND external_id = ?',
      )
      .get(account.id, remote.externalId);

    if (remote.cancelled) {
      if (link && deleteImportedEvent(db, link, account.provider)) report.deleted += 1;
      continue;
    }

    if (!link) {
      importEvent(db, account, remote, currentTime);
      report.created += 1;
      continue;
    }

    const event = getEvent(db, link.event_id);
    if (!event) {
      db.prepare('DELETE FROM event_links WHERE id = ?').run(link.id);
      importEvent(db, account, remote, currentTime);
      report.created += 1;
      continue;
    }

    if (shouldApplyRemoteChange(link, remote)) {
      applyExternalEvent(db, event, remote, currentTime);
      db.prepare(
        `UPDATE event_links SET external_updated_at = ?, last_pulled_at = ? WHERE id = ?`,
      ).run(remote.updatedAt, currentTime.toISOString(), link.id);
      report.updated += 1;
    } else {
      db.prepare('UPDATE event_links SET last_pulled_at = ? WHERE id = ?').run(
        currentTime.toISOString(),
        link.id,
      );
    }
  }

  report.deleted += reconcileDeletions(db, account, seen, range);
  recordSyncResult(db, account.id);
  return report;
}

/** N'applique une modification distante que si elle est réellement plus récente. */
function shouldApplyRemoteChange(link: EventLink, remote: ExternalEvent): boolean {
  if (!remote.updatedAt) return true;
  if (!link.external_updated_at) return true;
  return new Date(remote.updatedAt) > new Date(link.external_updated_at);
}

function importEvent(db: Db, account: Account, remote: ExternalEvent, now: Date): number {
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO events (title, description, location, starts_at, ends_at, all_day,
                             timezone, owner_member_id, source)
         VALUES (@title, @description, @location, @starts_at, @ends_at, @all_day,
                 @timezone, @owner_member_id, @source)`,
      )
      .run({
        title: remote.title,
        description: remote.description,
        location: remote.location,
        starts_at: remote.startsAt,
        ends_at: remote.endsAt,
        all_day: remote.allDay ? 1 : 0,
        timezone: remote.timezone || config.timezone,
        owner_member_id: account.member_id,
        source: account.provider,
      });
    const eventId = Number(info.lastInsertRowid);
    if (account.member_id) {
      db.prepare(
        'INSERT OR IGNORE INTO event_participants (event_id, member_id) VALUES (?, ?)',
      ).run(eventId, account.member_id);
    }
    db.prepare(
      `INSERT INTO event_links (event_id, account_id, external_id, external_updated_at, last_pulled_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(eventId, account.id, remote.externalId, remote.updatedAt, now.toISOString());
    syncRemindersForEvent(
      db,
      {
        id: eventId,
        starts_at: remote.startsAt,
        all_day: remote.allDay ? 1 : 0,
        timezone: remote.timezone || config.timezone,
      },
      { reminderHour: config.reminderHour, now },
    );
    return eventId;
  })();
}

function applyExternalEvent(db: Db, event: EventRow, remote: ExternalEvent, now: Date): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE events SET title = @title, description = @description, location = @location,
              starts_at = @starts_at, ends_at = @ends_at, all_day = @all_day,
              timezone = @timezone, updated_at = datetime('now')
       WHERE id = @id`,
    ).run({
      id: event.id,
      title: remote.title,
      description: remote.description,
      location: remote.location,
      starts_at: remote.startsAt,
      ends_at: remote.endsAt,
      all_day: remote.allDay ? 1 : 0,
      timezone: remote.timezone || event.timezone,
    });
    // Un déplacement de date doit replanifier les rappels non encore envoyés.
    syncRemindersForEvent(
      db,
      {
        id: event.id,
        starts_at: remote.startsAt,
        all_day: remote.allDay ? 1 : 0,
        timezone: remote.timezone || event.timezone,
      },
      { reminderHour: config.reminderHour, now },
    );
  })();
}

/** Supprime un événement importé dont la source a disparu. */
function deleteImportedEvent(db: Db, link: EventLink, provider: ProviderId): boolean {
  const event = getEvent(db, link.event_id);
  if (!event) {
    db.prepare('DELETE FROM event_links WHERE id = ?').run(link.id);
    return false;
  }
  if (event.source !== provider) {
    // Événement créé dans FamilyBoard : on ne perd pas la donnée locale,
    // seul le lien vers la copie distante disparaît.
    db.prepare('DELETE FROM event_links WHERE id = ?').run(link.id);
    return false;
  }
  db.prepare('DELETE FROM events WHERE id = ?').run(event.id);
  return true;
}

/**
 * Détecte les événements importés puis supprimés côté provider : ils sont absents
 * de la fenêtre alors que leur lien existe toujours.
 */
function reconcileDeletions(
  db: Db,
  account: Account,
  seen: Set<string>,
  range: SyncWindow,
): number {
  const links = db
    .prepare<[number, string, string], EventLink & { source: string; starts_at: string }>(
      `SELECT l.*, e.source, e.starts_at
       FROM event_links l JOIN events e ON e.id = l.event_id
       WHERE l.account_id = ? AND e.starts_at >= ? AND e.starts_at <= ?`,
    )
    .all(account.id, range.from, range.to);

  let deleted = 0;
  for (const link of links) {
    if (seen.has(link.external_id)) continue;
    // Une copie tout juste poussée peut manquer à l'appel si l'API n'est pas
    // encore cohérente : on ne supprime que les événements réellement importés.
    if (link.source !== account.provider) continue;
    if (link.last_pulled_at === null) continue;
    db.prepare('DELETE FROM events WHERE id = ?').run(link.event_id);
    deleted += 1;
  }
  return deleted;
}

/** Synchronisation périodique de tous les comptes autorisés en lecture. */
export async function pullAllAccounts(db: Db, deps: SyncDeps = {}): Promise<PullReport[]> {
  const accounts = db
    .prepare<[], Account>(
      `SELECT * FROM accounts WHERE sync_enabled = 1 AND sync_direction IN ('pull', 'both')`,
    )
    .all();
  const reports: PullReport[] = [];
  for (const account of accounts) {
    reports.push(await pullAccount(db, account.id, deps));
  }
  return reports;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
