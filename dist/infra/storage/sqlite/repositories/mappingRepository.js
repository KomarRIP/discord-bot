export class MappingRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    getMapping(guildId, kind, key) {
        const row = this.db
            .prepare(`SELECT guildId, kind, key, discordId, fingerprint, managedName, createdAt, updatedAt
         FROM discord_mappings WHERE guildId=? AND kind=? AND key=?`)
            .get(guildId, kind, key);
        return row ?? null;
    }
    listMappings(guildId, kind) {
        return this.db
            .prepare(`SELECT guildId, kind, key, discordId, fingerprint, managedName, createdAt, updatedAt
         FROM discord_mappings WHERE guildId=? AND kind=? ORDER BY key ASC`)
            .all(guildId, kind);
    }
    upsertMapping(params) {
        const now = new Date().toISOString();
        this.db
            .prepare(`INSERT INTO discord_mappings
          (guildId, kind, key, discordId, fingerprint, managedName, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guildId, kind, key)
         DO UPDATE SET
           discordId=excluded.discordId,
           fingerprint=excluded.fingerprint,
           managedName=excluded.managedName,
           updatedAt=excluded.updatedAt`)
            .run(params.guildId, params.kind, params.key, params.discordId, params.fingerprint, params.managedName ?? null, now, now);
        return this.getMapping(params.guildId, params.kind, params.key);
    }
}
