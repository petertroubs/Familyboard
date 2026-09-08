import { DateTime } from 'luxon';
import { config } from '../config.ts';
import type {
  CalendarEventPayload,
  CalendarRef,
  ExternalEvent,
  TokenSet,
} from '../domain/types.ts';
import {
  providerFetch,
  type AuthUrlParams,
  type CalendarProvider,
  type PullWindow,
} from './types.ts';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'openid',
  'email',
  'profile',
];

interface GoogleDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDate;
  end?: GoogleDate;
  updated?: string;
  status?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function expiresAt(expiresIn: number | undefined): string | null {
  if (!expiresIn) return null;
  return DateTime.utc().plus({ seconds: expiresIn }).toISO();
}

/** Événement FamilyBoard -> corps d'événement Google Calendar. */
export function toGoogleEvent(event: CalendarEventPayload): Record<string, unknown> {
  const start = DateTime.fromISO(event.startsAt, { zone: 'utc' }).setZone(event.timezone);
  const end = DateTime.fromISO(event.endsAt, { zone: 'utc' }).setZone(event.timezone);
  return {
    summary: event.title,
    description: event.description,
    location: event.location,
    start: event.allDay
      ? { date: start.toISODate() }
      : { dateTime: start.toISO({ suppressMilliseconds: true }), timeZone: event.timezone },
    // Pour un événement « journée entière », Google attend une date de fin exclusive.
    end: event.allDay
      ? { date: (end > start ? end : start.plus({ days: 1 })).toISODate() }
      : { dateTime: end.toISO({ suppressMilliseconds: true }), timeZone: event.timezone },
  };
}

/** Événement Google Calendar -> représentation neutre FamilyBoard. */
export function fromGoogleEvent(item: GoogleEvent, fallbackTimezone: string): ExternalEvent {
  const timezone = item.start?.timeZone || fallbackTimezone;
  const allDay = Boolean(item.start?.date);
  const start = allDay
    ? DateTime.fromISO(item.start!.date!, { zone: timezone }).startOf('day')
    : DateTime.fromISO(item.start?.dateTime ?? '', { zone: timezone });
  const rawEnd = allDay
    ? DateTime.fromISO(item.end?.date ?? item.start!.date!, { zone: timezone }).startOf('day')
    : DateTime.fromISO(item.end?.dateTime ?? item.start?.dateTime ?? '', { zone: timezone });
  const end = rawEnd > start ? rawEnd : start.plus(allDay ? { days: 1 } : { hours: 1 });
  return {
    externalId: item.id,
    title: item.summary?.trim() || '(sans titre)',
    description: item.description ?? '',
    location: item.location ?? '',
    startsAt: start.toUTC().toISO()!,
    endsAt: end.toUTC().toISO()!,
    allDay,
    timezone,
    updatedAt: item.updated ?? null,
    cancelled: item.status === 'cancelled',
  };
}

/** Google Calendar — utilisé pour le compte personnel du foyer. */
export const googleProvider: CalendarProvider = {
  id: 'google',
  label: 'Google Agenda',

  authorizationUrl({ state, redirectUri, forceConsent = true }: AuthUrlParams): string {
    const url = new URL(AUTH_ENDPOINT);
    url.searchParams.set('client_id', config.google.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', SCOPES.join(' '));
    // access_type=offline + prompt=consent garantissent la remise d'un refresh_token.
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('include_granted_scopes', 'true');
    if (forceConsent) url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return url.toString();
  },

  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    const data = await providerFetch<GoogleTokenResponse>('google', TOKEN_ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: expiresAt(data.expires_in),
      scope: data.scope ?? '',
    };
  },

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const data = await providerFetch<GoogleTokenResponse>('google', TOKEN_ENDPOINT, {
      method: 'POST',
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        grant_type: 'refresh_token',
      }).toString(),
    });
    return {
      accessToken: data.access_token,
      // Google ne renvoie pas de nouveau refresh_token : on conserve l'existant.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: expiresAt(data.expires_in),
      scope: data.scope ?? '',
    };
  },

  async identity(accessToken: string) {
    const data = await providerFetch<{ email?: string; name?: string }>('google', USERINFO, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return { email: data.email ?? '', displayName: data.name ?? data.email ?? 'Compte Google' };
  },

  async listCalendars(accessToken: string): Promise<CalendarRef[]> {
    const data = await providerFetch<{
      items?: Array<{ id: string; summary?: string; primary?: boolean; accessRole?: string }>;
    }>('google', `${API}/users/me/calendarList`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      query: { minAccessRole: 'writer', maxResults: '100' },
    });
    return (data.items ?? []).map((item) => ({
      id: item.id,
      name: item.summary ?? item.id,
      primary: Boolean(item.primary),
    }));
  },

  async createEvent(accessToken, calendarId, event) {
    const data = await providerFetch<GoogleEvent>(
      'google',
      `${API}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: toGoogleEvent(event),
      },
    );
    return fromGoogleEvent(data, event.timezone);
  },

  async updateEvent(accessToken, calendarId, externalId, event) {
    const data = await providerFetch<GoogleEvent>(
      'google',
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: toGoogleEvent(event),
      },
    );
    return fromGoogleEvent(data, event.timezone);
  },

  async deleteEvent(accessToken, calendarId, externalId) {
    await providerFetch(
      'google',
      `${API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } },
    );
  },

  async listEvents(accessToken, calendarId, window: PullWindow) {
    const events: ExternalEvent[] = [];
    let pageToken: string | undefined;
    do {
      const data = await providerFetch<{ items?: GoogleEvent[]; nextPageToken?: string }>(
        'google',
        `${API}/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          query: {
            timeMin: window.from,
            timeMax: window.to,
            // singleEvents développe les récurrences en occurrences datées.
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: '250',
            pageToken,
          },
        },
      );
      for (const item of data.items ?? []) {
        if (!item.start) continue;
        events.push(fromGoogleEvent(item, config.timezone));
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return events;
  },
};
