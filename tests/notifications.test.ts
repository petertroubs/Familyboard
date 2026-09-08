import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, type Db } from '../src/db/index.ts';
import { createEvent } from '../src/domain/events.ts';
import { buildReminderMessage } from '../src/notifications/messages.ts';
import type { NotificationChannel } from '../src/notifications/channels.ts';
import { dispatchDueReminders, listNotifications } from '../src/notifications/scheduler.ts';
import type { Member } from '../src/domain/types.ts';

/** Canal factice : mémorise les envois au lieu de contacter un serveur SMTP. */
function fakeChannel(options: { failing?: boolean } = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const channel: NotificationChannel = {
    name: 'fake',
    isAvailable: (recipient) => Boolean(recipient.email),
    async send(recipient, message) {
      if (options.failing) throw new Error('serveur SMTP injoignable');
      sent.push({ to: recipient.email!, subject: message.subject, text: message.text });
    },
  };
  return { channel, sent };
}

function setup(): Db {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO members (id, name, email) VALUES (1, 'Camille', 'camille@exemple.fr')`).run();
  db.prepare(`INSERT INTO members (id, name, email) VALUES (2, 'Alex', 'alex@exemple.fr')`).run();
  db.prepare(`INSERT INTO members (id, name, email) VALUES (3, 'Jo', NULL)`).run();
  return db;
}

function seedEvent(db: Db, participantIds: number[]) {
  return createEvent(
    db,
    {
      title: 'Réunion parents-profs',
      description: 'Salle B12',
      location: 'École Jean Jaurès',
      startsAt: '2026-10-15T18:30',
      allDay: false,
      participantIds,
      syncAccountIds: [],
    } as never,
    { now: new Date('2026-09-01T10:00:00Z') },
  );
}

test('le rappel J-7 part à l’échéance, une fois seulement', async () => {
  const db = setup();
  seedEvent(db, [1]);
  const { channel, sent } = fakeChannel();

  const early = await dispatchDueReminders(db, {
    channels: [channel],
    now: new Date('2026-10-08T05:00:00Z'),
  });
  assert.equal(early.processed, 0, 'rien avant 8h locales');

  const due = await dispatchDueReminders(db, {
    channels: [channel],
    now: new Date('2026-10-08T06:00:00Z'),
  });
  assert.equal(due.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.to, 'camille@exemple.fr');
  assert.match(sent[0]!.subject, /^Dans une semaine : Réunion parents-profs$/);

  const replay = await dispatchDueReminders(db, {
    channels: [channel],
    now: new Date('2026-10-08T07:00:00Z'),
  });
  assert.equal(replay.processed, 0, 'un rappel envoyé n’est jamais rejoué');
  db.close();
});

test('sans participant désigné, tout le foyer est prévenu', async () => {
  const db = setup();
  seedEvent(db, []);
  const { channel, sent } = fakeChannel();

  await dispatchDueReminders(db, { channels: [channel], now: new Date('2026-10-08T06:00:00Z') });

  // Trois membres notifiés dans le fil, deux joignables par e-mail.
  assert.equal(listNotifications(db).length, 3);
  assert.deepEqual(sent.map((item) => item.to).sort(), ['alex@exemple.fr', 'camille@exemple.fr']);
  db.close();
});

test('les trois échéances se déclenchent l’une après l’autre', async () => {
  const db = setup();
  seedEvent(db, [1]);
  const { channel, sent } = fakeChannel();

  await dispatchDueReminders(db, { channels: [channel], now: new Date('2026-10-08T06:00:00Z') });
  await dispatchDueReminders(db, { channels: [channel], now: new Date('2026-10-14T06:00:00Z') });
  await dispatchDueReminders(db, { channels: [channel], now: new Date('2026-10-15T06:00:00Z') });

  assert.deepEqual(sent.map((item) => item.subject.split(' : ')[0]), [
    'Dans une semaine',
    'Demain',
    "Aujourd'hui",
  ]);
  db.close();
});

test('le fil in-app est alimenté même quand l’e-mail échoue', async () => {
  const db = setup();
  seedEvent(db, [1]);
  const { channel } = fakeChannel({ failing: true });

  const report = await dispatchDueReminders(db, {
    channels: [channel],
    now: new Date('2026-10-08T06:00:00Z'),
  });

  assert.equal(report.failed, 1);
  const feed = listNotifications(db, 1);
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.offset_label, 'Dans une semaine');
  const reminder = db
    .prepare<[], { status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM reminders WHERE offset_key = 'week_before'`,
    )
    .get()!;
  assert.equal(reminder.status, 'pending', 'un échec est retenté au tick suivant');
  assert.equal(reminder.attempts, 1);
  assert.match(reminder.last_error, /SMTP injoignable/);
  db.close();
});

test('le message rappelle la date, l’heure et le lieu en français', () => {
  const db = setup();
  const event = seedEvent(db, [1]);
  const member: Member = {
    id: 1,
    name: 'Camille',
    email: 'camille@exemple.fr',
    color: '#000',
    timezone: null,
    created_at: '',
  };

  const message = buildReminderMessage(event, 'day_before', member, 'http://localhost:3000');

  assert.equal(message.subject, 'Demain : Réunion parents-profs');
  assert.match(message.text, /jeudi 15 octobre 2026 de 18h30 à 19h30/);
  assert.match(message.text, /École Jean Jaurès/);
  assert.match(message.text, /Salle B12/);
  assert.match(message.html, /<a href="http:\/\/localhost:3000">/);
  db.close();
});

test('un rappel de journée entière ne mentionne pas d’horaire', () => {
  const db = setup();
  const event = createEvent(
    db,
    {
      title: 'Vacances scolaires',
      startsAt: '2026-12-20',
      allDay: true,
      participantIds: [1],
      syncAccountIds: [],
    } as never,
    { now: new Date('2026-09-01T10:00:00Z') },
  );
  const member: Member = {
    id: 1,
    name: 'Camille',
    email: null,
    color: '#000',
    timezone: null,
    created_at: '',
  };

  const message = buildReminderMessage(event, 'week_before', member, 'http://localhost:3000');
  assert.match(message.text, /dimanche 20 décembre 2026 \(toute la journée\)/);
  db.close();
});
