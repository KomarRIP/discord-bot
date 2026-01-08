import type { SqliteDb } from "../sqliteDb.js";

export type DeploymentStepStatus = "planned" | "applied" | "skipped" | "failed";
export type DeploymentStepScope = "role" | "category" | "channel" | "overwrites" | "message";
export type DeploymentStepAction = "create" | "update" | "skip";

export type DeploymentStep = {
  stepId: string;
  deploymentId: string;
  guildId: string;
  seq: number;
  scope: DeploymentStepScope;
  kind: string;
  key: string;
  fingerprint: string;
  idempotencyKey: string;
  status: DeploymentStepStatus;
  action: DeploymentStepAction;
  reason: string;
  discordId: string | null;
  resultJson: string | null;
  errorCode: string | null;
  errorJson: string | null;
  plannedAt: string;
  finishedAt: string | null;
};

export class DeploymentStepRepository {
  constructor(private readonly db: SqliteDb) {}

  insertPlanned(step: Omit<DeploymentStep, "finishedAt" | "discordId" | "resultJson" | "errorCode" | "errorJson" | "status"> & { status?: DeploymentStepStatus }): void {
    this.db
      .prepare(
        `INSERT INTO deployment_steps
          (stepId, deploymentId, guildId, seq, scope, kind, key, fingerprint, idempotencyKey,
           status, action, reason, discordId, resultJson, errorCode, errorJson, plannedAt, finishedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)`,
      )
      .run(
        step.stepId,
        step.deploymentId,
        step.guildId,
        step.seq,
        step.scope,
        step.kind,
        step.key,
        step.fingerprint,
        step.idempotencyKey,
        step.status ?? "planned",
        step.action,
        step.reason,
        step.plannedAt,
      );
  }

  markApplied(params: {
    stepId: string;
    status: "applied" | "skipped";
    discordId?: string | null;
    resultJson?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE deployment_steps
           SET status=?,
               discordId=?,
               resultJson=?,
               finishedAt=?
         WHERE stepId=?`,
      )
      .run(params.status, params.discordId ?? null, params.resultJson ?? null, now, params.stepId);
  }

  markFailed(params: { stepId: string; errorCode: string; errorJson?: string }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE deployment_steps
           SET status='failed',
               errorCode=?,
               errorJson=?,
               finishedAt=?
         WHERE stepId=?`,
      )
      .run(params.errorCode, params.errorJson ?? null, now, params.stepId);
  }
}

