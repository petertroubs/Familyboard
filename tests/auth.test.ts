import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase, type Db } from '../src/db/index.ts';
import { createSession, destroySession, resolveSession } from '../src/auth/sessions.ts';
import {
  countHouseholds,
  createHousehold,
  createUser,
  findHouseholdByInviteCode,
  findUserByGoogleSub,
  getMemberForUser,
  refreshUserProfile,
  removeUser,
  rotateInviteCode,
  setUserRole,
  type GoogleIdentity,
} from '../src/domain/households.ts';

function identity(overrides: Partial<GoogleIdentity> = {}): GoogleIdentity {
  return {
    sub: 'google-sub-1',
    email: 'pierre@exemple.fr',
    name: 'Pierre',
    picture: 'https://exemple.fr/p.jpg',
    ...overrides,
  };
}

function setup(): Db {
  return openDatabase(':memory:');
}

test('la première connexion crée le foyer et sa fiche membre', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille Dupont');
  const user = createUser(db, household.id, identity(), 'owner');

  assert.equal(user.role, 'owner');
  assert.equal(user.household_id, household.id);
  const member = getMemberForUser(db, user.id)!;
  assert.equal(member.name, 'Pierre');
  assert.equal(member.email, 'pierre@exemple.fr');
  assert.equal(member.household_id, household.id);
  db.close();
});

test('rejoindre un foyer reprend une fiche existante au lieu de la dupliquer', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille Dupont');
  // Le responsable a créé la fiche de Marie à l'avance, avec son adresse.
  db.prepare(
    `INSERT INTO members (household_id, name, email, color) VALUES (?, 'Marie', 'marie@exemple.fr', '#e05a47')`,
  ).run(household.id);

  const marie = createUser(
    db,
    household.id,
    identity({ sub: 'sub-marie', email: 'marie@exemple.fr', name: 'Marie D.' }),
    'member',
  );

  const members = db
    .prepare<[number], { id: number; user_id: number | null; color: string }>(
      'SELECT id, user_id, color FROM members WHERE household_id = ?',
    )
    .all(household.id);
  assert.equal(members.length, 1, 'aucune fiche en double');
  assert.equal(members[0]!.user_id, marie.id, 'la fiche est reliée au compte');
  assert.equal(members[0]!.color, '#e05a47', 'la couleur choisie est conservée');
  db.close();
});

test('chaque membre du foyer reçoit une couleur distincte', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  createUser(db, household.id, identity({ sub: 'a', email: 'a@exemple.fr' }), 'owner');
  createUser(db, household.id, identity({ sub: 'b', email: 'b@exemple.fr' }), 'member');
  createUser(db, household.id, identity({ sub: 'c', email: 'c@exemple.fr' }), 'member');

  const colors = db
    .prepare<[number], { color: string }>('SELECT color FROM members WHERE household_id = ?')
    .all(household.id)
    .map((row) => row.color);
  assert.equal(new Set(colors).size, 3);
  db.close();
});

test('le code d’invitation retrouve le foyer, quelle que soit la casse', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  assert.equal(findHouseholdByInviteCode(db, household.invite_code)?.id, household.id);
  assert.equal(findHouseholdByInviteCode(db, household.invite_code.toLowerCase())?.id, household.id);
  assert.equal(findHouseholdByInviteCode(db, 'INEXISTANT9'), undefined);
  db.close();
});

test('régénérer le lien invalide l’ancien code', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const previous = household.invite_code;

  const rotated = rotateInviteCode(db, household.id)!;

  assert.notEqual(rotated.invite_code, previous);
  assert.equal(findHouseholdByInviteCode(db, previous), undefined);
  assert.equal(findHouseholdByInviteCode(db, rotated.invite_code)?.id, household.id);
  db.close();
});

test('une session valide résout son utilisateur et son foyer', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const user = createUser(db, household.id, identity(), 'owner');

  const { token } = createSession(db, user.id, 'navigateur de test');
  const session = resolveSession(db, token)!;

  assert.equal(session.user.id, user.id);
  assert.equal(session.household.id, household.id);
  db.close();
});

