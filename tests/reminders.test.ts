import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime } from 'luxon';
import { openDatabase } from '../src/db/index.ts';
import {
  computeReminderSchedule,
  listDueReminders,
  markReminderFailed,
  syncRemindersForEvent,
} from '../src/domain/reminders.ts';

const PARIS = 'Europe/Paris';

function parisEvent(localStart: string, allDay = false) {
  return {
    starts_at: DateTime.fromISO(localStart, { zone: PARIS }).toUTC().toISO()!,
    all_day: (allDay ? 1 : 0) as 0 | 1,
    timezone: PARIS,
  };
}

test('planifie J-7, J-1 et le jour J à l’heure de rappel locale', () => {
  const event = parisEvent('2026-10-15T18:30');
  const { planned } = computeReminderSchedule(event, {
    reminderHour: 8,
    now: new Date('2026-09-01T10:00:00Z'),
  });

  assert.equal(planned.length, 3);
  const byKey = Object.fromEntries(planned.map((item) => [item.offsetKey, item.scheduledAt]));
  const local = (iso: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(PARIS).toISO();

  assert.equal(local(byKey.week_before!), '2026-10-08T08:00:00.000+02:00');
  assert.equal(local(byKey.day_before!), '2026-10-14T08:00:00.000+02:00');
  assert.equal(local(byKey.same_day!), '2026-10-15T08:00:00.000+02:00');
});

test('garde 8h locales de part et d’autre du changement d’heure', () => {
  // L'heure d'hiver arrive le 25 octobre 2026 : J-7 est en CEST, le jour J en CET.
  const event = parisEvent('2026-10-30T09:00');
  const { planned } = computeReminderSchedule(event, {
    reminderHour: 8,
    now: new Date('2026-10-01T00:00:00Z'),
  });
  const byKey = Object.fromEntries(planned.map((item) => [item.offsetKey, item.scheduledAt]));

  // 8h locales = 06:00 UTC en été, 07:00 UTC en hiver.
  assert.equal(byKey.week_before, '2026-10-23T06:00:00.000Z');
  assert.equal(byKey.same_day, '2026-10-30T07:00:00.000Z');
});

test('le rappel du jour J précède un événement matinal', () => {
  const event = parisEvent('2026-10-15T07:00');
  const { planned } = computeReminderSchedule(event, {
    reminderHour: 8,
    now: new Date('2026-09-01T10:00:00Z'),
  });
  const sameDay = planned.find((item) => item.offsetKey === 'same_day')!;
  const local = DateTime.fromISO(sameDay.scheduledAt, { zone: 'utc' }).setZone(PARIS);

  assert.equal(local.toISO(), '2026-10-15T06:00:00.000+02:00');
  assert.ok(local < DateTime.fromISO(event.starts_at, { zone: 'utc' }).setZone(PARIS));
});

test('un événement créé la veille déclenche un rappel de rattrapage immédiat', () => {
  const now = new Date('2026-10-14T15:00:00Z');
  const event = parisEvent('2026-10-15T18:30');
  const { planned, skipped } = computeReminderSchedule(event, { reminderHour: 8, now });

  // « Demain » (8h ce matin) est passé : il part tout de suite ; « une semaine avant » est ignoré.
  assert.deepEqual(
    planned.map((item) => item.offsetKey),
    ['day_before', 'same_day'],
  );
  assert.equal(planned[0]!.scheduledAt, now.toISOString());
  assert.deepEqual(skipped.map((item) => item.offsetKey), ['week_before']);
});

test('aucun rattrapage pour un événement déjà passé', () => {
  const event = parisEvent('2026-10-01T10:00');
  const { planned, skipped } = computeReminderSchedule(event, {
    reminderHour: 8,
    now: new Date('2026-10-05T09:00:00Z'),
  });

  assert.equal(planned.length, 0);
  assert.equal(skipped.length, 3);
});

test('les événements « journée entière » sont rappelés à l’heure configurée', () => {
  const event = parisEvent('2026-12-25T00:00', true);
  const { planned } = computeReminderSchedule(event, {
    reminderHour: 9,
    now: new Date('2026-12-01T00:00:00Z'),
  });
  const sameDay = planned.find((item) => item.offsetKey === 'same_day')!;

  assert.equal(
    DateTime.fromISO(sameDay.scheduledAt, { zone: 'utc' }).setZone(PARIS).toISO(),
    '2026-12-25T09:00:00.000+01:00',
  );
});

test('replanifier un événement déplace les rappels en attente sans toucher aux envoyés', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO events (id, title, starts_at, ends_at, timezone) VALUES (1, 'Test', ?, ?, ?)`,
  ).run(parisEvent('2026-10-15T18:30').starts_at, parisEvent('2026-10-15T19:30').starts_at, PARIS);

  const now = new Date('2026-09-01T10:00:00Z');
  syncRemindersForEvent(db, { id: 1, ...parisEvent('2026-10-15T18:30') }, { reminderHour: 8, now });
  db.prepare(`UPDATE reminders SET status = 'sent' WHERE offset_key = 'week_before'`).run();

  const after = syncRemindersForEvent(
    db,
    { id: 1, ...parisEvent('2026-11-20T18:30') },
    { reminderHour: 8, now },
  );

  const weekBefore = after.find((item) => item.offset_key === 'week_before')!;
  const dayBefore = after.find((item) => item.offset_key === 'day_before')!;
  assert.equal(weekBefore.status, 'sent', 'un rappel déjà envoyé n’est pas rejoué');
  assert.equal(weekBefore.scheduled_at, '2026-10-08T06:00:00.000Z');
  assert.equal(dayBefore.status, 'pending');
  assert.equal(dayBefore.scheduled_at, '2026-11-19T07:00:00.000Z');
  db.close();
});

test('listDueReminders ne renvoie que les échéances atteintes', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO events (id, title, starts_at, ends_at, timezone) VALUES (1, 'Test', ?, ?, ?)`,
  ).run('2026-10-15T16:30:00.000Z', '2026-10-15T17:30:00.000Z', PARIS);
  syncRemindersForEvent(db, { id: 1, ...parisEvent('2026-10-15T18:30') }, {
    reminderHour: 8,
    now: new Date('2026-09-01T10:00:00Z'),
  });

  assert.equal(listDueReminders(db, new Date('2026-10-08T05:59:00Z')).length, 0);
  assert.equal(listDueReminders(db, new Date('2026-10-08T06:00:00Z')).length, 1);
  assert.equal(listDueReminders(db, new Date('2026-10-15T07:00:00Z')).length, 3);
  db.close();
});

test('un rappel n’est abandonné qu’après trois tentatives', () => {
  const db = openDatabase(':memory:');
  db.prepare(
    `INSERT INTO events (id, title, starts_at, ends_at, timezone) VALUES (1, 'Test', ?, ?, ?)`,
  ).run('2026-10-15T16:30:00.000Z', '2026-10-15T17:30:00.000Z', PARIS);
  db.prepare(
    `INSERT INTO reminders (id, event_id, offset_key, scheduled_at) VALUES (1, 1, 'same_day', ?)`,
  ).run('2026-10-15T06:00:00.000Z');

  const status = () =>
    db.prepare<[], { status: string }>('SELECT status FROM reminders WHERE id = 1').get()!.status;

  markReminderFailed(db, 1, 'SMTP indisponible');
  assert.equal(status(), 'pending');
  markReminderFailed(db, 1, 'SMTP indisponible');
  assert.equal(status(), 'pending');
  markReminderFailed(db, 1, 'SMTP indisponible');
  assert.equal(status(), 'failed');
  db.close();
});
