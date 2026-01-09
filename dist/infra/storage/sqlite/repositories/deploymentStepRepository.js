export class DeploymentStepRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    insertPlanned(step) {
        this.db
            .prepare(`INSERT INTO deployment_steps
          (stepId, deploymentId, guildId, seq, scope, kind, key, fingerprint, idempotencyKey,
           status, action, reason, discordId, resultJson, errorCode, errorJson, plannedAt, finishedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`)
            .run(step.stepId, step.deploymentId, step.guildId, step.seq, step.scope, step.kind, step.key, step.fingerprint, step.idempotencyKey, step.status ?? "planned", step.action, step.reason, step.plannedAt);
    }
    markApplied(params) {
        const now = new Date().toISOString();
        this.db
            .prepare(`UPDATE deployment_steps
           SET status=?,
               discordId=?,
               resultJson=?,
               finishedAt=?
         WHERE stepId=?`)
            .run(params.status, params.discordId ?? null, params.resultJson ?? null, now, params.stepId);
    }
    markFailed(params) {
        const now = new Date().toISOString();
        this.db
            .prepare(`UPDATE deployment_steps
           SET status='failed',
               errorCode=?,
               errorJson=?,
               finishedAt=?
         WHERE stepId=?`)
            .run(params.errorCode, params.errorJson ?? null, now, params.stepId);
    }
}