test('le jeton de session n’est jamais stocké en clair', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const user = createUser(db, household.id, identity(), 'owner');
  const { token } = createSession(db, user.id);

  const stored = db
    .prepare<[], { token_hash: string }>('SELECT token_hash FROM sessions')
    .get()!;
  assert.notEqual(stored.token_hash, token);
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
  db.close();
});

test('un jeton inconnu, expiré ou déconnecté ne donne aucune session', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const user = createUser(db, household.id, identity(), 'owner');

  assert.equal(resolveSession(db, undefined), undefined);
  assert.equal(resolveSession(db, 'jeton-inventé'), undefined);

  const { token } = createSession(db, user.id);
  destroySession(db, token);
  assert.equal(resolveSession(db, token), undefined, 'la déconnexion invalide le jeton');

  const { token: expiring } = createSession(db, user.id);
  db.prepare(`UPDATE sessions SET expires_at = datetime('now', '-1 day')`).run();
  assert.equal(resolveSession(db, expiring), undefined, 'une session expirée est rejetée');
  assert.equal(
    db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sessions').get()!.n,
    0,
    'la session expirée est purgée',
  );
  db.close();
});

test('retirer un compte ferme ses sessions et conserve son historique', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const owner = createUser(db, household.id, identity(), 'owner');
  const other = createUser(
    db,
    household.id,
    identity({ sub: 'sub-2', email: 'alex@exemple.fr', name: 'Alex' }),
    'member',
  );
  const { token } = createSession(db, other.id);
  const memberId = getMemberForUser(db, other.id)!.id;

  assert.equal(removeUser(db, household.id, other.id), true);

  assert.equal(resolveSession(db, token), undefined, 'les sessions sont révoquées');
  const member = db
    .prepare<[number], { id: number; user_id: number | null }>(
      'SELECT id, user_id FROM members WHERE id = ?',
    )
    .get(memberId)!;
  assert.equal(member.user_id, null, 'la fiche du foyer survit au retrait du compte');
  assert.ok(findUserByGoogleSub(db, identity().sub), 'les autres comptes ne bougent pas');
  assert.equal(owner.role, 'owner');
  db.close();
});

test('un foyer conserve toujours au moins un responsable', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const owner = createUser(db, household.id, identity(), 'owner');

  assert.throws(() => setUserRole(db, household.id, owner.id, 'member'), /au moins un responsable/);

  const second = createUser(
    db,
    household.id,
    identity({ sub: 'sub-2', email: 'alex@exemple.fr' }),
    'member',
  );
  setUserRole(db, household.id, second.id, 'owner');
  // Avec deux responsables, la rétrogradation redevient possible.
  assert.equal(setUserRole(db, household.id, owner.id, 'member')!.role, 'member');
  db.close();
});

test('une action sur un compte d’un autre foyer est refusée', () => {
  const db = setup();
  const nous = createHousehold(db, 'Nous');
  const eux = createHousehold(db, 'Eux');
  const leur = createUser(db, eux.id, identity({ sub: 'sub-eux', email: 'eux@exemple.fr' }), 'owner');

  assert.equal(removeUser(db, nous.id, leur.id), false);
  assert.equal(setUserRole(db, nous.id, leur.id, 'member'), undefined);
  assert.equal(countHouseholds(db), 2);
  db.close();
});

test('une reconnexion met à jour le profil sans créer de doublon', () => {
  const db = setup();
  const household = createHousehold(db, 'Famille');
  const user = createUser(db, household.id, identity(), 'owner');

  const updated = refreshUserProfile(
    db,
    user,
    identity({ name: 'Pierre-Antoine', picture: 'https://exemple.fr/n.jpg' }),
  );

  assert.equal(updated.name, 'Pierre-Antoine');
  assert.ok(updated.last_login_at);
  assert.equal(db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM users').get()!.n, 1);
  assert.equal(getMemberForUser(db, user.id)!.name, 'Pierre-Antoine');
  db.close();
});
