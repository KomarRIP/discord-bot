import type { SqliteDb } from "../sqliteDb.js";

export type AuditEvent = {
  eventId: string;
  guildId: string;
  deploymentId: string | null;
  actorUserId: string | null;
  type: string;
  payloadJson: string;
  createdAt: string;
};

export class AuditRepository {
  constructor(private readonly db: SqliteDb) {}

  insert(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
          (eventId, guildId, deploymentId, actorUserId, type, payloadJson, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        event.guildId,
        event.deploymentId,
        event.actorUserId,
        event.type,
        event.payloadJson,
        event.createdAt,
      );
  }
}

