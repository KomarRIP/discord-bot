import Database from "better-sqlite3";

export type SqliteDb = Database.Database;

export function openSqliteDb(path: string): SqliteDb {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

