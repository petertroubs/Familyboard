import type { Request, Response } from 'express';
import { config } from '../config.ts';

export const SESSION_COOKIE = 'fb_session';

/** Lecture d'un cookie depuis l'en-tête brut (Express ne le fait pas nativement). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, maxAgeSeconds: number): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Lax laisse passer la redirection de retour de Google tout en bloquant
    // les requêtes d'écriture déclenchées depuis un autre site.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (config.auth.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.auth.cookieSecure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
