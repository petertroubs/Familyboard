import { Router } from 'express';
import { z } from 'zod';
import { scopeOf } from '../auth/middleware.ts';
import { config, isProviderConfigured } from '../config.ts';
import { getDb } from '../db/index.ts';
import {
  deleteAccount,
  getAccessToken,
  getAccount,
  listAccounts,
  updateAccountSettings,
} from '../domain/accounts.ts';
import type { Account } from '../domain/types.ts';
import { pullAccount } from '../domain/sync.ts';
import { getProvider } from '../providers/index.ts';

export const accountsRouter: Router = Router();

/** Les jetons ne quittent jamais le serveur. */
function publicAccount(account: Account) {
  const { access_token: _a, refresh_token: _r, ...rest } = account;
  return { ...rest, connected: Boolean(account.refresh_token || account.access_token) };
}

accountsRouter.get('/', (req, res) => {
  res.json({
    accounts: listAccounts(getDb(), scopeOf(req).householdId).map(publicAccount),
    providers: [
      {
        id: 'google',
        label: 'Google Agenda',
        defaultKind: 'personal',
        configured: isProviderConfigured('google'),
      },
      {
        id: 'outlook',
        label: 'Outlook',
        defaultKind: 'pro',
        configured: isProviderConfigured('outlook'),
      },
    ],
    timezone: req.auth?.household.timezone ?? config.timezone,
    reminderHour: config.reminderHour,
  });
});

const settingsSchema = z.object({
  calendarId: z.string().max(512).optional(),
  calendarName: z.string().max(256).optional(),
  memberId: z.number().int().positive().nullable().optional(),
  syncEnabled: z.boolean().optional(),
  syncDirection: z.enum(['push', 'pull', 'both']).optional(),
});

accountsRouter.patch('/:id', (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Données invalides', details: parsed.error.issues });
    return;
  }
  const account = updateAccountSettings(
    getDb(),
    scopeOf(req).householdId,
    Number(req.params.id),
    parsed.data,
  );
  if (!account) {
    res.status(404).json({ error: 'Compte introuvable' });
    return;
  }
  res.json({ account: publicAccount(account) });
});

/** Délier un agenda : réservé à la personne qui l'a relié, ou au responsable. */
accountsRouter.delete('/:id', (req, res) => {
  const { householdId, userId } = scopeOf(req);
  const account = getAccount(getDb(), householdId, Number(req.params.id));
  if (!account) {
    res.status(404).json({ error: 'Compte introuvable' });
    return;
  }
  if (account.user_id !== null && account.user_id !== userId && req.auth!.user.role !== 'owner') {
    res.status(403).json({ error: 'Seule la personne ayant relié cet agenda peut le délier' });
    return;
  }
  deleteAccount(getDb(), householdId, account.id);
  res.status(204).end();
});

/** Liste les agendas du compte, pour choisir celui à synchroniser. */
accountsRouter.get('/:id/calendars', async (req, res, next) => {
  try {
    const account = getAccount(getDb(), scopeOf(req).householdId, Number(req.params.id));
    if (!account) {
      res.status(404).json({ error: 'Compte introuvable' });
      return;
    }
    const token = await getAccessToken(getDb(), account);
    const calendars = await getProvider(account.provider).listCalendars(token);
    res.json({ calendars });
  } catch (error) {
    next(error);
  }
});

/** Import manuel : « récupérer maintenant les dates ajoutées dans Outlook ». */
accountsRouter.post('/:id/pull', async (req, res, next) => {
  try {
    const account = getAccount(getDb(), scopeOf(req).householdId, Number(req.params.id));
    if (!account) {
      res.status(404).json({ error: 'Compte introuvable' });
      return;
    }
    res.json({ report: await pullAccount(getDb(), account.id) });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post('/pull-all', async (req, res, next) => {
  try {
    const accounts = listAccounts(getDb(), scopeOf(req).householdId).filter(
      (account) => account.sync_enabled === 1 && ['pull', 'both'].includes(account.sync_direction),
    );
    const reports = [];
    for (const account of accounts) reports.push(await pullAccount(getDb(), account.id));
    res.json({ reports });
  } catch (error) {
    next(error);
  }
});
