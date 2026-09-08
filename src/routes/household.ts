import { Router } from 'express';
import { z } from 'zod';
import { requireOwner, scopeOf } from '../auth/middleware.ts';
import { config } from '../config.ts';
import { getDb } from '../db/index.ts';
import {
  getHousehold,
  listUsers,
  removeUser,
  renameHousehold,
  rotateInviteCode,
  setUserRole,
} from '../domain/households.ts';
import { getMemberForUser } from '../domain/households.ts';

export const householdRouter: Router = Router();

function inviteUrl(code: string): string {
  return `${config.baseUrl}/rejoindre/${code}`;
}

/** Vue du foyer : membres connectés et lien d'invitation à partager. */
householdRouter.get('/', (req, res) => {
  const { householdId } = scopeOf(req);
  const household = getHousehold(getDb(), householdId)!;
  const users = listUsers(getDb(), householdId).map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture,
    role: user.role,
    memberId: getMemberForUser(getDb(), user.id)?.id ?? null,
    lastLoginAt: user.last_login_at,
    isSelf: user.id === req.auth!.user.id,
  }));
  res.json({
    household: {
      id: household.id,
      name: household.name,
      timezone: household.timezone ?? config.timezone,
      inviteCode: household.invite_code,
      inviteUrl: inviteUrl(household.invite_code),
    },
    users,
  });
});

const renameSchema = z.object({ name: z.string().trim().min(1).max(80) });

householdRouter.patch('/', requireOwner, (req, res) => {
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nom de foyer invalide' });
    return;
  }
  const household = renameHousehold(getDb(), scopeOf(req).householdId, parsed.data.name);
  res.json({ household });
});

/** Invalide l'ancien lien d'invitation et en émet un nouveau. */
householdRouter.post('/invite/rotate', requireOwner, (req, res) => {
  const household = rotateInviteCode(getDb(), scopeOf(req).householdId)!;
  res.json({
    inviteCode: household.invite_code,
    inviteUrl: inviteUrl(household.invite_code),
  });
});

householdRouter.delete('/users/:id', requireOwner, (req, res) => {
  const { householdId, userId } = scopeOf(req);
  const target = Number(req.params.id);
  if (target === userId) {
    res.status(400).json({ error: 'Vous ne pouvez pas vous retirer vous-même du foyer' });
    return;
  }
  if (!removeUser(getDb(), householdId, target)) {
    res.status(404).json({ error: 'Compte introuvable dans ce foyer' });
    return;
  }
  res.status(204).end();
});

const roleSchema = z.object({ role: z.enum(['owner', 'member']) });

householdRouter.patch('/users/:id', requireOwner, (req, res) => {
  const parsed = roleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Rôle invalide' });
    return;
  }
  try {
    const user = setUserRole(
      getDb(),
      scopeOf(req).householdId,
      Number(req.params.id),
      parsed.data.role,
    );
    if (!user) {
      res.status(404).json({ error: 'Compte introuvable dans ce foyer' });
      return;
    }
    res.json({ user: { id: user.id, role: user.role } });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Changement refusé' });
  }
});
