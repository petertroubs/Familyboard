import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  attachSession,
  rateLimit,
  requireAuth,
  sameOriginOnly,
  securityHeaders,
} from './auth/middleware.ts';
import { config, isLoginConfigured } from './config.ts';
import { accountsRouter } from './routes/accounts.ts';
import { authRouter } from './routes/auth.ts';
import { eventsRouter } from './routes/events.ts';
import { householdRouter } from './routes/household.ts';
import { membersRouter } from './routes/members.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { oauthRouter } from './routes/oauth.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  // Derrière nginx/Caddy, l'IP cliente et le protocole viennent des en-têtes X-Forwarded-*.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '256kb' }));
  app.use(sameOriginOnly());
  app.use(attachSession);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', loginConfigured: isLoginConfigured() });
  });

  // Connexion : accessible sans session, par définition.
  app.use('/api/auth', authRouter);
  app.get('/rejoindre/:code', (req, res) => {
    res.redirect(`/api/auth/join/${encodeURIComponent(String(req.params.code))}`);
  });

  // Tout le reste de l'API exige une session valide.
  app.use('/api/members', requireAuth, membersRouter);
  app.use('/api/events', requireAuth, eventsRouter);
  app.use('/api/accounts', requireAuth, accountsRouter);
  app.use('/api/notifications', requireAuth, notificationsRouter);
  app.use('/api/household', requireAuth, householdRouter);
  app.use('/api/oauth', requireAuth, rateLimit({ windowMs: 60_000, max: 30 }), oauthRouter);

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
