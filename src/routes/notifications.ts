import { Router } from 'express';
import { getDb } from '../db/index.ts';
import {
  dispatchDueReminders,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../notifications/scheduler.ts';
import { REMINDER_LABELS, REMINDER_OFFSETS } from '../domain/reminders.ts';
import { isEmailConfigured, config } from '../config.ts';

export const notificationsRouter: Router = Router();

notificationsRouter.get('/', (req, res) => {
  const memberId = typeof req.query.memberId === 'string' && req.query.memberId
    ? Number(req.query.memberId)
    : undefined;
  const notifications = listNotifications(getDb(), memberId);
  res.json({
    notifications,
    unread: notifications.filter((item) => item.read_at === null).length,
    settings: {
      reminderHour: config.reminderHour,
      timezone: config.timezone,
      emailEnabled: isEmailConfigured(),
      offsets: REMINDER_OFFSETS.map((key) => ({ key, label: REMINDER_LABELS[key] })),
    },
  });
});

notificationsRouter.post('/:id/read', (req, res) => {
  if (!markNotificationRead(getDb(), Number(req.params.id))) {
    res.status(404).json({ error: 'Notification introuvable' });
    return;
  }
  res.status(204).end();
});

notificationsRouter.post('/read-all', (req, res) => {
  const memberId = typeof req.body?.memberId === 'number' ? req.body.memberId : undefined;
  res.json({ updated: markAllNotificationsRead(getDb(), memberId) });
});

/** Déclenche manuellement l'envoi des rappels échus (utile pour tester la configuration). */
notificationsRouter.post('/run', async (_req, res, next) => {
  try {
    res.json({ report: await dispatchDueReminders(getDb()) });
  } catch (error) {
    next(error);
  }
});
