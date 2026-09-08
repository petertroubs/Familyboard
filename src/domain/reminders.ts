import { DateTime } from 'luxon';
import type { Db } from '../db/index.ts';
import type { EventRow, Reminder, ReminderOffset } from './types.ts';

/** Décalages proposés par le module de notification, du plus lointain au plus proche. */
export const REMINDER_OFFSETS: ReminderOffset[] = ['week_before', 'day_before', 'same_day'];

export const REMINDER_LABELS: Record<ReminderOffset, string> = {
  week_before: 'Dans une semaine',
  day_before: 'Demain',
  same_day: "Aujourd'hui",
};

const DAYS_BEFORE: Record<ReminderOffset, number> = {
  week_before: 7,
  day_before: 1,
  same_day: 0,
};

export interface PlannedReminder {
  offsetKey: ReminderOffset;
  /** Instant d'envoi, UTC ISO-8601. */
  scheduledAt: string;
}

export interface ScheduleOptions {
  /** Heure locale d'envoi des rappels (0-23). */
  reminderHour: number;
  /**
   * Rattrape le rappel manqué le plus proche quand l'événement est créé tardivement
   * (ex. un événement pour demain doit tout de même déclencher un « Demain »).
   */
  catchUp?: boolean;
  now?: Date;
}

export interface ScheduleResult {
  planned: PlannedReminder[];
  /** Échéances déjà passées : conservées en base au statut 'skipped' pour l'historique. */
  skipped: PlannedReminder[];
}

/**
 * Calcule les trois échéances de rappel d'un événement (J-7, J-1, jour J).
 *
 * Le calcul se fait dans le fuseau de l'événement : un rappel « la veille à 8h »
 * reste à 8h locales même si l'écart UTC change (heure d'été).
 */
export function computeReminderSchedule(
  event: Pick<EventRow, 'starts_at' | 'all_day' | 'timezone'>,
  options: ScheduleOptions,
): ScheduleResult {
  const now = DateTime.fromJSDate(options.now ?? new Date(), { zone: 'utc' });
  const start = DateTime.fromISO(event.starts_at, { zone: 'utc' }).setZone(event.timezone);
  if (!start.isValid) {
    throw new Error(`Date de début invalide : ${event.starts_at} (${event.timezone})`);
  }
  const hour = Math.min(23, Math.max(0, Math.trunc(options.reminderHour)));

  const candidates: PlannedReminder[] = REMINDER_OFFSETS.map((offsetKey) => {
    let at = start
      .startOf('day')
      .minus({ days: DAYS_BEFORE[offsetKey] })
      .set({ hour, minute: 0, second: 0, millisecond: 0 });
    // Un rappel ne doit jamais tomber après le début de l'événement : pour un
    // événement matinal, le rappel du jour J part une heure avant.
    if (!event.all_day && at > start) {
      at = start.minus({ hours: 1 });
    }
    return { offsetKey, scheduledAt: at.toUTC().toISO()! };
  });

  const planned: PlannedReminder[] = [];
  const missed: PlannedReminder[] = [];
  for (const candidate of candidates) {
    if (DateTime.fromISO(candidate.scheduledAt, { zone: 'utc' }) >= now) planned.push(candidate);
    else missed.push(candidate);
  }

  const skipped: PlannedReminder[] = [];
  const eventStillAhead = start.toUTC() > now;
  const lastMissed = missed[missed.length - 1];
  if ((options.catchUp ?? true) && eventStillAhead && lastMissed) {
    // Rattrapage immédiat du rappel manqué le plus proche de l'événement.
    planned.unshift({ offsetKey: lastMissed.offsetKey, scheduledAt: now.toISO()! });
    skipped.push(...missed.slice(0, -1));
  } else {
    skipped.push(...missed);
  }

  return { planned, skipped };
}

/**
 * (Re)planifie les rappels d'un événement. Les rappels déjà envoyés sont
 * conservés ; seules les échéances encore en attente sont recalculées.
 */
export function syncRemindersForEvent(
  db: Db,
  event: Pick<EventRow, 'id' | 'starts_at' | 'all_day' | 'timezone'>,
  options: ScheduleOptions,
): Reminder[] {
  const { planned, skipped } = computeReminderSchedule(event, options);
  const sentKeys = new Set(
    db
      .prepare<[number], { offset_key: ReminderOffset }>(
        `SELECT offset_key FROM reminders WHERE event_id = ? AND status IN ('sent', 'failed')`,
      )
      .all(event.id)
      .map((row) => row.offset_key),
  );

  const upsert = db.prepare(
    `INSERT INTO reminders (event_id, offset_key, scheduled_at, status)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (event_id, offset_key) DO UPDATE SET
       scheduled_at = excluded.scheduled_at,
       status       = excluded.status,
       last_error   = NULL`,
  );

  db.transaction(() => {
    for (const item of planned) {
      if (sentKeys.has(item.offsetKey)) continue;
      upsert.run(event.id, item.offsetKey, item.scheduledAt, 'pending');
    }
    for (const item of skipped) {
      if (sentKeys.has(item.offsetKey)) continue;
      upsert.run(event.id, item.offsetKey, item.scheduledAt, 'skipped');
    }
  })();

  return listRemindersForEvent(db, event.id);
}

export function listRemindersForEvent(db: Db, eventId: number): Reminder[] {
  return db
    .prepare<[number], Reminder>(
      'SELECT * FROM reminders WHERE event_id = ? ORDER BY scheduled_at',
    )
    .all(eventId);
}

/** Rappels dont l'échéance est atteinte et qui restent à envoyer. */
export function listDueReminders(db: Db, now: Date = new Date(), limit = 100): Reminder[] {
  return db
    .prepare<[string, number], Reminder>(
      `SELECT * FROM reminders
       WHERE status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at
       LIMIT ?`,
    )
    .all(now.toISOString(), limit);
}

export function markReminderSent(db: Db, reminderId: number): void {
  db.prepare(
    `UPDATE reminders
     SET status = 'sent', sent_at = datetime('now'), attempts = attempts + 1, last_error = NULL
     WHERE id = ?`,
  ).run(reminderId);
}

const MAX_ATTEMPTS = 3;

/** Enregistre un échec : on retente jusqu'à MAX_ATTEMPTS avant d'abandonner. */
export function markReminderFailed(db: Db, reminderId: number, error: string): void {
  db.prepare(
    `UPDATE reminders
     SET attempts    = attempts + 1,
         last_error  = ?,
         status      = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
     WHERE id = ?`,
  ).run(error.slice(0, 500), MAX_ATTEMPTS, reminderId);
}
