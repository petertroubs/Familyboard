import { DateTime } from 'luxon';
import type { EventRow, Member, ReminderOffset } from '../domain/types.ts';

const HEADLINES: Record<ReminderOffset, string> = {
  week_before: 'Dans une semaine',
  day_before: 'Demain',
  same_day: "Aujourd'hui",
};

function formatWhen(event: EventRow): string {
  const start = DateTime.fromISO(event.starts_at, { zone: 'utc' })
    .setZone(event.timezone)
    .setLocale('fr');
  // Le texte littéral reste hors du motif : Luxon interpréterait ses lettres comme des jetons.
  if (event.all_day === 1) return `${start.toFormat('cccc d MMMM yyyy')} (toute la journée)`;
  const end = DateTime.fromISO(event.ends_at, { zone: 'utc' }).setZone(event.timezone);
  const sameDay = start.hasSame(end, 'day');
  return sameDay
    ? `${start.toFormat("cccc d MMMM yyyy 'de' HH'h'mm")} à ${end.toFormat("HH'h'mm")}`
    : `${start.toFormat("cccc d MMMM yyyy HH'h'mm")} → ${end.setLocale('fr').toFormat("cccc d MMMM yyyy HH'h'mm")}`;
}

export interface ReminderMessage {
  subject: string;
  text: string;
  html: string;
}

/** Compose le rappel envoyé par e-mail et affiché dans le fil in-app. */
export function buildReminderMessage(
  event: EventRow,
  offset: ReminderOffset,
  recipient: Member,
  appUrl: string,
): ReminderMessage {
  const headline = HEADLINES[offset];
  const when = formatWhen(event);
  const subject = `${headline} : ${event.title}`;
  const lines = [
    `Bonjour ${recipient.name},`,
    '',
    `${headline}, un événement de l'agenda familial :`,
    '',
    `• ${event.title}`,
    `• Quand : ${when}`,
  ];
  if (event.location) lines.push(`• Où : ${event.location}`);
  if (event.description) lines.push('', event.description);
  lines.push('', `Voir l'agenda : ${appUrl}`);

  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55">
  <p>Bonjour ${escape(recipient.name)},</p>
  <p><strong>${escape(headline)}</strong>, un événement de l'agenda familial :</p>
  <p style="margin:0 0 4px"><strong>${escape(event.title)}</strong></p>
  <p style="margin:0 0 4px">${escape(when)}</p>
  ${event.location ? `<p style="margin:0 0 4px">${escape(event.location)}</p>` : ''}
  ${event.description ? `<p>${escape(event.description).replace(/\n/g, '<br>')}</p>` : ''}
  <p><a href="${escape(appUrl)}">Ouvrir l'agenda familial</a></p>
</div>`;

  return { subject, text: lines.join('\n'), html };
}

export { HEADLINES as REMINDER_HEADLINES };
