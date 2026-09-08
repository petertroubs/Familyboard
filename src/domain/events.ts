import { DateTime } from 'luxon';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { config } from '../config.ts';
import { listRemindersForEvent, syncRemindersForEvent } from './reminders.ts';
import type {
  Account,
  CalendarEventPayload,
  EventRow,
  EventSource,
  Member,
  Reminder,
} from './types.ts';

export const eventInputSchema = z.object({
  title: z.string().trim().min(1, 'Le titre est obligatoire').max(300),
  description: z.string().max(5000).optional().default(''),
  location: z.string().max(300).optional().default(''),
  /** ISO local ("2026-09-10T18:00"), date seule ("2026-09-10") ou instant avec décalage. */
  startsAt: z.string().min(4),
  endsAt: z.string().min(4).optional(),
  allDay: z.boolean().optional().default(false),
  timezone: z.string().optional(),
  ownerMemberId: z.number().int().positive().nullable().optional(),
  participantIds: z.array(z.number().int().positive()).optional().default([]),
  /** Agendas liés vers lesquels pousser l'événement (ids de comptes). */
  syncAccountIds: z.array(z.number().int().positive()).optional().default([]),
});

export type EventInput = z.infer<typeof eventInputSchema>;

export interface EventDetail extends EventRow {
  participants: Member[];
  reminders: Reminder[];
  links: Array<{
    account_id: number;
    provider: string;
    kind: string;
    account_email: string;
    calendar_name: string;
    external_id: string;
    last_pushed_at: string | null;
  }>;
}

export class EventValidationError extends Error {}

/**
 * Convertit une saisie (date locale ou instant) en instant UTC.
 * Les événements « journée entière » sont ancrés à minuit dans le fuseau du foyer.
 */
function toUtcInstant(value: string, timezone: string, allDay: boolean): DateTime {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = DateTime.fromISO(dateOnly ? `${value}T00:00` : value, { zone: timezone });
  if (!parsed.isValid) throw new EventValidationError(`Date invalide : ${value}`);
  return allDay ? parsed.startOf('day') : parsed;
}

interface NormalizedEvent {
  title: string;
  description: string;
  location: string;
  starts_at: string;
  ends_at: string;
  all_day: 0 | 1;
  timezone: string;
}

export function normalizeEventInput(input: EventInput): NormalizedEvent {
  const timezone = input.timezone || config.timezone;
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new EventValidationError(`Fuseau horaire inconnu : ${timezone}`);
  }
  const allDay = Boolean(input.allDay);
  const start = toUtcInstant(input.startsAt, timezone, allDay);
  const end = input.endsAt
    ? toUtcInstant(input.endsAt, timezone, false)
    : allDay
      ? start.plus({ days: 1 })
      : start.plus({ hours: 1 });
  const normalizedEnd = allDay && end <= start ? start.plus({ days: 1 }) : end;
  if (normalizedEnd < start) {
    throw new EventValidationError('La fin de l’événement précède son début');
  }
  return {
    title: input.title.trim(),
    description: input.description ?? '',
    location: input.location ?? '',
    starts_at: start.toUTC().toISO()!,
    ends_at: normalizedEnd.toUTC().toISO()!,
    all_day: allDay ? 1 : 0,
    timezone,
  };
}

export function getEvent(db: Db, householdId: number, id: number): EventRow | undefined {
  return db
    .prepare<[number, number], EventRow>('SELECT * FROM events WHERE id = ? AND household_id = ?')
    .get(id, householdId);
}

/** Lecture sans portée, réservée aux traitements de fond (rappels, synchro). */
export function getEventUnscoped(db: Db, id: number): EventRow | undefined {
  return db.prepare<[number], EventRow>('SELECT * FROM events WHERE id = ?').get(id);
}

export function getEventDetail(db: Db, householdId: number, id: number): EventDetail | undefined {
  const event = getEvent(db, householdId, id);
  if (!event) return undefined;
  const participants = db
    .prepare<[number], Member>(
      `SELECT m.* FROM members m
       JOIN event_participants ep ON ep.member_id = m.id
       WHERE ep.event_id = ? ORDER BY m.name COLLATE NOCASE`,
    )
    .all(id);
  const links = db
    .prepare<[number], EventDetail['links'][number]>(
      `SELECT l.account_id, a.provider, a.kind, a.account_email, a.calendar_name,
              l.external_id, l.last_pushed_at
       FROM event_links l JOIN accounts a ON a.id = l.account_id
       WHERE l.event_id = ?`,
    )
    .all(id);
  return { ...event, participants, reminders: listRemindersForEvent(db, id), links };
}

export interface ListEventsFilter {
  from?: string;
  to?: string;
  memberId?: number;
}

