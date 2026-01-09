export class AuditRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    insert(event) {
        this.db
            .prepare(`INSERT INTO audit_events
          (eventId, guildId, deploymentId, actorUserId, type, payloadJson, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(event.eventId, event.guildId, event.deploymentId, event.actorUserId, event.type, event.payloadJson, event.createdAt);
    }
}
