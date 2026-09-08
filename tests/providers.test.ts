import assert from 'node:assert/strict';
import test from 'node:test';
import { fromGoogleEvent, toGoogleEvent } from '../src/providers/google.ts';
import { fromGraphEvent, toGraphEvent } from '../src/providers/outlook.ts';
import type { CalendarEventPayload } from '../src/domain/types.ts';

const timed: CalendarEventPayload = {
  title: 'Réunion parents-profs',
  description: 'Salle B12',
  location: 'École Jean Jaurès',
  startsAt: '2026-10-15T16:30:00.000Z',
  endsAt: '2026-10-15T17:30:00.000Z',
  allDay: false,
  timezone: 'Europe/Paris',
};

const allDay: CalendarEventPayload = {
  ...timed,
  title: 'Vacances',
  startsAt: '2026-12-19T23:00:00.000Z', // 20 décembre, minuit à Paris
  endsAt: '2026-12-26T23:00:00.000Z', // fin exclusive : dernier jour inclus = 26
  allDay: true,
};

test('Google : un événement horaire conserve son fuseau de saisie', () => {
  const body = toGoogleEvent(timed) as { start: { dateTime: string; timeZone: string } };
  assert.equal(body.start.dateTime, '2026-10-15T18:30:00+02:00');
  assert.equal(body.start.timeZone, 'Europe/Paris');
});

test('Google : une journée entière utilise des dates, avec fin exclusive', () => {
  const body = toGoogleEvent(allDay) as { start: { date: string }; end: { date: string } };
  assert.equal(body.start.date, '2026-12-20');
  assert.equal(body.end.date, '2026-12-27');
});

test('Google : aller-retour d’un événement horaire', () => {
  const parsed = fromGoogleEvent(
    {
      id: 'evt-1',
      summary: timed.title,
      description: timed.description,
      location: timed.location,
      start: { dateTime: '2026-10-15T18:30:00+02:00', timeZone: 'Europe/Paris' },
      end: { dateTime: '2026-10-15T19:30:00+02:00', timeZone: 'Europe/Paris' },
      updated: '2026-09-01T09:00:00.000Z',
    },
    'Europe/Paris',
  );

  assert.equal(parsed.startsAt, timed.startsAt);
  assert.equal(parsed.endsAt, timed.endsAt);
  assert.equal(parsed.allDay, false);
  assert.equal(parsed.externalId, 'evt-1');
  assert.equal(parsed.updatedAt, '2026-09-01T09:00:00.000Z');
});

test('Google : un événement annulé est signalé', () => {
  const parsed = fromGoogleEvent(
    { id: 'evt-2', start: { date: '2026-12-20' }, end: { date: '2026-12-21' }, status: 'cancelled' },
    'Europe/Paris',
  );
  assert.equal(parsed.cancelled, true);
  assert.equal(parsed.allDay, true);
  assert.equal(parsed.startsAt, '2026-12-19T23:00:00.000Z');
});

test('Outlook : Graph reçoit une date locale nue et son fuseau', () => {
  const body = toGraphEvent(timed) as {
    start: { dateTime: string; timeZone: string };
    isAllDay: boolean;
  };
  assert.equal(body.start.dateTime, '2026-10-15T18:30:00');
  assert.equal(body.start.timeZone, 'Europe/Paris');
  assert.equal(body.isAllDay, false);
});

test('Outlook : une journée entière est bornée à minuit, fin exclusive', () => {
  const body = toGraphEvent(allDay) as {
    start: { dateTime: string };
    end: { dateTime: string };
    isAllDay: boolean;
  };
  assert.equal(body.isAllDay, true);
  assert.equal(body.start.dateTime, '2026-12-20T00:00:00');
  assert.equal(body.end.dateTime, '2026-12-27T00:00:00');
});

test('Outlook : les dates renvoyées en UTC sont réinterprétées correctement', () => {
  // Avec l'en-tête Prefer: outlook.timezone="UTC", Graph renvoie des dates UTC nues.
  const parsed = fromGraphEvent(
    {
      id: 'AAMk-1',
      subject: 'Comité de direction',
      body: { contentType: 'text', content: 'Ordre du jour joint' },
      location: { displayName: 'Salle Rennes' },
      start: { dateTime: '2026-10-15T16:30:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-15T17:30:00.0000000', timeZone: 'UTC' },
      lastModifiedDateTime: '2026-09-02T08:00:00Z',
    },
    'Europe/Paris',
  );

  assert.equal(parsed.startsAt, '2026-10-15T16:30:00.000Z');
  assert.equal(parsed.endsAt, '2026-10-15T17:30:00.000Z');
  assert.equal(parsed.timezone, 'UTC');
  assert.equal(parsed.description, 'Ordre du jour joint');
  assert.equal(parsed.location, 'Salle Rennes');
});

test('Outlook : un fuseau Windows est traduit en identifiant IANA', () => {
  const parsed = fromGraphEvent(
    {
      id: 'AAMk-2',
      subject: 'Point équipe',
      start: { dateTime: '2026-10-15T18:30:00.0000000', timeZone: 'Romance Standard Time' },
      end: { dateTime: '2026-10-15T19:30:00.0000000', timeZone: 'Romance Standard Time' },
    },
    'Europe/Paris',
  );

  assert.equal(parsed.timezone, 'Europe/Paris');
  assert.equal(parsed.startsAt, '2026-10-15T16:30:00.000Z');
});

test('Outlook : une journée entière est ancrée dans le fuseau du foyer', () => {
  const parsed = fromGraphEvent(
    {
      id: 'AAMk-3',
      subject: 'Séminaire',
      isAllDay: true,
      start: { dateTime: '2026-12-20T00:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-12-27T00:00:00.0000000', timeZone: 'UTC' },
    },
    'Europe/Paris',
  );

  assert.equal(parsed.allDay, true);
  assert.equal(parsed.startsAt, '2026-12-19T23:00:00.000Z');
  assert.equal(parsed.endsAt, '2026-12-26T23:00:00.000Z');
});

test('un événement sans titre reste lisible', () => {
  assert.equal(
    fromGraphEvent({ id: 'x', start: { dateTime: '2026-10-15T10:00:00' } }, 'Europe/Paris').title,
    '(sans titre)',
  );
  assert.equal(
    fromGoogleEvent({ id: 'y', start: { dateTime: '2026-10-15T10:00:00Z' } }, 'UTC').title,
    '(sans titre)',
  );
});
