import { config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { getEventUnscoped } from '../domain/events.ts';
import { resolveRecipients } from '../domain/members.ts';
import {
  listDueReminders,
  markReminderFailed,
  markReminderSent,
  REMINDER_LABELS,
} from '../domain/reminders.ts';
import { pullAllAccounts } from '../domain/sync.ts';
import type { NotificationRow, Reminder } from '../domain/types.ts';
import { defaultChannels, type NotificationChannel } from './channels.ts';
import { buildReminderMessage } from './messages.ts';

export interface DispatchOptions {
  channels?: NotificationChannel[];
  now?: Date;
  appUrl?: string;
}

export interface DispatchReport {
  processed: number;
  sent: number;
  failed: number;
  notified: number;
}

/**
 * Traite les rappels échus : dépose une notification in-app pour chaque
 * destinataire et tente les canaux externes (e-mail).
 */
export async function dispatchDueReminders(
  db: Db,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const channels = options.channels ?? defaultChannels;
  const now = options.now ?? new Date();
  const appUrl = options.appUrl ?? config.baseUrl;
  const report: DispatchReport = { processed: 0, sent: 0, failed: 0, notified: 0 };

  for (const reminder of listDueReminders(db, now)) {
    report.processed += 1;
    const event = getEventUnscoped(db, reminder.event_id);
    if (!event) {
      markReminderSent(db, reminder.id);
      continue;
    }
    const recipients = resolveRecipients(db, event.id);
    const errors: string[] = [];

    for (const recipient of recipients) {
      const message = buildReminderMessage(event, reminder.offset_key, recipient, appUrl);
      // Le fil in-app est la trace de référence : il est écrit même si l'e-mail échoue.
      insertNotification(db, {
        householdId: event.household_id,
        memberId: recipient.id,
        eventId: event.id,
        reminderId: reminder.id,
        channel: 'inapp',
        title: message.subject,
        body: message.text,
      });
      report.notified += 1;

      for (const channel of channels) {
        if (!channel.isAvailable(recipient)) continue;
        try {
          await channel.send(recipient, message);
        } catch (error) {
          errors.push(
            `${channel.name}/${recipient.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (errors.length > 0) {
      markReminderFailed(db, reminder.id, errors.join(' | '));
      report.failed += 1;
    } else {
      markReminderSent(db, reminder.id);
      report.sent += 1;
    }
  }
  return report;
}

export interface NewNotification {
  householdId: number;
  memberId: number | null;
  eventId: number | null;
  reminderId: number | null;
  channel: string;
  title: string;
  body: string;
}

export function insertNotification(db: Db, notification: NewNotification): number {
  const info = db
    .prepare(
      `INSERT INTO notifications (household_id, member_id, event_id, reminder_id, channel, title, body)
       VALUES (@householdId, @memberId, @eventId, @reminderId, @channel, @title, @body)`,
    )
    .run(notification);
  return Number(info.lastInsertRowid);
}

export interface NotificationFeedItem extends NotificationRow {
  event_title: string | null;
  event_starts_at: string | null;
  offset_key: string | null;
  offset_label: string | null;
}

export function listNotifications(
  db: Db,
  householdId: number,
  memberId?: number,
  limit = 50,
): NotificationFeedItem[] {
  const rows = db
    .prepare<Record<string, unknown>, NotificationFeedItem>(
      `SELECT n.*, e.title AS event_title, e.starts_at AS event_starts_at, r.offset_key
       FROM notifications n
       LEFT JOIN events e ON e.id = n.event_id
       LEFT JOIN reminders r ON r.id = n.reminder_id
       WHERE n.household_id = @householdId
         AND (@memberId IS NULL OR n.member_id = @memberId)
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT @limit`,
    )
    .all({ householdId, memberId: memberId ?? null, limit });
  return rows.map((row) => ({
    ...row,
    offset_label: row.offset_key
      ? (REMINDER_LABELS[row.offset_key as keyof typeof REMINDER_LABELS] ?? null)
      : null,
  }));
}

export function markNotificationRead(db: Db, householdId: number, id: number): boolean {
  return (
    db
      .prepare(
        `UPDATE notifications SET read_at = datetime('now')
         WHERE id = ? AND household_id = ?`,
      )
      .run(id, householdId).changes > 0
  );
}

export function markAllNotificationsRead(
  db: Db,
  householdId: number,
  memberId?: number,
): number {
  return db
    .prepare(
      `UPDATE notifications SET read_at = datetime('now')
       WHERE household_id = @householdId AND read_at IS NULL
         AND (@memberId IS NULL OR member_id = @memberId)`,
    )
    .run({ householdId, memberId: memberId ?? null }).changes;
}

export interface RunningScheduler {
  stop(): void;
}

/**
 * Démarre les tâches de fond : envoi des rappels échus et synchronisation
 * périodique des agendas liés.
 */
export function startScheduler(db: Db, options: DispatchOptions = {}): RunningScheduler {
  let dispatching = false;
  let syncing = false;

  const tick = async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      const report = await dispatchDueReminders(db, options);
      if (report.processed > 0) {
        console.info(
          `[scheduler] rappels traités=${report.processed} envoyés=${report.sent} échecs=${report.failed}`,
        );
      }
    } catch (error) {
      console.error('[scheduler] échec du traitement des rappels', error);
    } finally {
      dispatching = false;
    }
  };

  const syncTick = async () => {
    if (syncing) return;
    syncing = true;
    try {
      const reports = await pullAllAccounts(db);
      for (const item of reports) {
        if (item.error) {
          console.warn(`[sync] ${item.provider}/${item.accountEmail} : ${item.error}`);
        } else if (item.created || item.updated || item.deleted) {
          console.info(
            `[sync] ${item.provider}/${item.accountEmail} ajoutés=${item.created} modifiés=${item.updated} supprimés=${item.deleted}`,
          );
        }
      }
    } catch (error) {
      console.error('[sync] échec de la synchronisation périodique', error);
    } finally {
      syncing = false;
    }
  };

  const reminderTimer = setInterval(tick, config.schedulerIntervalMs);
  reminderTimer.unref();
  void tick();

  let syncTimer: NodeJS.Timeout | undefined;
  if (config.syncIntervalMs > 0) {
    syncTimer = setInterval(syncTick, config.syncIntervalMs);
    syncTimer.unref();
    void syncTick();
  }

  return {
    stop() {
      clearInterval(reminderTimer);
      if (syncTimer) clearInterval(syncTimer);
    },
  };
}
