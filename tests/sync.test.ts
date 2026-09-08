import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, type Db } from '../src/db/index.ts';
import { createEvent, getEvent, listEvents } from '../src/domain/events.ts';
import { createHousehold } from '../src/domain/households.ts';
import { deleteRemoteCopies, pullAccount, pushEvent } from '../src/domain/sync.ts';
import type {
  CalendarEventPayload,
  ExternalEvent,
  ProviderId,
} from '../src/domain/types.ts';
import type { CalendarProvider } from '../src/providers/types.ts';

/** Provider factice : conserve les événements en mémoire et compte les appels. */
function fakeProvider(id: ProviderId) {
  const store = new Map<string, ExternalEvent>();
  const calls = { create: 0, update: 0, delete: 0, list: 0 };
  let sequence = 0;

  const toExternal = (
    externalId: string,
    event: CalendarEventPayload,
    updatedAt: string,
  ): ExternalEvent => ({ ...event, externalId, updatedAt });

  const provider: CalendarProvider = {
    id,
    label: `Fake ${id}`,
    authorizationUrl: () => 'https://example.test/auth',
    exchangeCode: async () => ({ accessToken: 'a', expiresAt: null, scope: '' }),
    refreshTokens: async () => ({ accessToken: 'a', expiresAt: null, scope: '' }),
    identity: async () => ({ email: `boite@${id}.test`, displayName: 'Compte test' }),
    listCalendars: async () => [{ id: 'principal', name: 'Principal', primary: true }],
    async createEvent(_token, _calendarId, event) {
      calls.create += 1;
      sequence += 1;
      const external = toExternal(`ext-${sequence}`, event, new Date().toISOString());
      store.set(external.externalId, external);
      return external;
    },
    async updateEvent(_token, _calendarId, externalId, event) {
      calls.update += 1;
      const external = toExternal(externalId, event, new Date().toISOString());
      store.set(externalId, external);
      return external;
    },
    async deleteEvent(_token, _calendarId, externalId) {
      calls.delete += 1;
      store.delete(externalId);
    },
    async listEvents() {
      calls.list += 1;
      return [...store.values()];
    },
  };

  return { provider, store, calls };
}

const HOUSEHOLD = 1;

function setup(providerId: ProviderId = 'outlook') {
  const db = openDatabase(':memory:');
  createHousehold(db, 'Famille de test');
  db.prepare(
    `INSERT INTO members (id, household_id, name, email) VALUES (1, 1, 'Camille', 'c@exemple.fr')`,
  ).run();
  db.prepare(
    `INSERT INTO accounts (id, household_id, member_id, provider, kind, account_email, calendar_id, access_token, refresh_token, expires_at)
     VALUES (1, 1, 1, ?, 'pro', 'pro@entreprise.fr', 'principal', 'token', 'refresh', NULL)`,
  ).run(providerId);
  const fake = fakeProvider(providerId);
  const deps = {
    provider: () => fake.provider,
    accessToken: async () => 'token',
  };
  return { db, fake, deps };
}

