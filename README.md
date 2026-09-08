# FamilyBoard — agenda familial partagé

Application auto-hébergée pour partager les dates du foyer : on ajoute un événement
avec son descriptif, on le synchronise avec un **compte Google personnel** et/ou un
**compte Outlook professionnel**, et un **module de rappels** prévient les membres
concernés **une semaine avant, la veille et le jour J**.

Les dates créées directement dans Outlook pro (ou dans Google) remontent
automatiquement dans l'agenda familial, avec leurs rappels.

```
┌────────────────┐   push (create/update/delete)   ┌──────────────────────┐
│  FamilyBoard   │ ──────────────────────────────► │ Google Agenda (perso)│
│  SQLite + API  │ ◄────────────────────────────── │ Outlook / MS Graph   │
└────────┬───────┘        pull (calendarView)      └──────────────────────┘
         │
         ▼  rappels J-7 / J-1 / jour J
   e-mail (SMTP) + fil de rappels in-app
```

## Démarrage rapide

```bash
npm install
cp .env.example .env          # renseigner au minimum DEFAULT_TIMEZONE
npm run dev                   # http://localhost:3000
```

En production :

```bash
npm run build && npm start
```

La base SQLite est créée et migrée automatiquement au premier lancement
(`DATABASE_PATH`, par défaut `./data/familyboard.db`).

L'application fonctionne **sans aucun compte externe** : le calendrier, les
membres et les rappels sont utilisables immédiatement. La synchronisation Google
et Outlook s'active quand les identifiants OAuth sont renseignés.

## Utilisation

1. **Ajouter les membres du foyer** (panneau de droite). Leur e-mail sert aux rappels.
2. **Ajouter une date** : bouton « + Nouvelle date » ou clic sur un jour du calendrier.
   Titre, descriptif, lieu, journée entière ou horaire, personnes concernées, et
   agendas vers lesquels pousser l'événement.
3. **Relier les comptes** : « Relier Google (perso) » et « Relier Outlook (pro) ».
   Chaque compte peut être réglé en *deux sens*, *envoyer seulement* ou *importer seulement*,
   et rattaché à un membre.
4. **Rappels** : la cloche « 🔔 Rappels » ouvre le fil des rappels envoyés.

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

### Google Agenda (compte personnel)

1. [Google Cloud Console](https://console.cloud.google.com/) → créer un projet.
2. Activer l'API **Google Calendar**.
3. Écran de consentement OAuth : type « Externe », ajouter votre adresse en
   utilisateur de test.
4. Identifiants → **ID client OAuth** → type « Application Web ».
5. URI de redirection autorisé : `{APP_BASE_URL}/api/oauth/google/callback`
6. Reporter l'ID et le secret dans `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

Portées demandées : `calendar.events`, `calendar.readonly`, `openid email profile`.

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

| Méthode & route | Rôle |
| --- | --- |
| `GET /api/health` | État du service |
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
├── db/                    Connexion SQLite + migrations embarquées
├── domain/
│   ├── events.ts          Validation (zod), normalisation des dates, CRUD
│   ├── reminders.ts       Règles J-7 / J-1 / jour J, replanification, échecs
│   ├── members.ts         Foyer et résolution des destinataires
│   ├── accounts.ts        Comptes liés, rafraîchissement des jetons, states OAuth
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
npm test        # 43 tests (node:test)
npm run typecheck
```

Couverture : règles de rappel (fuseaux, heure d'été, rattrapage, réessais),
correspondance des événements Google et Graph (aller-retour, journées entières,
fuseaux Windows), moteur de synchronisation avec provider factice (import Outlook,
absence de doublon et de boucle, suppressions, pannes), domaine des événements.

## Limites connues

- Pas d'authentification devant l'application : prévue pour un réseau domestique
  ou derrière un reverse proxy authentifié.
- Import par sondage (pas de webhooks Google/Graph) : une date ajoutée dans Outlook
  apparaît au prochain cycle, ou immédiatement via le bouton d'import.
- Les récurrences sont importées comme occurrences datées ; l'édition d'une série
  entière se fait dans l'agenda d'origine.
