# FamilyBoard — agenda familial partagé

Application web pour partager les dates du foyer : chacun se connecte avec son
**compte Google**, rejoint sa famille via un **lien d'invitation**, ajoute des
événements avec leur descriptif, les synchronise avec son **agenda Google personnel**
et/ou son **agenda Outlook professionnel**, et reçoit des rappels **une semaine
avant, la veille et le jour J**.

Les dates créées directement dans Outlook pro (ou dans Google) remontent
automatiquement dans l'agenda familial, avec leurs rappels.

➡️ **Mise en ligne sur un domaine (OVH ou autre) : voir [DEPLOY.md](DEPLOY.md).**

```
   connexion Google              ┌────────────────┐   push (create/update/delete)
  ────────────────────────────►  │  FamilyBoard   │ ──────────────────────────────►  Google Agenda (perso)
   lien d'invitation /rejoindre  │  SQLite + API  │ ◄──────────────────────────────  Outlook / MS Graph
  ────────────────────────────►  └────────┬───────┘        pull (calendarView)
                                          │
                                          ▼  rappels J-7 / J-1 / jour J
                                 e-mail (SMTP) + fil de rappels in-app
```

Chaque **foyer** est une famille : ses dates, ses membres, ses agendas reliés et
ses rappels ne sont visibles que par les comptes qui en font partie.

## Démarrage rapide (poste local)

```bash
npm install
cp .env.example .env          # renseigner GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm run dev                   # http://localhost:3000
```

