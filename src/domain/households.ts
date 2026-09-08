import { randomBytes } from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { Household, Member, User, UserRole } from './types.ts';

/** Codes d'invitation lisibles : sans voyelles ni caractères ambigus (0/O, 1/I). */
const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';

export function generateInviteCode(length = 10): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[bytes[index]! % CODE_ALPHABET.length];
  }
  return code;
}

export function getHousehold(db: Db, id: number): Household | undefined {
  return db.prepare<[number], Household>('SELECT * FROM households WHERE id = ?').get(id);
}

export function findHouseholdByInviteCode(db: Db, code: string): Household | undefined {
  return db
    .prepare<[string], Household>('SELECT * FROM households WHERE invite_code = ?')
    .get(code.trim().toUpperCase());
}

export function createHousehold(db: Db, name: string, timezone?: string): Household {
  // Collision de code extrêmement improbable, mais on ne laisse pas l'insertion échouer.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode();
    if (findHouseholdByInviteCode(db, code)) continue;
    const info = db
      .prepare('INSERT INTO households (name, invite_code, timezone) VALUES (?, ?, ?)')
      .run(name.trim() || 'Ma famille', code, timezone ?? null);
    return getHousehold(db, Number(info.lastInsertRowid))!;
  }
  throw new Error('Impossible de générer un code d’invitation unique');
}

export function renameHousehold(db: Db, householdId: number, name: string): Household | undefined {
  db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name.trim(), householdId);
  return getHousehold(db, householdId);
}

export function rotateInviteCode(db: Db, householdId: number): Household | undefined {
  db.prepare('UPDATE households SET invite_code = ? WHERE id = ?').run(
    generateInviteCode(),
    householdId,
  );
  return getHousehold(db, householdId);
}

export function countHouseholds(db: Db): number {
  return db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM households').get()!.n;
}

// ─── Comptes connectés ───────────────────────────────────────────────────────

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

export function findUserByGoogleSub(db: Db, sub: string): User | undefined {
  return db.prepare<[string], User>('SELECT * FROM users WHERE google_sub = ?').get(sub);
}

export function getUser(db: Db, id: number): User | undefined {
  return db.prepare<[number], User>('SELECT * FROM users WHERE id = ?').get(id);
}

export function listUsers(db: Db, householdId: number): User[] {
  return db
    .prepare<[number], User>(
      `SELECT * FROM users WHERE household_id = ? ORDER BY role DESC, name COLLATE NOCASE`,
    )
    .all(householdId);
}

const MEMBER_COLORS = [
  '#4f7cff',
  '#e05a47',
  '#2f9e6c',
  '#d38b16',
  '#8a5cd6',
  '#0f9bb5',
  '#d94f8c',
  '#5b6b7f',
];

function nextMemberColor(db: Db, householdId: number): string {
  const used = db
    .prepare<[number], { color: string }>('SELECT color FROM members WHERE household_id = ?')
    .all(householdId)
    .map((row) => row.color);
  return MEMBER_COLORS.find((color) => !used.includes(color)) ?? MEMBER_COLORS[0]!;
}

/**
 * Crée le compte d'un utilisateur dans un foyer et lui attache une fiche membre.
 *
 * Si une fiche non reliée existe déjà avec la même adresse (par exemple créée à
 * l'avance par un parent), elle est reprise plutôt que dupliquée.
 */
export function createUser(
  db: Db,
  householdId: number,
  identity: GoogleIdentity,
  role: UserRole,
): User {
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO users (household_id, google_sub, email, name, picture, role, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(householdId, identity.sub, identity.email, identity.name, identity.picture, role);
    const userId = Number(info.lastInsertRowid);

    const existing = db
      .prepare<[number, string], Member>(
        'SELECT * FROM members WHERE household_id = ? AND lower(email) = lower(?) AND user_id IS NULL',
      )
      .get(householdId, identity.email);

    if (existing) {
      db.prepare('UPDATE members SET user_id = ?, name = ? WHERE id = ?').run(
        userId,
        existing.name || identity.name,
        existing.id,
      );
    } else {
      db.prepare(
        'INSERT INTO members (household_id, user_id, name, email, color) VALUES (?, ?, ?, ?, ?)',
      ).run(
        householdId,
        userId,
        identity.name || identity.email,
        identity.email,
        nextMemberColor(db, householdId),
      );
    }
    return getUser(db, userId)!;
  })();
}

/** Met à jour le profil à chaque connexion : le nom ou l'avatar peuvent changer. */
export function refreshUserProfile(db: Db, user: User, identity: GoogleIdentity): User {
  db.prepare(
    `UPDATE users SET email = ?, name = ?, picture = ?, last_login_at = datetime('now')
     WHERE id = ?`,
  ).run(identity.email, identity.name || user.name, identity.picture, user.id);
  db.prepare('UPDATE members SET name = ?, email = ? WHERE user_id = ?').run(
    identity.name || user.name,
    identity.email,
    user.id,
  );
  return getUser(db, user.id)!;
}

export function getMemberForUser(db: Db, userId: number): Member | undefined {
  return db.prepare<[number], Member>('SELECT * FROM members WHERE user_id = ?').get(userId);
}

/**
 * Retire un compte du foyer : la fiche membre est conservée (elle porte
 * l'historique des événements) mais n'est plus reliée à un compte.
 */
export function removeUser(db: Db, householdId: number, userId: number): boolean {
  const user = getUser(db, userId);
  if (!user || user.household_id !== householdId) return false;
  return db.transaction(() => {
    db.prepare('UPDATE members SET user_id = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
  })();
}

export function countOwners(db: Db, householdId: number): number {
  return db
    .prepare<[number], { n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE household_id = ? AND role = 'owner'`,
    )
    .get(householdId)!.n;
}

export function setUserRole(
  db: Db,
  householdId: number,
  userId: number,
  role: UserRole,
): User | undefined {
  const user = getUser(db, userId);
  if (!user || user.household_id !== householdId) return undefined;
  // Un foyer garde toujours au moins un responsable.
  if (user.role === 'owner' && role === 'member' && countOwners(db, householdId) <= 1) {
    throw new Error('Le foyer doit conserver au moins un responsable');
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
  return getUser(db, userId);
}
