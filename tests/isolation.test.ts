/**
 * Isolation entre foyers : sur une instance publique, c'est la propriété de
 * sécurité centrale. Chaque test vérifie qu'un foyer ne peut ni lire, ni
 * modifier, ni supprimer les données d'un autre.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, type Db } from '../src/db/index.ts';
import {
  createEvent,
  deleteEvent,
  eventInputSchema,
  getEvent,
  getEventDetail,
  listEvents,
  resolvePushTargets,
  updateEvent,
} from '../src/domain/events.ts';
import { createHousehold, createUser, type GoogleIdentity } from '../src/domain/households.ts';
import {
  createMember,
  deleteMember,
  getMember,
  listMembers,
  updateMember,
} from '../src/domain/members.ts';
import {
  deleteAccount,
  getAccount,
  listAccounts,
  updateAccountSettings,
  upsertAccount,
} from '../src/domain/accounts.ts';
import {
  insertNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../src/notifications/scheduler.ts';

const NOW = { now: new Date('2026-09-01T10:00:00Z') };

function parse(input: Record<string, unknown>) {
  return eventInputSchema.parse(input);
}

interface Fixture {
  db: Db;
  nous: number;
  eux: number;
}

/** Deux foyers voisins, chacun avec un membre, une date et un agenda relié. */
function twoHouseholds(): Fixture {
  const db = openDatabase(':memory:');
  const nous = createHousehold(db, 'Nous').id;
  const eux = createHousehold(db, 'Eux').id;

  const identity = (sub: string, email: string): GoogleIdentity => ({
    sub,
    email,
    name: email.split('@')[0]!,
    picture: '',
  });
  createUser(db, nous, identity('sub-nous', 'nous@exemple.fr'), 'owner');
  createUser(db, eux, identity('sub-eux', 'eux@exemple.fr'), 'owner');

  createEvent(db, nous, parse({ title: 'Notre dîner', startsAt: '2026-10-15T19:00' }), NOW);
  createEvent(db, eux, parse({ title: 'Leur dîner', startsAt: '2026-10-16T19:00' }), NOW);

  for (const [householdId, email] of [
    [nous, 'agenda-nous@exemple.fr'],
    [eux, 'agenda-eux@exemple.fr'],
  ] as const) {
    upsertAccount(db, {
      householdId,
      userId: null,
      provider: 'outlook',
      kind: 'pro',
      memberId: null,
      accountEmail: email,
      displayName: email,
      tokens: { accessToken: 'token', refreshToken: 'refresh', expiresAt: null, scope: '' },
    });
  }
  return { db, nous, eux };
}

function theirEventId(fixture: Fixture): number {
  return listEvents(fixture.db, fixture.eux)[0]!.id;
}

test('la liste des dates ne montre que celles du foyer', () => {
  const fixture = twoHouseholds();
  assert.deepEqual(listEvents(fixture.db, fixture.nous).map((e) => e.title), ['Notre dîner']);
  assert.deepEqual(listEvents(fixture.db, fixture.eux).map((e) => e.title), ['Leur dîner']);
  fixture.db.close();
});

test('une date d’un autre foyer est introuvable, même avec son identifiant', () => {
  const fixture = twoHouseholds();
  const id = theirEventId(fixture);

  assert.equal(getEvent(fixture.db, fixture.nous, id), undefined);
  assert.equal(getEventDetail(fixture.db, fixture.nous, id), undefined);
  fixture.db.close();
});

test('une date d’un autre foyer ne peut être ni modifiée ni supprimée', () => {
  const fixture = twoHouseholds();
  const id = theirEventId(fixture);

  assert.equal(
    updateEvent(fixture.db, fixture.nous, id, parse({ title: 'Piraté', startsAt: '2026-10-16T19:00' }), NOW),
    undefined,
  );
  assert.equal(deleteEvent(fixture.db, fixture.nous, id), false);

  const survivor = getEvent(fixture.db, fixture.eux, id)!;
  assert.equal(survivor.title, 'Leur dîner', 'la date de l’autre foyer est intacte');
  fixture.db.close();
});

test('un membre ne peut pas être ajouté comme participant depuis un autre foyer', () => {
  const fixture = twoHouseholds();
  const leur = listMembers(fixture.db, fixture.eux)[0]!;

  const event = createEvent(
    fixture.db,
    fixture.nous,
    parse({ title: 'Sortie', startsAt: '2026-10-20T10:00', participantIds: [leur.id] }),
    NOW,
  );

  assert.deepEqual(event.participants, [], 'le membre étranger n’est pas rattaché');
  fixture.db.close();
});

