import { Router } from 'express';
import { z } from 'zod';
import { config, isProviderConfigured } from '../config.ts';
import { getDb } from '../db/index.ts';
import {
  deleteAccount,
  getAccessToken,
  getAccount,
  listAccounts,
  updateAccountSettings,
} from '../domain/accounts.ts';
import { pullAccount, pullAllAccounts } from '../domain/sync.ts';
import { getProvider } from '../providers/index.ts';

export const accountsRouter: Router = Router();

/** Les jetons ne quittent jamais le serveur. */
function publicAccount(account: ReturnType<typeof listAccounts>[number]) {
  const { access_token: _a, refresh_token: _r, ...rest } = account;
  return { ...rest, connected: Boolean(account.refresh_token || account.access_token) };
}

accountsRouter.get('/', (_req, res) => {
  res.json({
    accounts: listAccounts(getDb()).map(publicAccount),
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
    timezone: config.timezone,
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
  const account = updateAccountSettings(getDb(), Number(req.params.id), parsed.data);
  if (!account) {
    res.status(404).json({ error: 'Compte introuvable' });
    return;
  }
  res.json({ account: publicAccount(account) });
});

accountsRouter.delete('/:id', (req, res) => {
  if (!deleteAccount(getDb(), Number(req.params.id))) {
    res.status(404).json({ error: 'Compte introuvable' });
    return;
  }
  res.status(204).end();
});

/** Liste les agendas du compte, pour choisir celui à synchroniser. */
accountsRouter.get('/:id/calendars', async (req, res, next) => {
  try {
    const account = getAccount(getDb(), Number(req.params.id));
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
    const id = Number(req.params.id);
    if (!getAccount(getDb(), id)) {
      res.status(404).json({ error: 'Compte introuvable' });
      return;
    }
    res.json({ report: await pullAccount(getDb(), id) });
  } catch (error) {
    next(error);
  }
});

accountsRouter.post('/pull-all', async (_req, res, next) => {
  try {
    res.json({ reports: await pullAllAccounts(getDb()) });
  } catch (error) {
    next(error);
  }
});
