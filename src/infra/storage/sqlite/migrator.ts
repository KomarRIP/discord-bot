import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { SqliteDb } from "./sqliteDb.js";

type MigrationRow = { version: string; appliedAt: string; checksum: string };

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function migrateSqlite(db: SqliteDb, migrationsDir: string): Promise<void> {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);

  const applied = new Map<string, MigrationRow>();
  for (const row of db.prepare("SELECT version, appliedAt, checksum FROM schema_migrations").all() as MigrationRow[]) {
    applied.set(row.version, row);
  }

  const files = (await readdir(migrationsDir))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  for (const file of files) {
    const version = file.split("_", 1)[0]!;
    const sqlPath = path.join(migrationsDir, file);
    const sql = await readFile(sqlPath, "utf-8");
    const checksum = checksumOf(sql);

    const already = applied.get(version);
    if (already) {
      if (already.checksum !== checksum) {
        throw new Error(
          `Migration checksum mismatch for ${version}: expected ${already.checksum}, got ${checksum}`,
        );
      }
      continue;
    }

    const now = new Date().toISOString();
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, appliedAt, checksum) VALUES (?, ?, ?)").run(
        version,
        now,
        checksum,
      );
    })();
  }
}

