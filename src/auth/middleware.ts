import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.ts';
import { getDb } from '../db/index.ts';
import type { Household, User } from '../domain/types.ts';
import { readCookie, SESSION_COOKIE } from './cookies.ts';
import { resolveSession } from './sessions.ts';

export interface AuthContext {
  user: User;
  household: Household;
  sessionId: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Portée de données d'une requête authentifiée. */
export interface Scope {
  householdId: number;
  userId: number;
}

export function scopeOf(req: Request): Scope {
  const auth = req.auth;
  if (!auth) throw new Error('Requête non authentifiée');
  return { householdId: auth.household.id, userId: auth.user.id };
}

/** Attache la session si elle existe, sans exiger d'être connecté. */
export const attachSession: RequestHandler = (req, _res, next) => {
  const session = resolveSession(getDb(), readCookie(req, SESSION_COOKIE));
  if (session) req.auth = session;
  next();
};

export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.auth) {
    res.status(401).json({ error: 'Connexion requise', code: 'unauthenticated' });
    return;
  }
  next();
};

/** Réserve une action au responsable du foyer. */
export const requireOwner: RequestHandler = (req, res, next) => {
  if (!req.auth) {
    res.status(401).json({ error: 'Connexion requise', code: 'unauthenticated' });
    return;
  }
  if (req.auth.user.role !== 'owner') {
    res.status(403).json({ error: 'Action réservée au responsable du foyer' });
    return;
  }
  next();
};

/**
 * Rejette les écritures venant d'un autre site.
 *
 * Le cookie de session est en SameSite=Lax, ce qui bloque déjà l'envoi du
 * cookie sur une requête POST inter-site ; cette vérification d'origine ferme
 * le cas des navigateurs anciens et des requêtes sans en-tête d'origine.
 */
export function sameOriginOnly(): RequestHandler {
  const expected = new URL(config.baseUrl).host;
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next();
      return;
    }
    const source = req.get('origin') ?? req.get('referer');
    if (!source) {
      // Requête sans origine : un client en ligne de commande, jamais un navigateur tiers.
      next();
      return;
    }
    let host: string;
    try {
      host = new URL(source).host;
    } catch {
      res.status(403).json({ error: 'Origine invalide' });
      return;
    }
    if (host !== expected && host !== req.get('host')) {
      res.status(403).json({ error: 'Origine non autorisée' });
      return;
    }
    next();
  };
}

/** Limiteur en mémoire, suffisant pour une instance familiale mono-processus. */
export function rateLimit(options: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'inconnu';
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (entry.count >= options.max) {
      res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes' });
      return;
    } else {
      entry.count += 1;
    }
    // Purge opportuniste pour éviter que la table ne grossisse indéfiniment.
    if (hits.size > 1000) {
      for (const [entryKey, value] of hits) if (value.resetAt <= now) hits.delete(entryKey);
    }
    next();
  };
}

/** En-têtes de sécurité pour une exposition sur Internet. */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      // Les avatars Google sont servis depuis googleusercontent.com.
      "img-src 'self' data: https://*.googleusercontent.com",
      "connect-src 'self'",
      "form-action 'self' https://accounts.google.com https://login.microsoftonline.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; '),
  );
  if (config.auth.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
};
