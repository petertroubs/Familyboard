import { config } from './config.ts';
import { getDb } from './db/index.ts';
import { createApp } from './app.ts';
import { startScheduler } from './notifications/scheduler.ts';

const db = getDb();
const app = createApp();
const scheduler = startScheduler(db);

const server = app.listen(config.port, () => {
  console.info(`FamilyBoard écoute sur ${config.baseUrl} (fuseau ${config.timezone})`);
  console.info(
    `Rappels J-7 / J-1 / jour J envoyés à ${String(config.reminderHour).padStart(2, '0')}h00 locales`,
  );
});

function shutdown(signal: string): void {
  console.info(`\n[${signal}] arrêt de FamilyBoard…`);
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
