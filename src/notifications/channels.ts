import nodemailer, { type Transporter } from 'nodemailer';
import { config, isEmailConfigured } from '../config.ts';
import type { Member } from '../domain/types.ts';
import type { ReminderMessage } from './messages.ts';

export interface DeliveryResult {
  channel: string;
  ok: boolean;
  error?: string;
}

/** Canal de notification : e-mail, fil in-app, ou implémentation de test. */
export interface NotificationChannel {
  readonly name: string;
  isAvailable(recipient: Member): boolean;
  send(recipient: Member, message: ReminderMessage): Promise<void>;
}

let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
  });
  return transporter;
}

export const emailChannel: NotificationChannel = {
  name: 'email',
  isAvailable(recipient) {
    return isEmailConfigured() && Boolean(recipient.email);
  },
  async send(recipient, message) {
    await getTransporter().sendMail({
      from: config.smtp.from,
      to: recipient.email!,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  },
};

/**
 * Canal de repli : trace le rappel dans les logs du serveur quand aucun SMTP
 * n'est configuré. Le fil in-app, lui, est toujours alimenté par le scheduler.
 */
export const consoleChannel: NotificationChannel = {
  name: 'console',
  isAvailable() {
    return !isEmailConfigured();
  },
  async send(recipient, message) {
    console.info(`[rappel] → ${recipient.name} : ${message.subject}`);
  },
};

export const defaultChannels: NotificationChannel[] = [emailChannel, consoleChannel];
