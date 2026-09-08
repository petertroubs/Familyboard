import { randomBytes } from 'node:crypto';
import { config, loginRedirectUri } from '../config.ts';
import type { Db } from '../db/index.ts';
import type { GoogleIdentity } from '../domain/households.ts';
import { providerFetch } from '../providers/types.ts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** Connexion seule : aucune portée d'agenda n'est demandée ici. */
const LOGIN_SCOPES = ['openid', 'email', 'profile'];

export interface LoginState {
  invite_code: string | null;
  redirect_to: string | null;
}

export function createLoginState(
  db: Db,
  inviteCode?: string | null,
  redirectTo?: string | null,
): string {
  const state = randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO auth_states (state, invite_code, redirect_to) VALUES (?, ?, ?)').run(
    state,
    inviteCode ?? null,
    redirectTo ?? null,
  );
  db.prepare(`DELETE FROM auth_states WHERE created_at < datetime('now', '-30 minutes')`).run();
  return state;
}

/** Un state ne sert qu'une fois : il est supprimé dès sa lecture. */
export function consumeLoginState(db: Db, state: string): LoginState | undefined {
  const row = db
    .prepare<[string], LoginState>('SELECT invite_code, redirect_to FROM auth_states WHERE state = ?')
    .get(state);
  if (!row) return undefined;
  db.prepare('DELETE FROM auth_states WHERE state = ?').run(state);
  return row;
}

export function loginAuthorizationUrl(state: string, loginHint?: string): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', config.google.clientId);
  url.searchParams.set('redirect_uri', loginRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', LOGIN_SCOPES.join(' '));
  url.searchParams.set('state', state);
  // Laisse l'utilisateur choisir son compte s'il en a plusieurs.
  url.searchParams.set('prompt', 'select_account');
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
}

interface UserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

/**
 * Échange le code d'autorisation puis lit l'identité.
 *
 * L'échange se fait de serveur à serveur avec le secret client : la réponse
 * vient directement de Google en TLS, il n'y a pas de jeton d'identité tiers
 * à vérifier côté application.
 */
export async function exchangeLoginCode(code: string): Promise<GoogleIdentity> {
  const tokens = await providerFetch<TokenResponse>('google', TOKEN_ENDPOINT, {
    method: 'POST',
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: loginRedirectUri(),
      grant_type: 'authorization_code',
    }).toString(),
  });

  const info = await providerFetch<UserInfo>('google', USERINFO, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!info.email || info.email_verified === false) {
    throw new Error('Compte Google sans adresse e-mail vérifiée');
  }
  return {
    sub: info.sub,
    email: info.email.toLowerCase(),
    name: info.name ?? info.email,
    picture: info.picture ?? '',
  };
}
