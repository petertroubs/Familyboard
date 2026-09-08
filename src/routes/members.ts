import { Router } from 'express';
import { z } from 'zod';
import { scopeOf } from '../auth/middleware.ts';
import { getDb } from '../db/index.ts';
import {
  createMember,
  deleteMember,
  getMember,
  listMembers,
  MemberInUseError,
  updateMember,
} from '../domain/members.ts';

const memberSchema = z.object({
  name: z.string().trim().min(1, 'Le prénom est obligatoire').max(80),
  email: z.string().trim().email('Adresse e-mail invalide').or(z.literal('')).nullish(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Couleur attendue au format #rrggbb')
    .optional(),
  timezone: z.string().trim().max(64).nullish(),
});

export const membersRouter: Router = Router();

membersRouter.get('/', (req, res) => {
  res.json({ members: listMembers(getDb(), scopeOf(req).householdId) });
});

membersRouter.post('/', (req, res) => {
  const parsed = memberSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Données invalides', details: parsed.error.issues });
    return;
  }
  res
    .status(201)
    .json({ member: createMember(getDb(), scopeOf(req).householdId, parsed.data) });
});

membersRouter.patch('/:id', (req, res) => {
  const parsed = memberSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Données invalides', details: parsed.error.issues });
    return;
  }
  const member = updateMember(
    getDb(),
    scopeOf(req).householdId,
    Number(req.params.id),
    parsed.data,
  );
  if (!member) {
    res.status(404).json({ error: 'Membre introuvable' });
    return;
  }
  res.json({ member });
});

membersRouter.delete('/:id', (req, res) => {
  const { householdId } = scopeOf(req);
  const id = Number(req.params.id);
  if (!getMember(getDb(), householdId, id)) {
    res.status(404).json({ error: 'Membre introuvable' });
    return;
  }
  try {
    deleteMember(getDb(), householdId, id);
    res.status(204).end();
  } catch (error) {
    if (error instanceof MemberInUseError) {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});