function seedRemote(db: Db, fake: ReturnType<typeof fakeProvider>, overrides: Partial<ExternalEvent> = {}) {
  const external: ExternalEvent = {
    externalId: 'ext-outlook-1',
    title: 'Comité de direction',
    description: 'Ordre du jour joint',
    location: 'Salle Rennes',
    startsAt: '2026-10-15T16:30:00.000Z',
    endsAt: '2026-10-15T17:30:00.000Z',
    allDay: false,
    timezone: 'Europe/Paris',
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
  fake.store.set(external.externalId, external);
  return external;
}

test('une date créée dans l’app est poussée vers l’agenda lié puis mise à jour', async () => {
  const { db, fake, deps } = setup();
  const event = createEvent(db, HOUSEHOLD, {
    title: 'Réunion parents-profs',
    description: 'Salle B12',
    location: 'École',
    startsAt: '2026-10-15T18:30',
    allDay: false,
    participantIds: [1],
    syncAccountIds: [],
  } as never);

  const created = await pushEvent(db, HOUSEHOLD, event.id, [1], deps);
  assert.equal(created[0]!.status, 'created');
  assert.equal(fake.calls.create, 1);
  assert.equal(fake.store.size, 1);

  const again = await pushEvent(db, HOUSEHOLD, event.id, [1], deps);
  assert.equal(again[0]!.status, 'updated', 'la deuxième synchro met à jour la copie distante');
  assert.equal(fake.calls.create, 1);
  assert.equal(fake.calls.update, 1);
  db.close();
});

test('une date ajoutée dans Outlook remonte dans l’agenda familial avec ses rappels', async () => {
  const { db, fake, deps } = setup('outlook');
  seedRemote(db, fake);

  const report = await pullAccount(db, 1, {
    ...deps,
    now: () => new Date('2026-09-02T09:00:00Z'),
  });

  assert.equal(report.created, 1);
  const events = listEvents(db, HOUSEHOLD);
  assert.equal(events.length, 1);
  const imported = events[0]!;
  assert.equal(imported.title, 'Comité de direction');
  assert.equal(imported.source, 'outlook');
  assert.equal(imported.starts_at, '2026-10-15T16:30:00.000Z');
  assert.equal(imported.owner_member_id, 1, 'l’événement appartient au membre du compte');
  assert.deepEqual(imported.participants.map((member) => member.name), ['Camille']);
  assert.deepEqual(
    imported.reminders.filter((item) => item.status === 'pending').map((item) => item.offset_key),
    ['week_before', 'day_before', 'same_day'],
    'les trois rappels sont planifiés dès l’import',
  );
  db.close();
});

test('un import répété ne duplique pas les événements', async () => {
  const { db, fake, deps } = setup();
  seedRemote(db, fake);

  await pullAccount(db, 1, deps);
  const second = await pullAccount(db, 1, deps);

  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(listEvents(db, HOUSEHOLD).length, 1);
  db.close();
});

test('une date déplacée dans Outlook met à jour l’événement et replanifie les rappels', async () => {
  const { db, fake, deps } = setup();
  seedRemote(db, fake);
  await pullAccount(db, 1, { ...deps, now: () => new Date('2026-09-02T09:00:00Z') });

  seedRemote(db, fake, {
    title: 'Comité de direction (reporté)',
    startsAt: '2026-10-22T16:30:00.000Z',
    endsAt: '2026-10-22T17:30:00.000Z',
    updatedAt: '2026-09-03T08:00:00.000Z',
  });
  const report = await pullAccount(db, 1, { ...deps, now: () => new Date('2026-09-03T09:00:00Z') });

  assert.equal(report.updated, 1);
  assert.equal(report.created, 0);
  const imported = listEvents(db, HOUSEHOLD)[0]!;
  assert.equal(imported.title, 'Comité de direction (reporté)');
  assert.equal(imported.starts_at, '2026-10-22T16:30:00.000Z');
  const weekBefore = imported.reminders.find((item) => item.offset_key === 'week_before')!;
  assert.equal(weekBefore.scheduled_at, '2026-10-15T06:00:00.000Z', 'rappel J-7 recalculé');
  db.close();
});

test('une date supprimée dans Outlook disparaît de l’agenda familial', async () => {
  const { db, fake, deps } = setup();
  seedRemote(db, fake);
  await pullAccount(db, 1, deps);
  assert.equal(listEvents(db, HOUSEHOLD).length, 1);

  fake.store.clear();
  const report = await pullAccount(db, 1, deps);

  assert.equal(report.deleted, 1);
  assert.equal(listEvents(db, HOUSEHOLD).length, 0);
  db.close();
});

test('une date de l’app absente de la fenêtre distante n’est jamais supprimée localement', async () => {
  const { db, fake, deps } = setup();
  const event = createEvent(db, HOUSEHOLD, {
    title: 'Anniversaire',
    startsAt: '2026-10-15T18:30',
    participantIds: [],
    syncAccountIds: [],
  } as never);
  await pushEvent(db, HOUSEHOLD, event.id, [1], deps);

  fake.store.clear(); // la copie distante disparaît
  const report = await pullAccount(db, 1, deps);

  assert.equal(report.deleted, 0);
  assert.ok(getEvent(db, HOUSEHOLD, event.id), 'l’événement local créé dans l’app est conservé');
  db.close();
});

test('un événement importé n’est pas renvoyé à sa source', async () => {
  const { db, fake, deps } = setup();
  seedRemote(db, fake);
  await pullAccount(db, 1, deps);
  const imported = listEvents(db, HOUSEHOLD)[0]!;

  const outcomes = await pushEvent(db, HOUSEHOLD, imported.id, [1], deps);

  assert.equal(outcomes[0]!.status, 'unchanged');
  assert.equal(fake.calls.update, 0, 'aucun aller-retour inutile vers le provider');
  db.close();
});

test('supprimer une date retire aussi la copie distante', async () => {
  const { db, fake, deps } = setup();
  const event = createEvent(db, HOUSEHOLD, {
    title: 'Dentiste',
    startsAt: '2026-10-15T18:30',
    participantIds: [],
    syncAccountIds: [],
  } as never);
  await pushEvent(db, HOUSEHOLD, event.id, [1], deps);
  assert.equal(fake.store.size, 1);

  await deleteRemoteCopies(db, HOUSEHOLD, event.id, deps);

  assert.equal(fake.calls.delete, 1);
  assert.equal(fake.store.size, 0);
  db.close();
});

test('une panne du provider est signalée sans interrompre la sauvegarde locale', async () => {
  const { db, deps } = setup();
  const event = createEvent(db, HOUSEHOLD, {
    title: 'Vaccin',
    startsAt: '2026-10-15T18:30',
    participantIds: [],
    syncAccountIds: [],
  } as never);

  const failing = {
    ...deps,
    accessToken: async () => {
      throw new Error('jeton expiré, reconnectez le compte');
    },
  };
  const outcomes = await pushEvent(db, HOUSEHOLD, event.id, [1], failing);

  assert.equal(outcomes[0]!.status, 'error');
  assert.match(outcomes[0]!.error!, /jeton expiré/);
  assert.ok(getEvent(db, HOUSEHOLD, event.id), 'la date reste enregistrée dans l’agenda familial');
  const account = db
    .prepare<[], { last_sync_error: string }>('SELECT last_sync_error FROM accounts WHERE id = 1')
    .get()!;
  assert.match(account.last_sync_error, /jeton expiré/, 'l’erreur est visible dans l’interface');
  db.close();
});
