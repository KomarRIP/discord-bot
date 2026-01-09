import Database from "better-sqlite3";
export function openSqliteDb(path) {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
}
