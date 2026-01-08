import type { SqliteDb } from "../sqliteDb.js";

export type MappingKind = "role" | "channel" | "category" | "message";

export type Mapping = {
  guildId: string;
  kind: MappingKind;
  key: string;
  discordId: string;
  fingerprint: string;
  managedName: string | null;
  createdAt: string;
  updatedAt: string;
};

export class MappingRepository {
  constructor(private readonly db: SqliteDb) {}

  getMapping(guildId: string, kind: MappingKind, key: string): Mapping | null {
    const row = this.db
      .prepare(
        `SELECT guildId, kind, key, discordId, fingerprint, managedName, createdAt, updatedAt
         FROM discord_mappings WHERE guildId=? AND kind=? AND key=?`,
      )
      .get(guildId, kind, key) as Mapping | undefined;
    return row ?? null;
  }

  listMappings(guildId: string, kind: MappingKind): Mapping[] {
    return this.db
      .prepare(
        `SELECT guildId, kind, key, discordId, fingerprint, managedName, createdAt, updatedAt
         FROM discord_mappings WHERE guildId=? AND kind=? ORDER BY key ASC`,
      )
      .all(guildId, kind) as Mapping[];
  }

  upsertMapping(params: {
    guildId: string;
    kind: MappingKind;
    key: string;
    discordId: string;
    fingerprint: string;
    managedName?: string | null;
  }): Mapping {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO discord_mappings
          (guildId, kind, key, discordId, fingerprint, managedName, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guildId, kind, key)
         DO UPDATE SET
           discordId=excluded.discordId,
           fingerprint=excluded.fingerprint,
           managedName=excluded.managedName,
           updatedAt=excluded.updatedAt`,
      )
      .run(
        params.guildId,
        params.kind,
        params.key,
        params.discordId,
        params.fingerprint,
        params.managedName ?? null,
        now,
        now,
      );

    return this.getMapping(params.guildId, params.kind, params.key)!;
  }
}

