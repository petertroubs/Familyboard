export type ProviderId = 'google' | 'outlook';
export type AccountKind = 'personal' | 'pro';
export type SyncDirection = 'push' | 'pull' | 'both';
export type EventSource = 'app' | ProviderId;
export type ReminderOffset = 'week_before' | 'day_before' | 'same_day';
export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export type UserRole = 'owner' | 'member';

export interface Household {
  id: number;
  name: string;
  /** Code du lien d'invitation, régénérable par le responsable du foyer. */
  invite_code: string;
  timezone: string | null;
  created_at: string;
}

export interface User {
  id: number;
  household_id: number;
  /** Identifiant Google stable, indépendant de l'adresse e-mail. */
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  role: UserRole;
  created_at: string;
  last_login_at: string | null;
}

export interface Member {
  id: number;
  household_id: number;
  /** Fiche reliée à un compte connecté, ou null pour un membre sans compte. */
  user_id: number | null;
  name: string;
  email: string | null;
  color: string;
  timezone: string | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  household_id: number;
  title: string;
  description: string;
  location: string;
  /** Instant UTC ISO-8601 (ex. 2026-09-08T16:00:00.000Z). */
  starts_at: string;
  ends_at: string;
  all_day: 0 | 1;
  timezone: string;
  owner_member_id: number | null;
  source: EventSource;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: number;
  event_id: number;
  offset_key: ReminderOffset;
  scheduled_at: string;
  status: ReminderStatus;
  attempts: number;
  sent_at: string | null;
  last_error: string | null;
}

export interface Account {
  id: number;
  household_id: number;
  /** Utilisateur ayant relié ce compte. */
  user_id: number | null;
  member_id: number | null;
  provider: ProviderId;
  kind: AccountKind;
  account_email: string;
  display_name: string;
  calendar_id: string;
  calendar_name: string;
  access_token: string;
  refresh_token: string;
  expires_at: string | null;
  scope: string;
  sync_enabled: 0 | 1;
  sync_direction: SyncDirection;
  last_sync_at: string | null;
  last_sync_error: string | null;
  created_at: string;
}

export interface EventLink {
  id: number;
  event_id: number;
  account_id: number;
  external_id: string;
  external_updated_at: string | null;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
}

export interface NotificationRow {
  id: number;
  household_id: number;
  member_id: number | null;
  event_id: number | null;
  reminder_id: number | null;
  channel: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

/** Représentation neutre d'un événement, partagée par les deux providers. */
export interface CalendarEventPayload {
  title: string;
  description: string;
  location: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timezone: string;
}

/** Événement tel que renvoyé par un provider externe. */
export interface ExternalEvent extends CalendarEventPayload {
  externalId: string;
  updatedAt: string | null;
  cancelled?: boolean;
}

export interface CalendarRef {
  id: string;
  name: string;
  primary: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string | null;
  scope: string;
}
