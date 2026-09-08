import type { Db } from '../db/index.ts';
import type { Member } from './types.ts';

export interface MemberInput {
  name: string;
  email?: string | null;
  color?: string;
  timezone?: string | null;
}

export function listMembers(db: Db, householdId: number): Member[] {
  return db
    .prepare<[number], Member>(
      'SELECT * FROM members WHERE household_id = ? ORDER BY name COLLATE NOCASE',
    )
    .all(householdId);
}

export function getMember(db: Db, householdId: number, id: number): Member | undefined {
  return db
    .prepare<[number, number], Member>('SELECT * FROM members WHERE id = ? AND household_id = ?')
    .get(id, householdId);
}

export function createMember(db: Db, householdId: number, input: MemberInput): Member {
  const info = db
    .prepare(
      `INSERT INTO members (household_id, name, email, color, timezone)
       VALUES (@household_id, @name, @email, @color, @timezone)`,
    )
    .run({
      household_id: householdId,
      name: input.name.trim(),
      email: input.email?.trim() || null,
      color: input.color || '#4f7cff',
      timezone: input.timezone || null,
    });
  return getMember(db, householdId, Number(info.lastInsertRowid))!;
}

export function updateMember(
  db: Db,
  householdId: number,
  id: number,
  input: Partial<MemberInput>,
): Member | undefined {
  const current = getMember(db, householdId, id);
  if (!current) return undefined;
  db.prepare(
    `UPDATE members SET name = @name, email = @email, color = @color, timezone = @timezone
     WHERE id = @id AND household_id = @household_id`,
  ).run({
    id,
    household_id: householdId,
    name: input.name?.trim() || current.name,
    email: input.email === undefined ? current.email : input.email?.trim() || null,
    color: input.color || current.color,
    timezone: input.timezone === undefined ? current.timezone : input.timezone || null,
  });
  return getMember(db, householdId, id);
}

export class MemberInUseError extends Error {}

/**
 * Retire une fiche du foyer. Une fiche reliée à un compte connecté ne peut pas
 * être supprimée ainsi : il faut retirer la personne du foyer côté comptes.
 */
export function deleteMember(db: Db, householdId: number, id: number): boolean {
  const member = getMember(db, householdId, id);
  if (!member) return false;
  if (member.user_id !== null) {
    throw new MemberInUseError(
      'Cette fiche appartient à un compte connecté : retirez la personne du foyer.',
    );
  }
  return (
    db.prepare('DELETE FROM members WHERE id = ? AND household_id = ?').run(id, householdId)
      .changes > 0
  );
}

/** Membres à prévenir pour un événement : ses participants, sinon tout le foyer. */
export function resolveRecipients(db: Db, eventId: number): Member[] {
  const participants = db
    .prepare<[number], Member>(
      `SELECT m.* FROM members m
       JOIN event_participants ep ON ep.member_id = m.id
       WHERE ep.event_id = ?
       ORDER BY m.name COLLATE NOCASE`,
    )
    .all(eventId);
  if (participants.length > 0) return participants;

  const event = db
    .prepare<[number], { household_id: number }>('SELECT household_id FROM events WHERE id = ?')
    .get(eventId);
  return event ? listMembers(db, event.household_id) : [];
}
