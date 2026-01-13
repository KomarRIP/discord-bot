import type { SqliteDb } from "../sqliteDb.js";

export type ApplicationType = "join";
export type ApplicationStatus = "draft" | "submitted" | "under_review" | "approved" | "rejected" | "cancelled";

export type Application = {
  applicationId: string;
  guildId: string;
  type: ApplicationType;
  status: ApplicationStatus;
  applicantUserId: string;
  payloadJson: string;
  decisionByUserId: string | null;
  decisionReason: string | null;
  decisionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateApplicationInput = {
  applicationId: string;
  guildId: string;
  type: ApplicationType;
  status: ApplicationStatus;
  applicantUserId: string;
  payloadJson: string;
};

export type UpdateApplicationStatusInput = {
  applicationId: string;
  status: ApplicationStatus;
  decisionByUserId?: string | null;
  decisionReason?: string | null;
  decisionAt?: string | null;
};

export class ApplicationRepository {
  constructor(private readonly db: SqliteDb) {}

  getById(applicationId: string): Application | null {
    const row = this.db
      .prepare(
        `SELECT applicationId, guildId, type, status, applicantUserId, payloadJson,
                decisionByUserId, decisionReason, decisionAt, createdAt, updatedAt
         FROM applications
         WHERE applicationId = ?`,
      )
      .get(applicationId) as Application | undefined;
    return row ?? null;
  }

  getActiveApplicationByApplicant(guildId: string, applicantUserId: string, type: ApplicationType): Application | null {
    const row = this.db
      .prepare(
        `SELECT applicationId, guildId, type, status, applicantUserId, payloadJson,
                decisionByUserId, decisionReason, decisionAt, createdAt, updatedAt
         FROM applications
         WHERE guildId = ?
           AND applicantUserId = ?
           AND type = ?
           AND status IN ('draft', 'submitted', 'under_review')
         ORDER BY createdAt DESC
         LIMIT 1`,
      )
      .get(guildId, applicantUserId, type) as Application | undefined;
    return row ?? null;
  }

  listByGuild(guildId: string, filters?: { status?: ApplicationStatus; type?: ApplicationType }): Application[] {
    let query = `SELECT applicationId, guildId, type, status, applicantUserId, payloadJson,
                        decisionByUserId, decisionReason, decisionAt, createdAt, updatedAt
                 FROM applications
                 WHERE guildId = ?`;
    const params: unknown[] = [guildId];

    if (filters?.status) {
      query += ` AND status = ?`;
      params.push(filters.status);
    }

    if (filters?.type) {
      query += ` AND type = ?`;
      params.push(filters.type);
    }

    query += ` ORDER BY createdAt DESC`;

    const rows = this.db.prepare(query).all(...params) as Application[];
    return rows;
  }

  create(application: CreateApplicationInput): Application {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO applications
          (applicationId, guildId, type, status, applicantUserId, payloadJson,
           decisionByUserId, decisionReason, decisionAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        application.applicationId,
        application.guildId,
        application.type,
        application.status,
        application.applicantUserId,
        application.payloadJson,
        now,
        now,
      );
    return this.getById(application.applicationId)!;
  }

  updateStatus(input: UpdateApplicationStatusInput): Application {
    const now = new Date().toISOString();
    const existing = this.getById(input.applicationId);
    if (!existing) {
      throw new Error(`Application not found: ${input.applicationId}`);
    }

    this.db
      .prepare(
        `UPDATE applications
           SET status = ?,
               decisionByUserId = ?,
               decisionReason = ?,
               decisionAt = ?,
               updatedAt = ?
         WHERE applicationId = ?`,
      )
      .run(
        input.status,
        input.decisionByUserId ?? existing.decisionByUserId,
        input.decisionReason ?? existing.decisionReason,
        input.decisionAt ?? existing.decisionAt ?? (input.status === "approved" || input.status === "rejected" ? now : null),
        now,
        input.applicationId,
      );
    return this.getById(input.applicationId)!;
  }
}


