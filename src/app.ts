import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { accountsRouter } from './routes/accounts.ts';
import { eventsRouter } from './routes/events.ts';
import { membersRouter } from './routes/members.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { oauthRouter } from './routes/oauth.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timezone: config.timezone, reminderHour: config.reminderHour });
  });

  app.use('/api/members', membersRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/oauth', oauthRouter);

  // Interface web (servie depuis src/web en dev, dist/web après build).
  app.use(express.static(path.join(here, 'web'), { extensions: ['html'] }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Route inconnue' });
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] erreur non gérée', error);
    res.status(500).json({ error: error.message || 'Erreur interne' });
  });

  return app;
}
