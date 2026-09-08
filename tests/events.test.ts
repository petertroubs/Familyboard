import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/db/index.ts';
import {
  createEvent,
  eventInputSchema,
  EventValidationError,
  listEvents,
  normalizeEventInput,
  updateEvent,
} from '../src/domain/events.ts';

function parse(input: Record<string, unknown>) {
  return eventInputSchema.parse(input);
}

test('une heure locale est convertie en instant UTC', () => {
  const normalized = normalizeEventInput(
    parse({ title: 'Réunion', startsAt: '2026-10-15T18:30', timezone: 'Europe/Paris' }),
  );
  assert.equal(normalized.starts_at, '2026-10-15T16:30:00.000Z');
  assert.equal(normalized.ends_at, '2026-10-15T17:30:00.000Z', 'une heure par défaut');
});

test('une date seule crée une journée entière de minuit à minuit', () => {
  const normalized = normalizeEventInput(
    parse({ title: 'Vacances', startsAt: '2026-12-20', allDay: true, timezone: 'Europe/Paris' }),
  );
  assert.equal(normalized.all_day, 1);
  assert.equal(normalized.starts_at, '2026-12-19T23:00:00.000Z');
  assert.equal(normalized.ends_at, '2026-12-20T23:00:00.000Z');
});

test('un instant avec décalage explicite est accepté tel quel', () => {
  const normalized = normalizeEventInput(
    parse({ title: 'Visio', startsAt: '2026-10-15T16:30:00Z', timezone: 'Europe/Paris' }),
  );
  assert.equal(normalized.starts_at, '2026-10-15T16:30:00.000Z');
});

test('une fin antérieure au début est refusée', () => {
  assert.throws(
    () =>
      normalizeEventInput(
        parse({ title: 'Erreur', startsAt: '2026-10-15T18:30', endsAt: '2026-10-15T17:00' }),
      ),
    EventValidationError,
  );
});

test('un fuseau inconnu est refusé', () => {
  assert.throws(
    () => normalizeEventInput(parse({ title: 'x', startsAt: '2026-10-15T18:30', timezone: 'Mars/Olympus' })),
    EventValidationError,
  );
});

test('un titre vide est rejeté par la validation', () => {
  const result = eventInputSchema.safeParse({ title: '   ', startsAt: '2026-10-15T18:30' });
  assert.equal(result.success, false);
});

test('la liste filtre sur la fenêtre demandée et sur le membre', () => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO members (id, name) VALUES (1, 'Camille'), (2, 'Alex')`).run();
  const now = new Date('2026-09-01T10:00:00Z');

  createEvent(db, parse({ title: 'Octobre', startsAt: '2026-10-15T18:30', participantIds: [1] }), { now });
  createEvent(db, parse({ title: 'Novembre', startsAt: '2026-11-15T18:30', ownerMemberId: 2 }), { now });

  assert.deepEqual(
    listEvents(db, { from: '2026-10-01T00:00:00Z', to: '2026-10-31T00:00:00Z' }).map((e) => e.title),
    ['Octobre'],
  );
  assert.deepEqual(listEvents(db, { memberId: 1 }).map((e) => e.title), ['Octobre']);
  assert.deepEqual(listEvents(db, { memberId: 2 }).map((e) => e.title), ['Novembre']);
  db.close();
});

test('modifier un événement remplace ses participants', () => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO members (id, name) VALUES (1, 'Camille'), (2, 'Alex')`).run();
  const now = new Date('2026-09-01T10:00:00Z');
  const event = createEvent(db, parse({ title: 'Sortie', startsAt: '2026-10-15T18:30', participantIds: [1] }), { now });

  const updated = updateEvent(
    db,
    event.id,
    parse({ title: 'Sortie vélo', startsAt: '2026-10-16T14:00', participantIds: [2] }),
    { now },
  )!;

  assert.equal(updated.title, 'Sortie vélo');
  assert.deepEqual(updated.participants.map((member) => member.name), ['Alex']);
  assert.equal(updated.starts_at, '2026-10-16T12:00:00.000Z');
  db.close();
});

test('supprimer un événement emporte ses rappels et notifications', () => {
  const db = openDatabase(':memory:');
  db.prepare(`INSERT INTO members (id, name) VALUES (1, 'Camille')`).run();
  const event = createEvent(db, parse({ title: 'Dentiste', startsAt: '2026-10-15T18:30' }), {
    now: new Date('2026-09-01T10:00:00Z'),
  });
  db.prepare(
    `INSERT INTO notifications (member_id, event_id, title) VALUES (1, ?, 'rappel')`,
  ).run(event.id);

  db.prepare('DELETE FROM events WHERE id = ?').run(event.id);

  const count = (table: string) =>
    db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
  assert.equal(count('reminders'), 0);
  assert.equal(count('notifications'), 0);
  db.close();
});
