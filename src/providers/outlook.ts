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

const GRAPH = 'https://graph.microsoft.com/v1.0';

const SCOPES = ['offline_access', 'openid', 'email', 'profile', 'User.Read', 'Calendars.ReadWrite'];

function authority(path: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenantId)}/oauth2/v2.0/${path}`;
}

interface GraphDate {
  dateTime: string;
  timeZone?: string;
}

interface GraphEvent {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string; contentType?: string };
  location?: { displayName?: string };
  start?: GraphDate;
  end?: GraphDate;
  isAllDay?: boolean;
  lastModifiedDateTime?: string;
  isCancelled?: boolean;
}

interface GraphTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function expiresAt(expiresIn: number | undefined): string | null {
  if (!expiresIn) return null;
  return DateTime.utc().plus({ seconds: expiresIn }).toISO();
}

/** Graph attend une date locale « nue » accompagnée de son fuseau. */
function graphDate(instant: DateTime, timezone: string): GraphDate {
  return {
    dateTime: instant.setZone(timezone).toISO({ includeOffset: false, suppressMilliseconds: true })!,
    timeZone: timezone,
  };
}

/** Événement FamilyBoard -> corps d'événement Microsoft Graph. */
export function toGraphEvent(event: CalendarEventPayload): Record<string, unknown> {
  const start = DateTime.fromISO(event.startsAt, { zone: 'utc' });
  const end = DateTime.fromISO(event.endsAt, { zone: 'utc' });
  if (event.allDay) {
    const startDay = start.setZone(event.timezone).startOf('day');
    const endDay = end.setZone(event.timezone).startOf('day');
    return {
      subject: event.title,
      body: { contentType: 'text', content: event.description },
      location: { displayName: event.location },
      isAllDay: true,
      // Graph exige minuit de part et d'autre, la fin étant exclusive.
      start: graphDate(startDay, event.timezone),
      end: graphDate(endDay > startDay ? endDay : startDay.plus({ days: 1 }), event.timezone),
    };
  }
  return {
    subject: event.title,
    body: { contentType: 'text', content: event.description },
    location: { displayName: event.location },
    isAllDay: false,
    start: graphDate(start, event.timezone),
    end: graphDate(end > start ? end : start.plus({ hours: 1 }), event.timezone),
  };
}

/** Fuseaux Windows courants renvoyés par Graph, ramenés vers des identifiants IANA. */
const WINDOWS_TIMEZONES: Record<string, string> = {
  'utc': 'UTC',
  'romance standard time': 'Europe/Paris',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'gmt standard time': 'Europe/London',
  'eastern standard time': 'America/New_York',
  'pacific standard time': 'America/Los_Angeles',
};

function normalizeTimezone(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const mapped = WINDOWS_TIMEZONES[value.toLowerCase()];
  if (mapped) return mapped;
  return DateTime.local().setZone(value).isValid ? value : fallback;
}

/** Événement Microsoft Graph -> représentation neutre FamilyBoard. */
export function fromGraphEvent(item: GraphEvent, fallbackTimezone: string): ExternalEvent {
  const allDay = Boolean(item.isAllDay);
  // Un événement « journée entière » est une date : on l'ancre dans le fuseau du foyer.
  const timezone = allDay
    ? fallbackTimezone
    : normalizeTimezone(item.start?.timeZone, fallbackTimezone);
  const parseZone = allDay ? fallbackTimezone : timezone;
  const start = DateTime.fromISO(item.start?.dateTime ?? '', { zone: parseZone });
  const rawEnd = DateTime.fromISO(item.end?.dateTime ?? '', { zone: parseZone });
  const safeStart = start.isValid ? start : DateTime.now().setZone(parseZone);
  const end =
    rawEnd.isValid && rawEnd > safeStart
      ? rawEnd
      : safeStart.plus(allDay ? { days: 1 } : { hours: 1 });
  const description = (item.body?.contentType === 'html' ? item.bodyPreview : item.body?.content) ?? '';
  return {
    externalId: item.id,
    title: item.subject?.trim() || '(sans titre)',
    description: description.trim(),
    location: item.location?.displayName ?? '',
    startsAt: (allDay ? safeStart.startOf('day') : safeStart).toUTC().toISO()!,
    endsAt: end.toUTC().toISO()!,
    allDay,
    timezone,
    updatedAt: item.lastModifiedDateTime ?? null,
    cancelled: Boolean(item.isCancelled),
  };
}

/** Microsoft Graph / Outlook — utilisé pour le compte professionnel. */
export const outlookProvider: CalendarProvider = {
  id: 'outlook',
  label: 'Outlook (pro)',

  authorizationUrl({ state, redirectUri, forceConsent = false }: AuthUrlParams): string {
    const url = new URL(authority('authorize'));
    url.searchParams.set('client_id', config.microsoft.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('response_mode', 'query');
    url.searchParams.set('scope', SCOPES.join(' '));
    if (forceConsent) url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    return url.toString();
  },

  async exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    const data = await providerFetch<GraphTokenResponse>('outlook', authority('token'), {
      method: 'POST',
      body: new URLSearchParams({
        code,
        client_id: config.microsoft.clientId,
        client_secret: config.microsoft.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        scope: SCOPES.join(' '),
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
    const data = await providerFetch<GraphTokenResponse>('outlook', authority('token'), {
      method: 'POST',
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.microsoft.clientId,
        client_secret: config.microsoft.clientSecret,
        grant_type: 'refresh_token',
        scope: SCOPES.join(' '),
      }).toString(),
    });
    return {
      accessToken: data.access_token,
      // Graph fait tourner les refresh tokens : on garde le plus récent.
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: expiresAt(data.expires_in),
      scope: data.scope ?? '',
    };
  },

  async identity(accessToken: string) {
    const data = await providerFetch<{
      mail?: string;
      userPrincipalName?: string;
      displayName?: string;
    }>('outlook', `${GRAPH}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    const email = data.mail ?? data.userPrincipalName ?? '';
    return { email, displayName: data.displayName ?? email ?? 'Compte Outlook' };
  },

  async listCalendars(accessToken: string): Promise<CalendarRef[]> {
    const data = await providerFetch<{
      value?: Array<{ id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean }>;
    }>('outlook', `${GRAPH}/me/calendars`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      query: { $select: 'id,name,isDefaultCalendar,canEdit', $top: '100' },
    });
    return (data.value ?? [])
      .filter((item) => item.canEdit !== false)
      .map((item) => ({
        id: item.id,
        name: item.name ?? item.id,
        primary: Boolean(item.isDefaultCalendar),
      }));
  },

  async createEvent(accessToken, calendarId, event) {
    const data = await providerFetch<GraphEvent>(
      'outlook',
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: toGraphEvent(event),
      },
    );
    return fromGraphEvent(data, event.timezone);
  },

  async updateEvent(accessToken, _calendarId, externalId, event) {
    const data = await providerFetch<GraphEvent>(
      'outlook',
      `${GRAPH}/me/events/${encodeURIComponent(externalId)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: toGraphEvent(event),
      },
    );
    return fromGraphEvent(data, event.timezone);
  },

  async deleteEvent(accessToken, _calendarId, externalId) {
    await providerFetch('outlook', `${GRAPH}/me/events/${encodeURIComponent(externalId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  },

  async listEvents(accessToken, calendarId, window: PullWindow) {
    const events: ExternalEvent[] = [];
    // calendarView développe les séries récurrentes sur la fenêtre demandée.
    let url: string | undefined =
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView` +
      `?startDateTime=${encodeURIComponent(window.from)}&endDateTime=${encodeURIComponent(window.to)}&$top=200`;
    while (url) {
      const data: { value?: GraphEvent[]; '@odata.nextLink'?: string } = await providerFetch(
        'outlook',
        url,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            // Force des dates renvoyées en UTC plutôt que dans le fuseau de la boîte.
            Prefer: 'outlook.timezone="UTC"',
          },
        },
      );
      for (const item of data.value ?? []) {
        if (!item.start) continue;
        events.push(fromGraphEvent(item, config.timezone));
      }
      url = data['@odata.nextLink'];
    }
    return events;
  },
};