La connexion passe par Google : créez un ID client OAuth (voir
[Configuration OAuth](#configuration-oauth)) et déclarez
`http://localhost:3000/api/auth/google/callback` en URI de redirection. La
première personne qui se connecte crée le foyer et en devient responsable.

En production :

```bash
npm run build && npm start
```

La base SQLite est créée et migrée automatiquement au premier lancement
(`DATABASE_PATH`, par défaut `./data/familyboard.db`).

## Utilisation

1. **Se connecter** avec son compte Google.
2. **Inviter la famille** : le panneau « Ma famille » affiche un lien
   `…/rejoindre/CODE` à partager. Chaque proche se connecte avec son propre compte
   Google et rejoint le même agenda. Le responsable peut régénérer le lien,
   promouvoir un autre responsable ou retirer un compte.
3. **Ajouter des fiches** pour les membres sans compte (enfants) : leur e-mail sert
   aux rappels.
4. **Ajouter une date** : bouton « + Nouvelle date » ou clic sur un jour du calendrier.
   Titre, descriptif, lieu, journée entière ou horaire, personnes concernées, et
   agendas vers lesquels pousser l'événement.
5. **Relier les agendas** : « Relier Google (perso) » et « Relier Outlook (pro) ».
   Chaque compte se règle en *deux sens*, *envoyer seulement* ou *importer seulement*.
6. **Rappels** : la cloche « 🔔 Rappels » ouvre le fil des rappels envoyés.

### Qui peut créer un compte

Réglé par `SIGNUP_MODE` :

| Mode | Effet |
| --- | --- |
| `invite` (défaut) | Uniquement via un lien d'invitation. La première connexion de l'instance crée le foyer. Recommandé pour une instance familiale exposée sur Internet. |
| `open` | Chaque nouvel arrivant crée son propre foyer, isolé des autres. |
| `allowlist` | Seules les adresses listées dans `ALLOWED_EMAILS` peuvent se connecter. |

## Module de rappels

Trois échéances sont planifiées à la création de chaque événement, puis
replanifiées si la date change :

| Rappel | Quand |
| --- | --- |
| Une semaine avant | J-7 à `REMINDER_HOUR` (heure locale du foyer) |
| La veille | J-1 à `REMINDER_HOUR` |
| Le jour J | J à `REMINDER_HOUR`, ou une heure avant l'événement s'il est plus matinal |

Détails de fonctionnement :

- Le calcul se fait dans le **fuseau de l'événement** : « la veille à 8h » reste à 8h
  locales même de part et d'autre du changement d'heure.
- Une date ajoutée tardivement (par exemple pour le lendemain) déclenche un
  **rattrapage immédiat** du rappel manqué le plus proche ; les échéances plus
  anciennes sont marquées « ignorées ».
- Un rappel déjà envoyé n'est jamais rejoué, même si l'événement est modifié.
- Un échec d'envoi est retenté aux ticks suivants, puis abandonné après 3 tentatives.
- Destinataires : les personnes cochées sur l'événement, ou tout le foyer si aucune.
- Canaux : **fil in-app** (toujours) et **e-mail** si `SMTP_HOST` est configuré.

Le planificateur tourne dans le processus serveur (`SCHEDULER_INTERVAL_MS`, 1 min par
défaut). `POST /api/notifications/run` force un passage, utile pour tester la
configuration SMTP.

## Configuration OAuth

Les redirect URI doivent être déclarés **à l'identique** chez le fournisseur.
`GET /api/oauth/config` les affiche pour l'instance en cours.

### Google (connexion + agenda personnel)

Un seul client OAuth sert à la fois à la connexion et à la synchronisation.

1. [Google Cloud Console](https://console.cloud.google.com/) → créer un projet.
2. Activer l'API **Google Calendar**.
3. Écran de consentement OAuth : type « Externe », ajouter les membres de la
   famille en utilisateurs de test tant que l'application n'est pas publiée.
4. Identifiants → **ID client OAuth** → type « Application Web ».
5. **Deux** URI de redirection autorisés :
   - `{APP_BASE_URL}/api/auth/google/callback` — connexion à l'application ;
   - `{APP_BASE_URL}/api/oauth/google/callback` — liaison de l'agenda Google.
6. Reporter l'ID et le secret dans `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Portées : `openid email profile` pour la connexion ; `calendar.events` et
`calendar.readonly` s'y ajoutent au moment de relier un agenda.

### Outlook / Microsoft 365 (compte professionnel)

1. [Portail Azure](https://portal.azure.com/) → **Inscriptions d'applications** → Nouvelle inscription.
2. Type de compte : « Comptes dans un annuaire d'organisation » (ou multi-tenant selon le besoin).
3. URI de redirection **Web** : `{APP_BASE_URL}/api/oauth/outlook/callback`
4. Certificats et secrets → **Nouveau secret client**.
5. Autorisations d'API → Microsoft Graph → déléguées : `Calendars.ReadWrite`,
   `User.Read`, `offline_access`.
6. Reporter les valeurs dans `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
   `MICROSOFT_TENANT_ID` (l'ID du tenant de l'entreprise, ou `common`).

> Beaucoup d'entreprises exigent le **consentement d'un administrateur** pour
> qu'une application tierce accède aux agendas. Si la connexion échoue avec
> `AADSTS65001`, l'administrateur Microsoft 365 doit approuver l'application.

Les jetons sont stockés dans la base locale et rafraîchis automatiquement
(2 minutes de marge avant expiration) ; ils ne sont jamais exposés par l'API.

## Synchronisation

- **Envoi** — à la création ou à la modification d'un événement, une copie est créée
  ou mise à jour dans chaque agenda coché. La suppression retire aussi les copies distantes.
- **Import** — toutes les `SYNC_INTERVAL_MS` (15 min par défaut), et à la demande via
  « ⟳ Importer les dates externes maintenant », la fenêtre **J-7 → J+180** de chaque
  agenda lié est relue. Les séries récurrentes sont développées en occurrences datées.
- **Réconciliation** — un événement importé puis supprimé côté provider disparaît de
  l'agenda familial ; un événement créé dans FamilyBoard n'est jamais supprimé par
  l'import, même si sa copie distante a disparu.
- **Pas de boucle** — un événement importé n'est pas renvoyé vers sa source tant qu'il
  n'a pas été modifié localement.
- **Conflits** — la modification distante ne s'applique que si elle est plus récente
  que celle connue (`lastModifiedDateTime` / `updated`).

## Fuseaux et journées entières

- Les instants sont stockés en **UTC** ; chaque événement conserve le fuseau de saisie.
- Pour un événement « journée entière », `ends_at` est une **borne exclusive**
  (minuit du lendemain du dernier jour), comme chez Google et Microsoft.
  L'interface, elle, se saisit en jours inclus.

## API HTTP

Toutes les routes `/api/*` exigent une session, sauf `/api/health` et
`/api/auth/*`. Chaque requête est filtrée par foyer.

| Méthode & route | Rôle |
| --- | --- |
| `GET /api/health` | État du service |
| `GET /api/auth/google/start` · `/callback` | Connexion Google |
| `GET /api/auth/session` · `POST /api/auth/logout` | État de session, déconnexion |
| `GET /rejoindre/:code` | Lien d'invitation |
| `GET /api/household` | Foyer, comptes connectés et lien d'invitation |
| `PATCH /api/household` · `POST /api/household/invite/rotate` | Renommer, régénérer le lien (responsable) |
| `PATCH/DELETE /api/household/users/:id` | Rôle, retrait d'un compte (responsable) |
| `GET /api/members` · `POST` · `PATCH /:id` · `DELETE /:id` | Membres du foyer |
| `GET /api/events?from&to&memberId` | Événements d'une fenêtre |
| `POST /api/events` | Créer une date (et la pousser vers `syncAccountIds`) |
| `GET/PUT/DELETE /api/events/:id` | Lire, modifier, supprimer |
| `POST /api/events/:id/push` | Forcer l'envoi vers les agendas liés |
| `GET /api/accounts` | Comptes liés et providers configurés |
| `PATCH /api/accounts/:id` | Agenda ciblé, membre, sens et activation de la synchro |
| `GET /api/accounts/:id/calendars` | Agendas disponibles du compte |
| `POST /api/accounts/:id/pull` · `POST /api/accounts/pull-all` | Import immédiat |
| `DELETE /api/accounts/:id` | Délier un compte |
| `GET /api/notifications?memberId` | Fil des rappels + réglages |
| `POST /api/notifications/:id/read` · `POST /read-all` | Marquer lu |
| `POST /api/notifications/run` | Déclencher les rappels échus |
| `GET /api/oauth/:provider/start` · `/callback` | Flux OAuth2 |

Exemple :

```bash
curl -X POST http://localhost:3000/api/events \
  -H 'Content-Type: application/json' \
  -d '{
        "title": "Réunion parents-profs",
        "description": "Salle B12, apporter le carnet",
        "startsAt": "2026-10-15T18:30",
        "timezone": "Europe/Paris",
        "participantIds": [1],
        "syncAccountIds": [1, 2]
      }'
```

## Architecture

```
src/
├── config.ts              Configuration (.env) et URI de redirection OAuth
├── app.ts / index.ts      Application Express, arrêt propre, planificateur
├── auth/
│   ├── google-login.ts    Connexion Google (openid/email/profile)
│   ├── sessions.ts        Sessions par cookie, jeton haché en base
│   ├── cookies.ts         Lecture/écriture du cookie de session
│   └── middleware.ts      Session, rôles, portée, CSP, anti-CSRF, anti-force brute
├── db/                    Connexion SQLite + migrations embarquées
├── domain/
│   ├── events.ts          Validation (zod), normalisation des dates, CRUD
│   ├── reminders.ts       Règles J-7 / J-1 / jour J, replanification, échecs
│   ├── members.ts         Foyer et résolution des destinataires
│   ├── households.ts      Foyers, comptes connectés, invitations, rôles
│   ├── accounts.ts        Agendas liés, rafraîchissement des jetons, states OAuth
│   └── sync.ts            Moteur d'envoi/import et réconciliation
├── providers/
│   ├── types.ts           Contrat commun aux agendas externes
│   ├── google.ts          Google Calendar v3
│   └── outlook.ts         Microsoft Graph v1.0
├── notifications/         Composition des messages, canaux, planificateur
├── routes/                API REST
└── web/                   Interface (HTML/CSS/JS natifs, sans build)
```

Le moteur de synchronisation ne connaît que l'interface `CalendarProvider` :
ajouter un fournisseur revient à écrire un module dans `src/providers/`.

## Tests

```bash
npm test        # 65 tests (node:test)
npm run typecheck
```

Couverture : règles de rappel (fuseaux, heure d'été, rattrapage, réessais),
correspondance des événements Google et Graph (aller-retour, journées entières,
fuseaux Windows), moteur de synchronisation avec provider factice (import Outlook,
absence de doublon et de boucle, suppressions, pannes), domaine des événements,
cycle de vie des sessions et invitations, et **isolation entre foyers** (aucune
lecture, modification ni suppression croisée).

## Sécurité

- Session par cookie `HttpOnly` + `SameSite=Lax`, marqué `Secure` dès que
  `APP_BASE_URL` est en `https`. Seul le **hachage SHA-256** du jeton est stocké :
  une copie de la base ne permet pas de rejouer une session. Une échéance illisible
  est traitée comme expirée.
- Inscriptions fermées par défaut (`SIGNUP_MODE=invite`), lien d'invitation
  révocable.
- Vérification d'origine sur toutes les écritures, limitation des tentatives de
  connexion, en-têtes `Content-Security-Policy` (sans `unsafe-inline`),
  `X-Frame-Options`, `Referrer-Policy` et HSTS.
- Les jetons Google et Outlook restent côté serveur et ne sont jamais renvoyés
  par l'API.
- Chaque requête est filtrée par foyer, y compris quand un identifiant d'une autre
  famille est fourni explicitement.

## Limites connues

- Import par sondage (pas de webhooks Google/Graph) : une date ajoutée dans Outlook
  apparaît au prochain cycle, ou immédiatement via le bouton d'import.
- Les récurrences sont importées comme occurrences datées ; l'édition d'une série
  entière se fait dans l'agenda d'origine.
- Connexion par compte Google uniquement (pas de mot de passe local ni d'autre
  fournisseur d'identité).
- L'image Docker n'a pas pu être construite dans l'environnement de développement
  utilisé (pas de démon Docker) ; la configuration Compose, elle, est validée.