test('les fiches du foyer sont cloisonnées', () => {
  const fixture = twoHouseholds();
  createMember(fixture.db, fixture.nous, { name: 'Léo' });
  const leur = listMembers(fixture.db, fixture.eux)[0]!;

  assert.equal(getMember(fixture.db, fixture.nous, leur.id), undefined);
  assert.equal(updateMember(fixture.db, fixture.nous, leur.id, { name: 'Piraté' }), undefined);
  assert.equal(deleteMember(fixture.db, fixture.nous, leur.id), false);
  assert.equal(getMember(fixture.db, fixture.eux, leur.id)!.name, leur.name);
  fixture.db.close();
});

test('les agendas reliés ne sont visibles que dans leur foyer', () => {
  const fixture = twoHouseholds();
  const leur = listAccounts(fixture.db, fixture.eux)[0]!;

  assert.deepEqual(
    listAccounts(fixture.db, fixture.nous).map((account) => account.account_email),
    ['agenda-nous@exemple.fr'],
  );
  assert.equal(getAccount(fixture.db, fixture.nous, leur.id), undefined);
  assert.equal(
    updateAccountSettings(fixture.db, fixture.nous, leur.id, { syncEnabled: false }),
    undefined,
  );
  assert.equal(deleteAccount(fixture.db, fixture.nous, leur.id), false);
  assert.equal(getAccount(fixture.db, fixture.eux, leur.id)!.sync_enabled, 1);
  fixture.db.close();
});

test('la synchronisation ne cible jamais l’agenda d’un autre foyer', () => {
  const fixture = twoHouseholds();
  const leur = listAccounts(fixture.db, fixture.eux)[0]!;

  // Même en désignant explicitement le compte voisin, il est écarté.
  assert.deepEqual(resolvePushTargets(fixture.db, fixture.nous, [leur.id]), []);
  assert.deepEqual(
    resolvePushTargets(fixture.db, fixture.nous).map((account) => account.account_email),
    ['agenda-nous@exemple.fr'],
  );
  fixture.db.close();
});

test('le même agenda peut être relié par deux foyers sans collision', () => {
  const fixture = twoHouseholds();
  const shared = {
    userId: null,
    provider: 'google' as const,
    kind: 'personal' as const,
    memberId: null,
    accountEmail: 'partage@gmail.com',
    displayName: 'Compte partagé',
    tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: null, scope: '' },
  };

  const first = upsertAccount(fixture.db, { ...shared, householdId: fixture.nous });
  const second = upsertAccount(fixture.db, { ...shared, householdId: fixture.eux });

  assert.notEqual(first.id, second.id, 'deux liaisons distinctes, une par foyer');
  assert.equal(first.household_id, fixture.nous);
  assert.equal(second.household_id, fixture.eux);
  fixture.db.close();
});

test('le fil de rappels d’un foyer reste privé', () => {
  const fixture = twoHouseholds();
  const leurEvent = theirEventId(fixture);
  insertNotification(fixture.db, {
    householdId: fixture.eux,
    memberId: listMembers(fixture.db, fixture.eux)[0]!.id,
    eventId: leurEvent,
    reminderId: null,
    channel: 'inapp',
    title: 'Demain : Leur dîner',
    body: 'privé',
  });

  assert.deepEqual(listNotifications(fixture.db, fixture.nous), []);
  assert.equal(listNotifications(fixture.db, fixture.eux).length, 1);

  const leur = listNotifications(fixture.db, fixture.eux)[0]!;
  assert.equal(markNotificationRead(fixture.db, fixture.nous, leur.id), false);
  assert.equal(markAllNotificationsRead(fixture.db, fixture.nous), 0);
  assert.equal(listNotifications(fixture.db, fixture.eux)[0]!.read_at, null);
  fixture.db.close();
});

test('supprimer un foyer emporte ses données et laisse le voisin intact', () => {
  const fixture = twoHouseholds();
  fixture.db.prepare('DELETE FROM households WHERE id = ?').run(fixture.eux);

  assert.deepEqual(listEvents(fixture.db, fixture.nous).map((e) => e.title), ['Notre dîner']);
  assert.equal(listMembers(fixture.db, fixture.nous).length, 1);
  assert.equal(listAccounts(fixture.db, fixture.nous).length, 1);
  assert.equal(
    fixture.db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM events').get()!.n,
    1,
    'les données du foyer supprimé sont bien parties',
  );
  fixture.db.close();
});
