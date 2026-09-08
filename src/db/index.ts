import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.ts';
import { migrations } from './schema.ts';

export type Db = Database.Database;

/**
 * Ouvre une base SQLite et applique les migrations manquantes.
 * `:memory:` est accepté (utilisé par les tests).
 */
export function openDatabase(databasePath: string = config.databasePath): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id         TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    db.prepare<[], { id: string }>('SELECT id FROM migrations').all().map((row) => row.id),
  );
  const insert = db.prepare('INSERT INTO migrations (id) VALUES (?)');
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.id);
    })();
  }
}

let singleton: Db | undefined;

/** Connexion partagée par le serveur HTTP et le planificateur. */
export function getDb(): Db {
  singleton ??= openDatabase();
  return singleton;
}

export function closeDb(): void {
  singleton?.close();
  singleton = undefined;
}
