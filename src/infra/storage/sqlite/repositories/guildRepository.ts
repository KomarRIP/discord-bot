import type { SqliteDb } from "../sqliteDb.js";

export type GuildState = {
  guildId: string;
  activeTemplateId: string | null;
  activeTemplateVersion: string | null;
  activeSchemaVersion: string | null;
  deploymentVersion: number;
  deploymentConfigHash: string | null;
  installedAt: string | null;
  updatedAt: string;
};

export type DeploymentStatus = "started" | "completed" | "failed" | "cancelled";

export class GuildRepository {
  constructor(private readonly db: SqliteDb) {}

  getGuildState(guildId: string): GuildState | null {
    const row = this.db
      .prepare(
        `SELECT guildId, activeTemplateId, activeTemplateVersion, activeSchemaVersion,
                deploymentVersion, deploymentConfigHash, installedAt, updatedAt
         FROM guilds WHERE guildId = ?`,
      )
      .get(guildId) as GuildState | undefined;
    return row ?? null;
  }

  upsertGuildState(guildId: string, patch: Partial<Omit<GuildState, "guildId">>): GuildState {
    const now = new Date().toISOString();
    const existing = this.getGuildState(guildId);

    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO guilds
            (guildId, activeTemplateId, activeTemplateVersion, activeSchemaVersion,
             deploymentVersion, deploymentConfigHash, installedAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          guildId,
          patch.activeTemplateId ?? null,
          patch.activeTemplateVersion ?? null,
          patch.activeSchemaVersion ?? null,
          patch.deploymentVersion ?? 0,
          patch.deploymentConfigHash ?? null,
          patch.installedAt ?? null,
          now,
        );
      return this.getGuildState(guildId)!;
    }

    this.db
      .prepare(
        `UPDATE guilds
           SET activeTemplateId=?,
               activeTemplateVersion=?,
               activeSchemaVersion=?,
               deploymentVersion=?,
               deploymentConfigHash=?,
               installedAt=?,
               updatedAt=?
         WHERE guildId=?`,
      )
      .run(
        patch.activeTemplateId ?? existing.activeTemplateId,
        patch.activeTemplateVersion ?? existing.activeTemplateVersion,
        patch.activeSchemaVersion ?? existing.activeSchemaVersion,
        patch.deploymentVersion ?? existing.deploymentVersion,
        patch.deploymentConfigHash ?? existing.deploymentConfigHash,
        patch.installedAt ?? existing.installedAt,
        now,
        guildId,
      );

    return this.getGuildState(guildId)!;
  }

  beginDeployment(params: {
    deploymentId: string;
    guildId: string;
    templateId: string;
    templateVersion: string;
    schemaVersion: string;
    configHash: string;
    actorUserId: string;
    startedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO deployments
          (deploymentId, guildId, templateId, templateVersion, schemaVersion, configHash,
           status, actorUserId, startedAt)
         VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?)`,
      )
      .run(
        params.deploymentId,
        params.guildId,
        params.templateId,
        params.templateVersion,
        params.schemaVersion,
        params.configHash,
        params.actorUserId,
        params.startedAt,
      );
  }

  finishDeployment(params: {
    deploymentId: string;
    status: Exclude<DeploymentStatus, "started">;
    finishedAt: string;
    errorCode?: string;
    errorJson?: string;
  }): void {
    this.db
      .prepare(
        `UPDATE deployments
           SET status=?,
               errorCode=?,
               errorJson=?,
               finishedAt=?
         WHERE deploymentId=?`,
      )
      .run(
        params.status,
        params.errorCode ?? null,
        params.errorJson ?? null,
        params.finishedAt,
        params.deploymentId,
      );
  }
}

