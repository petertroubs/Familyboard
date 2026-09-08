import { Router } from 'express';
import { config, isLoginConfigured, loginRedirectUri } from '../config.ts';
import { getDb } from '../db/index.ts';
import {
  consumeLoginState,
  createLoginState,
  exchangeLoginCode,
  loginAuthorizationUrl,
} from '../auth/google-login.ts';
import { clearSessionCookie, readCookie, SESSION_COOKIE, setSessionCookie } from '../auth/cookies.ts';
import { createSession, destroySession } from '../auth/sessions.ts';
import { rateLimit } from '../auth/middleware.ts';
import {
  countHouseholds,
  createHousehold,
  createUser,
  findHouseholdByInviteCode,
  findUserByGoogleSub,
  getMemberForUser,
  refreshUserProfile,
  type GoogleIdentity,
} from '../domain/households.ts';
import type { Household, User } from '../domain/types.ts';

export const authRouter: Router = Router();

/** Page de retour affichée quand la connexion n'aboutit pas. */
function errorPage(title: string, message: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escape(title)}</title>
<link rel="stylesheet" href="/styles.css"></head>
<body><main class="auth-page"><div class="auth-card">
  <div class="auth-mark">⚠️</div>
  <h1>${escape(title)}</h1>
  <p class="muted">${escape(message)}</p>
  <p><a class="btn ghost" href="/">Retour à l'accueil</a></p>
</div></main></body></html>`;
}

interface SignupDecision {
  allowed: boolean;
  household?: Household;
  role: 'owner' | 'member';
  reason?: string;
}

/**
 * Décide du sort d'une première connexion, selon SIGNUP_MODE :
 *  - invite    : uniquement via un lien d'invitation valide (le tout premier
 *                compte de l'instance crée son foyer et en devient responsable) ;
 *  - open      : chaque nouvel arrivant crée son propre foyer, isolé des autres ;
 *  - allowlist : seules les adresses listées peuvent entrer.
 */
export function decideSignup(
  db: ReturnType<typeof getDb>,
  identity: GoogleIdentity,
  inviteCode: string | null,
): SignupDecision {
  const mode = config.auth.signupMode;

  if (mode === 'allowlist' && !config.auth.allowedEmails.includes(identity.email)) {
    return {
      allowed: false,
      role: 'member',
      reason:
        "Cette adresse n'est pas autorisée sur cette instance. Demandez à l'administrateur de l'ajouter.",
    };
  }

  if (inviteCode) {
    const household = findHouseholdByInviteCode(db, inviteCode);
    if (!household) {
      return {
        allowed: false,
        role: 'member',
        reason: "Ce lien d'invitation n'est plus valide. Demandez-en un nouveau à votre famille.",
      };
    }
    return { allowed: true, household, role: 'member' };
  }

  if (mode === 'open') return { allowed: true, role: 'owner' };

  // Amorçage : la toute première personne à se connecter crée le foyer.
  if (countHouseholds(db) === 0) return { allowed: true, role: 'owner' };

  return {
    allowed: false,
    role: 'member',
    reason:
      "L'inscription se fait sur invitation. Demandez à un membre de votre famille de vous envoyer son lien d'invitation.",
  };
}

/** Démarre la connexion Google. `invite` porte le code d'un lien d'invitation. */
authRouter.get('/google/start', rateLimit({ windowMs: 60_000, max: 20 }), (req, res) => {
  if (!isLoginConfigured()) {
    res
      .status(503)
      .send(
        errorPage(
          'Connexion indisponible',
          'Les identifiants OAuth Google ne sont pas configurés sur le serveur (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).',
        ),
      );
    return;
  }
  const invite = typeof req.query.invite === 'string' ? req.query.invite.toUpperCase() : null;
  const state = createLoginState(getDb(), invite, null);
  res.redirect(loginAuthorizationUrl(state));
});

/** Lien d'invitation partagé à la famille : /rejoindre/CODE */
authRouter.get('/join/:code', (req, res) => {
  const code = String(req.params.code ?? '').toUpperCase();
  const household = findHouseholdByInviteCode(getDb(), code);
  if (!household) {
    res
      .status(404)
      .send(
        errorPage(
          'Invitation inconnue',
          "Ce lien d'invitation n'existe plus. Demandez-en un nouveau à votre famille.",
        ),
      );
    return;
  }
  res.redirect(`/api/auth/google/start?invite=${encodeURIComponent(code)}`);
});

authRouter.get('/google/callback', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res) => {
  const { code, state, error } = req.query;
  if (typeof error === 'string') {
    res.status(400).send(errorPage('Connexion refusée', error));
    return;
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    res.status(400).send(errorPage('Requête incomplète', 'Code ou state manquant.'));
    return;
  }
  const stored = consumeLoginState(getDb(), state);
  if (!stored) {
    res
      .status(400)
      .send(
        errorPage(
          'Session de connexion expirée',
          'Le lien de connexion n’est plus valide. Relancez la connexion depuis la page d’accueil.',
        ),
      );
    return;
  }

  try {
    const db = getDb();
    const identity = await exchangeLoginCode(code);
    let user: User | undefined = findUserByGoogleSub(db, identity.sub);

    if (user) {
      user = refreshUserProfile(db, user, identity);
    } else {
      const decision = decideSignup(db, identity, stored.invite_code);
      if (!decision.allowed) {
        res.status(403).send(errorPage('Accès refusé', decision.reason ?? 'Inscription fermée.'));
        return;
      }
      const household =
        decision.household ??
        createHousehold(db, `Famille de ${identity.name.split(' ')[0] ?? identity.email}`);
      user = createUser(db, household.id, identity, decision.role);
    }

    const session = createSession(db, user.id, req.get('user-agent') ?? '');
    setSessionCookie(res, session.token, session.maxAgeSeconds);
    res.redirect('/');
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error('[auth] échec de la connexion', message);
    res.status(502).send(errorPage('Échec de la connexion', message));
  }
});

authRouter.post('/logout', (req, res) => {
  destroySession(getDb(), readCookie(req, SESSION_COOKIE));
  clearSessionCookie(res);
  res.status(204).end();
});

/** État de session, consommé au chargement de l'interface. */
authRouter.get('/session', (req, res) => {
  if (!req.auth) {
    res.json({
      authenticated: false,
      loginConfigured: isLoginConfigured(),
      signupMode: config.auth.signupMode,
      redirectUri: loginRedirectUri(),
    });
    return;
  }
  const member = getMemberForUser(getDb(), req.auth.user.id);
  res.json({
    authenticated: true,
    user: {
      id: req.auth.user.id,
      email: req.auth.user.email,
      name: req.auth.user.name,
      picture: req.auth.user.picture,
      role: req.auth.user.role,
      memberId: member?.id ?? null,
    },
    household: {
      id: req.auth.household.id,
      name: req.auth.household.name,
      timezone: req.auth.household.timezone ?? config.timezone,
    },
  });
});
