import 'dotenv/config';
import path from 'node:path';

function str(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const baseUrl = str('APP_BASE_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, '');

export const config = {
  port: int('PORT', 3000),
  baseUrl,
  databasePath: path.resolve(str('DATABASE_PATH', './data/familyboard.db')),
  timezone: str('DEFAULT_TIMEZONE', 'Europe/Paris'),
  /** Heure locale à laquelle partent les rappels J-7 / J-1 / jour J. */
  reminderHour: Math.min(23, Math.max(0, int('REMINDER_HOUR', 8))),
  schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 60_000),
  syncIntervalMs: int('SYNC_INTERVAL_MS', 900_000),
  google: {
    clientId: str('GOOGLE_CLIENT_ID'),
    clientSecret: str('GOOGLE_CLIENT_SECRET'),
  },
  microsoft: {
    clientId: str('MICROSOFT_CLIENT_ID'),
    clientSecret: str('MICROSOFT_CLIENT_SECRET'),
    tenantId: str('MICROSOFT_TENANT_ID', 'common'),
  },
  smtp: {
    host: str('SMTP_HOST'),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: str('SMTP_USER'),
    password: str('SMTP_PASSWORD'),
    from: str('NOTIFY_FROM', 'Agenda familial <no-reply@localhost>'),
  },
} as const;

export type ProviderId = 'google' | 'outlook';

/** Un provider n'est utilisable que si ses identifiants OAuth sont renseignés. */
export function isProviderConfigured(provider: ProviderId): boolean {
  const creds = provider === 'google' ? config.google : config.microsoft;
  return Boolean(creds.clientId && creds.clientSecret);
}

export function redirectUri(provider: ProviderId): string {
  return `${config.baseUrl}/api/oauth/${provider}/callback`;
}

export function isEmailConfigured(): boolean {
  return Boolean(config.smtp.host);
}
