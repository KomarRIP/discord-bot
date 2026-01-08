import type { SqliteDb } from "../sqliteDb.js";

export type SetupSessionStatus =
  | "active"
  | "confirmed"
  | "deploying"
  | "completed"
  | "cancelled"
  | "failed";

export type SetupSession = {
  sessionId: string;
  guildId: string;
  status: SetupSessionStatus;
  stepKey: string;
  answersJson: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export class SetupSessionRepository {
  constructor(private readonly db: SqliteDb) {}

  getActiveSession(guildId: string): SetupSession | null {
    const row = this.db
      .prepare(
        `SELECT sessionId, guildId, status, stepKey, answersJson, expiresAt, createdAt, updatedAt
         FROM setup_sessions
         WHERE guildId = ?
           AND status IN ('active','confirmed','deploying')
         ORDER BY updatedAt DESC
         LIMIT 1`,
      )
      .get(guildId) as SetupSession | undefined;
    return row ?? null;
  }

  createSession(session: Omit<SetupSession, "createdAt" | "updatedAt">): SetupSession {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO setup_sessions
          (sessionId, guildId, status, stepKey, answersJson, expiresAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.sessionId,
        session.guildId,
        session.status,
        session.stepKey,
        session.answersJson,
        session.expiresAt,
        now,
        now,
      );
    return this.getById(session.sessionId)!;
  }

  updateSession(sessionId: string, patch: Partial<Pick<SetupSession, "status" | "stepKey" | "answersJson" | "expiresAt">>): SetupSession {
    const now = new Date().toISOString();
    const existing = this.getById(sessionId);
    if (!existing) throw new Error(`SetupSession not found: ${sessionId}`);

    this.db
      .prepare(
        `UPDATE setup_sessions
           SET status = ?,
               stepKey = ?,
               answersJson = ?,
               expiresAt = ?,
               updatedAt = ?
         WHERE sessionId = ?`,
      )
      .run(
        patch.status ?? existing.status,
        patch.stepKey ?? existing.stepKey,
        patch.answersJson ?? existing.answersJson,
        patch.expiresAt ?? existing.expiresAt,
        now,
        sessionId,
      );
    return this.getById(sessionId)!;
  }

  expireSessions(nowIso: string): number {
    const info = this.db
      .prepare(
        `UPDATE setup_sessions
           SET status='cancelled', updatedAt=?
         WHERE status IN ('active','confirmed')
           AND expiresAt <= ?`,
      )
      .run(nowIso, nowIso);
    return Number(info.changes);
  }

  private getById(sessionId: string): SetupSession | null {
    const row = this.db
      .prepare(
        `SELECT sessionId, guildId, status, stepKey, answersJson, expiresAt, createdAt, updatedAt
         FROM setup_sessions WHERE sessionId = ?`,
      )
      .get(sessionId) as SetupSession | undefined;
    return row ?? null;
  }
}

