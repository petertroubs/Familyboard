/**
 * Schéma SQLite de FamilyBoard.
 *
 * Le schéma est embarqué dans le code (plutôt qu'un fichier .sql à copier au
 * build) pour que `node dist/index.js` fonctionne sans étape d'installation.
 * Chaque migration est idempotente et rejouée dans l'ordre au démarrage.
 */

export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_initial',
    sql: `
    -- Membres du foyer : destinataires des rappels et propriétaires d'événements.
    CREATE TABLE IF NOT EXISTS members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      email       TEXT,
      color       TEXT NOT NULL DEFAULT '#4f7cff',
      timezone    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Événements de l'agenda familial. Les instants sont stockés en UTC ISO-8601 ;
    -- 'timezone' conserve le fuseau de saisie pour l'affichage et les rappels.
    CREATE TABLE IF NOT EXISTS events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      location        TEXT NOT NULL DEFAULT '',
      starts_at       TEXT NOT NULL,
      ends_at         TEXT NOT NULL,
      all_day         INTEGER NOT NULL DEFAULT 0,
      timezone        TEXT NOT NULL,
      owner_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      -- 'app' : créé dans FamilyBoard ; 'google'/'outlook' : importé d'un agenda lié.
      source          TEXT NOT NULL DEFAULT 'app',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at);

    -- Participants d'un événement : détermine qui reçoit les rappels.
    CREATE TABLE IF NOT EXISTS event_participants (
      event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      PRIMARY KEY (event_id, member_id)
    );

    -- Comptes de calendrier externes liés (Google perso, Outlook pro).
    CREATE TABLE IF NOT EXISTS accounts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id      INTEGER REFERENCES members(id) ON DELETE CASCADE,
      provider       TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
      -- Étiquette d'usage : un même membre peut lier un compte perso et un pro.
      kind           TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'pro')),
      account_email  TEXT NOT NULL DEFAULT '',
      display_name   TEXT NOT NULL DEFAULT '',
      calendar_id    TEXT NOT NULL DEFAULT '',
      calendar_name  TEXT NOT NULL DEFAULT '',
      access_token   TEXT NOT NULL DEFAULT '',
      refresh_token  TEXT NOT NULL DEFAULT '',
      -- Expiration du jeton d'accès (UTC ISO-8601).
      expires_at     TEXT,
      scope          TEXT NOT NULL DEFAULT '',
      sync_enabled   INTEGER NOT NULL DEFAULT 1,
      -- 'push' : FamilyBoard -> agenda ; 'pull' : agenda -> FamilyBoard ; 'both'.
      sync_direction TEXT NOT NULL DEFAULT 'both' CHECK (sync_direction IN ('push', 'pull', 'both')),
      last_sync_at   TEXT,
      last_sync_error TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (provider, account_email, kind)
    );

    -- Correspondance entre un événement FamilyBoard et sa copie chez un provider.
    CREATE TABLE IF NOT EXISTS event_links (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id           INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      external_id        TEXT NOT NULL,
      -- Date de dernière modification connue côté provider (détection des écarts).
      external_updated_at TEXT,
      last_pushed_at     TEXT,
      last_pulled_at     TEXT,
      UNIQUE (account_id, external_id),
      UNIQUE (event_id, account_id)
    );

    -- Rappels planifiés : une ligne par échéance (J-7, J-1, jour J).
    CREATE TABLE IF NOT EXISTS reminders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      offset_key   TEXT NOT NULL CHECK (offset_key IN ('week_before', 'day_before', 'same_day')),
      scheduled_at TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
      attempts     INTEGER NOT NULL DEFAULT 0,
      sent_at      TEXT,
      last_error   TEXT,
      UNIQUE (event_id, offset_key)
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, scheduled_at);

    -- Fil de notifications in-app (une ligne par membre notifié).
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id   INTEGER REFERENCES members(id) ON DELETE CASCADE,
      event_id    INTEGER REFERENCES events(id) ON DELETE CASCADE,
      reminder_id INTEGER REFERENCES reminders(id) ON DELETE SET NULL,
      channel     TEXT NOT NULL DEFAULT 'inapp',
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      read_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id, created_at);

    -- Anti-CSRF du flux OAuth : states à usage unique, purgés après échange.
    CREATE TABLE IF NOT EXISTS oauth_states (
      state      TEXT PRIMARY KEY,
      provider   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      member_id  INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    `,
  },
  {
    id: '002_comptes_et_foyers',
    sql: `
    -- Un foyer regroupe les personnes qui partagent le même agenda.
    -- Toutes les données applicatives lui sont rattachées : c'est la frontière
    -- d'isolation entre familles sur une instance publique.
    CREATE TABLE IF NOT EXISTS households (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      -- Code court partagé par le lien d'invitation ; régénérable par le responsable.
      invite_code TEXT NOT NULL UNIQUE,
      timezone    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Comptes authentifiés (connexion Google). Un utilisateur appartient à un foyer.
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id  INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      -- Identifiant stable Google ('sub') : ne change pas si l'adresse évolue.
      google_sub    TEXT NOT NULL UNIQUE,
      email         TEXT NOT NULL,
      name          TEXT NOT NULL DEFAULT '',
      picture       TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_household ON users(household_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_household ON users(household_id, email);

    -- Sessions de connexion. Seul le hachage du jeton est stocké : une fuite de
    -- la base ne permet pas de rejouer une session.
    CREATE TABLE IF NOT EXISTS sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash   TEXT NOT NULL UNIQUE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at   TEXT NOT NULL,
      last_seen_at TEXT,
      user_agent   TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- States anti-CSRF du flux de connexion (distinct du flux de liaison d'agenda).
    CREATE TABLE IF NOT EXISTS auth_states (
      state       TEXT PRIMARY KEY,
      invite_code TEXT,
      redirect_to TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rattachement des données existantes à un foyer.
    ALTER TABLE members       ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE;
    ALTER TABLE events        ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE;
    ALTER TABLE accounts      ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE;
    ALTER TABLE notifications ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE;
    -- Une fiche du foyer peut être reliée à un compte connecté (ou rester sans
    -- compte : un enfant figure à l'agenda sans avoir à se connecter).
    ALTER TABLE members  ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    -- Compte Google/Outlook relié : on retient qui l'a connecté.
    ALTER TABLE accounts ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS idx_members_household ON members(household_id);
    CREATE INDEX IF NOT EXISTS idx_events_household ON events(household_id, starts_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_household ON notifications(household_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

    -- Le flux de liaison d'agenda retient désormais le foyer et l'utilisateur.
    ALTER TABLE oauth_states ADD COLUMN household_id INTEGER;
    ALTER TABLE oauth_states ADD COLUMN user_id INTEGER;

    -- Reprise des données d'une instance mono-foyer antérieure à l'authentification.
    INSERT INTO households (name, invite_code)
    SELECT 'Ma famille', lower(hex(randomblob(5)))
    WHERE (SELECT COUNT(*) FROM members) + (SELECT COUNT(*) FROM events)
        + (SELECT COUNT(*) FROM accounts) > 0;

    UPDATE members       SET household_id = (SELECT MIN(id) FROM households) WHERE household_id IS NULL;
    UPDATE events        SET household_id = (SELECT MIN(id) FROM households) WHERE household_id IS NULL;
    UPDATE accounts      SET household_id = (SELECT MIN(id) FROM households) WHERE household_id IS NULL;
    UPDATE notifications SET household_id = (SELECT MIN(id) FROM households) WHERE household_id IS NULL;

    -- L'unicité d'un agenda relié devient interne au foyer : deux familles
    -- distinctes peuvent relier la même adresse (parents séparés, par exemple).
    -- SQLite ne sait pas retirer une contrainte : la table est reconstruite.
    CREATE TABLE accounts_v2 (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id   INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      member_id      INTEGER REFERENCES members(id) ON DELETE CASCADE,
      provider       TEXT NOT NULL CHECK (provider IN ('google', 'outlook')),
      kind           TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'pro')),
      account_email  TEXT NOT NULL DEFAULT '',
      display_name   TEXT NOT NULL DEFAULT '',
      calendar_id    TEXT NOT NULL DEFAULT '',
      calendar_name  TEXT NOT NULL DEFAULT '',
      access_token   TEXT NOT NULL DEFAULT '',
      refresh_token  TEXT NOT NULL DEFAULT '',
      expires_at     TEXT,
      scope          TEXT NOT NULL DEFAULT '',
      sync_enabled   INTEGER NOT NULL DEFAULT 1,
      sync_direction TEXT NOT NULL DEFAULT 'both' CHECK (sync_direction IN ('push', 'pull', 'both')),
      last_sync_at   TEXT,
      last_sync_error TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (household_id, provider, account_email, kind)
    );

    INSERT INTO accounts_v2 (id, household_id, user_id, member_id, provider, kind, account_email,
                             display_name, calendar_id, calendar_name, access_token, refresh_token,
                             expires_at, scope, sync_enabled, sync_direction, last_sync_at,
                             last_sync_error, created_at)
    SELECT id, household_id, user_id, member_id, provider, kind, account_email,
           display_name, calendar_id, calendar_name, access_token, refresh_token,
           expires_at, scope, sync_enabled, sync_direction, last_sync_at,
           last_sync_error, created_at
    FROM accounts;

    DROP TABLE accounts;
    ALTER TABLE accounts_v2 RENAME TO accounts;
    CREATE INDEX IF NOT EXISTS idx_accounts_household ON accounts(household_id);
    `,
  },
];
