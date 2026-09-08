import { Router } from 'express';
import { scopeOf } from '../auth/middleware.ts';
import { config, isProviderConfigured, redirectUri, type ProviderId } from '../config.ts';
import { getDb } from '../db/index.ts';
import {
  consumeOAuthState,
  createOAuthState,
  getAccessToken,
  updateAccountSettings,
  upsertAccount,
} from '../domain/accounts.ts';
import { getMemberForUser } from '../domain/households.ts';
import type { AccountKind } from '../domain/types.ts';
import { getProvider } from '../providers/index.ts';

export const oauthRouter: Router = Router();

const PROVIDER_IDS: ProviderId[] = ['google', 'outlook'];
/** Google sert le compte personnel, Outlook le compte professionnel. */
const DEFAULT_KIND: Record<ProviderId, AccountKind> = { google: 'personal', outlook: 'pro' };

function parseProvider(value: string): ProviderId | undefined {
  return PROVIDER_IDS.find((id) => id === value);
}

/** Fiche du foyer correspondant au compte connecté, si elle existe. */
function memberIdForUser(userId: number | null): number | null {
  if (userId === null) return null;
  const member = getMemberForUser(getDb(), userId);
  return member?.id ?? null;
}

function resultPage(title: string, message: string, ok: boolean): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>${escape(title)}</title>
<link rel="stylesheet" href="/styles.css"></head>
<body data-ok="${ok}"><main class="auth-page"><div class="auth-card">
  <div class="auth-mark">${ok ? '✅' : '⚠️'}</div>
  <h1>${escape(title)}</h1>
  <p class="muted">${escape(message)}</p>
  <p><a class="btn ghost" href="/">Retour à l'agenda familial</a></p>
</div></main>
<script src="/oauth-result.js" type="module"></script>
</body></html>`;
}

/** Démarre le flux OAuth2 : /api/oauth/google/start?kind=personal&memberId=1 */
oauthRouter.get('/:provider/start', (req, res) => {
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    res.status(404).json({ error: 'Provider inconnu' });
    return;
  }
  if (!isProviderConfigured(provider)) {
    res
      .status(400)
      .send(
        resultPage(
          'Connexion impossible',
          `Les identifiants OAuth de ${provider} ne sont pas configurés côté serveur (voir .env.example).`,
          false,
        ),
      );
    return;
  }
  const kind: AccountKind =
    req.query.kind === 'pro' ? 'pro' : req.query.kind === 'personal' ? 'personal' : DEFAULT_KIND[provider];
  const requestedMember = req.query.memberId ? Number(req.query.memberId) : null;
  const { householdId, userId } = scopeOf(req);
  const state = createOAuthState(getDb(), provider, kind, {
    householdId,
    userId,
    memberId: requestedMember !== null && Number.isFinite(requestedMember) ? requestedMember : null,
  });
  res.redirect(
    getProvider(provider).authorizationUrl({ state, redirectUri: redirectUri(provider) }),
  );
});

/** Callback OAuth2 : échange le code, enregistre le compte et son agenda par défaut. */
oauthRouter.get('/:provider/callback', async (req, res) => {
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    res.status(404).send(resultPage('Provider inconnu', 'Ce fournisseur n’est pas géré.', false));
    return;
  }
  const { code, state, error, error_description: description } = req.query;
  if (typeof error === 'string') {
    res
      .status(400)
      .send(
        resultPage(
          'Autorisation refusée',
          typeof description === 'string' ? description : error,
          false,
        ),
      );
    return;
  }
  if (typeof code !== 'string' || typeof state !== 'string') {
    res
      .status(400)
      .send(resultPage('Requête incomplète', 'Code ou state OAuth manquant.', false));
    return;
  }
  const consumed = consumeOAuthState(getDb(), state);
  if (!consumed || consumed.provider !== provider || consumed.household_id === null) {
    res
      .status(400)
      .send(
        resultPage(
          'Session expirée',
          'Le lien de connexion n’est plus valide, relancez la connexion depuis l’application.',
          false,
        ),
      );
    return;
  }

  try {
    const api = getProvider(provider);
    const tokens = await api.exchangeCode(code, redirectUri(provider));
    const identity = await api.identity(tokens.accessToken);
    const account = upsertAccount(getDb(), {
      householdId: consumed.household_id,
      userId: consumed.user_id,
      provider,
      kind: consumed.kind,
      // À défaut de fiche explicite, l'agenda est rattaché à la personne connectée.
      memberId: consumed.member_id ?? memberIdForUser(consumed.user_id),
      accountEmail: identity.email || `${provider}-${Date.now()}`,
      displayName: identity.displayName,
      tokens,
    });

    // Sélection automatique de l'agenda principal pour que la synchro soit utilisable de suite.
    if (!account.calendar_id) {
      const token = await getAccessToken(getDb(), account);
      const calendars = await api.listCalendars(token);
      const primary = calendars.find((calendar) => calendar.primary) ?? calendars[0];
      if (primary) {
        updateAccountSettings(getDb(), consumed.household_id, account.id, {
          calendarId: primary.id,
          calendarName: primary.name,
        });
      }
    }

    const kindLabel = consumed.kind === 'pro' ? 'professionnel' : 'personnel';
    res.send(
      resultPage(
        'Compte connecté',
        `${api.label} (${kindLabel}) — ${identity.email} est maintenant relié à l’agenda familial.`,
        true,
      ),
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    console.error('[oauth] échec du rattachement', message);
    res.status(502).send(resultPage('Échec de la connexion', message, false));
  }
});

oauthRouter.get('/config', (_req, res) => {
  res.json({
    baseUrl: config.baseUrl,
    google: { configured: isProviderConfigured('google'), redirectUri: redirectUri('google') },
    outlook: { configured: isProviderConfigured('outlook'), redirectUri: redirectUri('outlook') },
  });
});
