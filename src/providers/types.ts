import type {
  CalendarEventPayload,
  CalendarRef,
  ExternalEvent,
  ProviderId,
  TokenSet,
} from '../domain/types.ts';

export interface AuthUrlParams {
  state: string;
  redirectUri: string;
  /** Force l'écran de consentement pour obtenir un refresh_token. */
  forceConsent?: boolean;
}

export interface PullWindow {
  from: string;
  to: string;
}

/**
 * Contrat commun aux agendas externes. Google et Microsoft Graph l'implémentent
 * tous les deux, ce qui permet au moteur de synchronisation de rester agnostique.
 */
export interface CalendarProvider {
  readonly id: ProviderId;
  readonly label: string;
  /** URL d'autorisation OAuth2 (authorization code flow). */
  authorizationUrl(params: AuthUrlParams): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenSet>;
  refreshTokens(refreshToken: string): Promise<TokenSet>;
  /** Identité du compte lié, affichée dans l'interface. */
  identity(accessToken: string): Promise<{ email: string; displayName: string }>;
  listCalendars(accessToken: string): Promise<CalendarRef[]>;
  createEvent(
    accessToken: string,
    calendarId: string,
    event: CalendarEventPayload,
  ): Promise<ExternalEvent>;
  updateEvent(
    accessToken: string,
    calendarId: string,
    externalId: string,
    event: CalendarEventPayload,
  ): Promise<ExternalEvent>;
  deleteEvent(accessToken: string, calendarId: string, externalId: string): Promise<void>;
  listEvents(
    accessToken: string,
    calendarId: string,
    window: PullWindow,
  ): Promise<ExternalEvent[]>;
}

/** Erreur HTTP d'un provider ; `status` permet de distinguer un jeton expiré (401). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provider: ProviderId,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

/** Appel HTTP JSON mutualisé, avec remontée d'erreur exploitable. */
export async function providerFetch<T>(
  provider: ProviderId,
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string') {
      body = options.body;
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const response = await fetch(target, { method: options.method ?? 'GET', headers, body });
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `${provider}: ${response.status} ${response.statusText} — ${text.slice(0, 400)}`,
      response.status,
      provider,
    );
  }
  return (text ? JSON.parse(text) : {}) as T;
}