export function listEvents(
  db: Db,
  householdId: number,
  filter: ListEventsFilter = {},
): EventDetail[] {
  const clauses: string[] = ['e.household_id = @householdId'];
  const params: Record<string, unknown> = { householdId };
  if (filter.from) {
    clauses.push('e.ends_at >= @from');
    params.from = filter.from;
  }
  if (filter.to) {
    clauses.push('e.starts_at <= @to');
    params.to = filter.to;
  }
  if (filter.memberId) {
    clauses.push(
      `(e.owner_member_id = @memberId
        OR EXISTS (SELECT 1 FROM event_participants ep
                   WHERE ep.event_id = e.id AND ep.member_id = @memberId))`,
    );
    params.memberId = filter.memberId;
  }
  const rows = db
    .prepare<Record<string, unknown>, EventRow>(
      `SELECT e.* FROM events e WHERE ${clauses.join(' AND ')} ORDER BY e.starts_at`,
    )
    .all(params);
  return rows.map((row) => getEventDetail(db, householdId, row.id)!);
}

function replaceParticipants(
  db: Db,
  householdId: number,
  eventId: number,
  memberIds: number[],
): void {
  db.prepare('DELETE FROM event_participants WHERE event_id = ?').run(eventId);
  // La sous-requête garantit qu'on ne rattache jamais un membre d'un autre foyer.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO event_participants (event_id, member_id)
     SELECT ?, id FROM members WHERE id = ? AND household_id = ?`,
  );
  for (const memberId of new Set(memberIds)) insert.run(eventId, memberId, householdId);
}

export interface CreateEventOptions {
  source?: EventSource;
  /** Permet de figer l'instant de référence (tests, rejeu de synchronisation). */
  now?: Date;
}

export function createEvent(
  db: Db,
  householdId: number,
  input: EventInput,
  options: CreateEventOptions = {},
): EventDetail {
  const normalized = normalizeEventInput(input);
  const detail = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO events (household_id, title, description, location, starts_at, ends_at,
                             all_day, timezone, owner_member_id, source)
         VALUES (@household_id, @title, @description, @location, @starts_at, @ends_at,
                 @all_day, @timezone, @owner_member_id, @source)`,
      )
      .run({
        ...normalized,
        household_id: householdId,
        owner_member_id: input.ownerMemberId ?? null,
        source: options.source ?? 'app',
      });
    const eventId = Number(info.lastInsertRowid);
    replaceParticipants(db, householdId, eventId, input.participantIds ?? []);
    syncRemindersForEvent(db, { id: eventId, ...normalized }, {
      reminderHour: config.reminderHour,
      now: options.now,
    });
    return getEventDetail(db, householdId, eventId)!;
  })();
  return detail;
}

export function updateEvent(
  db: Db,
  householdId: number,
  id: number,
  input: EventInput,
  options: CreateEventOptions = {},
): EventDetail | undefined {
  if (!getEvent(db, householdId, id)) return undefined;
  const normalized = normalizeEventInput(input);
  return db.transaction(() => {
    db.prepare(
      `UPDATE events SET title = @title, description = @description, location = @location,
              starts_at = @starts_at, ends_at = @ends_at, all_day = @all_day,
              timezone = @timezone, owner_member_id = @owner_member_id,
              updated_at = datetime('now')
       WHERE id = @id AND household_id = @household_id`,
    ).run({
      ...normalized,
      id,
      household_id: householdId,
      owner_member_id: input.ownerMemberId ?? null,
    });
    replaceParticipants(db, householdId, id, input.participantIds ?? []);
    syncRemindersForEvent(db, { id, ...normalized }, {
      reminderHour: config.reminderHour,
      now: options.now,
    });
    return getEventDetail(db, householdId, id)!;
  })();
}

export function deleteEvent(db: Db, householdId: number, id: number): boolean {
  return (
    db.prepare('DELETE FROM events WHERE id = ? AND household_id = ?').run(id, householdId)
      .changes > 0
  );
}

/** Charge la représentation neutre d'un événement, prête à être poussée chez un provider. */
export function toCalendarPayload(event: EventRow): CalendarEventPayload {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    allDay: event.all_day === 1,
    timezone: event.timezone,
  };
}

/** Comptes vers lesquels l'événement doit être poussé (sélection explicite ou comptes actifs). */
export function resolvePushTargets(
  db: Db,
  householdId: number,
  accountIds?: number[],
): Account[] {
  if (accountIds && accountIds.length > 0) {
    const placeholders = accountIds.map(() => '?').join(', ');
    return db
      .prepare<number[], Account>(
        `SELECT * FROM accounts WHERE id IN (${placeholders}) AND household_id = ?
           AND sync_enabled = 1 AND sync_direction IN ('push', 'both')`,
      )
      .all(...accountIds, householdId);
  }
  return db
    .prepare<[number], Account>(
      `SELECT * FROM accounts WHERE household_id = ? AND sync_enabled = 1
         AND sync_direction IN ('push', 'both')`,
    )
    .all(householdId);
}
