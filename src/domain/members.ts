import type { Db } from '../db/index.ts';
import type { Member } from './types.ts';

export interface MemberInput {
  name: string;
  email?: string | null;
  color?: string;
  timezone?: string | null;
}

export function listMembers(db: Db): Member[] {
  return db.prepare<[], Member>('SELECT * FROM members ORDER BY name COLLATE NOCASE').all();
}

export function getMember(db: Db, id: number): Member | undefined {
  return db.prepare<[number], Member>('SELECT * FROM members WHERE id = ?').get(id);
}

export function createMember(db: Db, input: MemberInput): Member {
  const info = db
    .prepare(
      'INSERT INTO members (name, email, color, timezone) VALUES (@name, @email, @color, @timezone)',
    )
    .run({
      name: input.name.trim(),
      email: input.email?.trim() || null,
      color: input.color || '#4f7cff',
      timezone: input.timezone || null,
    });
  return getMember(db, Number(info.lastInsertRowid))!;
}

export function updateMember(db: Db, id: number, input: Partial<MemberInput>): Member | undefined {
  const current = getMember(db, id);
  if (!current) return undefined;
  db.prepare(
    `UPDATE members SET name = @name, email = @email, color = @color, timezone = @timezone
     WHERE id = @id`,
  ).run({
    id,
    name: input.name?.trim() || current.name,
    email: input.email === undefined ? current.email : input.email?.trim() || null,
    color: input.color || current.color,
    timezone: input.timezone === undefined ? current.timezone : input.timezone || null,
  });
  return getMember(db, id);
}

export function deleteMember(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM members WHERE id = ?').run(id).changes > 0;
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
  return participants.length > 0 ? participants : listMembers(db);
}
