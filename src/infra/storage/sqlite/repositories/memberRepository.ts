import type { SqliteDb } from "../sqliteDb.js";

export type MemberProfile = {
  guildId: string;
  userId: string;
  rankRoleKey: string | null;
  positionRoleKeysJson: string; // JSON.stringify(string[])
  clearanceRoleKeysJson: string; // JSON.stringify(string[])
  createdAt: string;
  updatedAt: string;
};

export type UpsertMemberParams = {
  guildId: string;
  userId: string;
  rankRoleKey?: string | null;
  positionRoleKeysJson?: string; // JSON массив
  clearanceRoleKeysJson?: string; // JSON массив
};

export class MemberRepository {
  constructor(private readonly db: SqliteDb) {}

  getMemberProfile(guildId: string, userId: string): MemberProfile | null {
    const row = this.db
      .prepare(
        `SELECT guildId, userId, rankRoleKey, positionRoleKeysJson, 
                clearanceRoleKeysJson, createdAt, updatedAt
         FROM members
         WHERE guildId = ? AND userId = ?`,
      )
      .get(guildId, userId) as MemberProfile | undefined;
    return row ?? null;
  }

  /**
   * Получить или создать профиль участника с пустыми массивами, если записи нет
   */
  private ensureMemberExists(guildId: string, userId: string): MemberProfile {
    const existing = this.getMemberProfile(guildId, userId);
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const emptyArrayJson = JSON.stringify([]);

    this.db
      .prepare(
        `INSERT INTO members
          (guildId, userId, rankRoleKey, positionRoleKeysJson, clearanceRoleKeysJson, createdAt, updatedAt)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(guildId, userId, emptyArrayJson, emptyArrayJson, now, now);

    return this.getMemberProfile(guildId, userId)!;
  }

  upsertMember(params: UpsertMemberParams): MemberProfile {
    const now = new Date().toISOString();
    const existing = this.ensureMemberExists(params.guildId, params.userId);

    const rankRoleKey = params.rankRoleKey !== undefined ? params.rankRoleKey : existing.rankRoleKey;
    const positionRoleKeysJson =
      params.positionRoleKeysJson !== undefined ? params.positionRoleKeysJson : existing.positionRoleKeysJson;
    const clearanceRoleKeysJson =
      params.clearanceRoleKeysJson !== undefined ? params.clearanceRoleKeysJson : existing.clearanceRoleKeysJson;

    this.db
      .prepare(
        `UPDATE members
           SET rankRoleKey = ?,
               positionRoleKeysJson = ?,
               clearanceRoleKeysJson = ?,
               updatedAt = ?
         WHERE guildId = ? AND userId = ?`,
      )
      .run(rankRoleKey, positionRoleKeysJson, clearanceRoleKeysJson, now, params.guildId, params.userId);

    return this.getMemberProfile(params.guildId, params.userId)!;
  }

  updateMemberRank(guildId: string, userId: string, rankRoleKey: string | null): MemberProfile {
    return this.upsertMember({ guildId, userId, rankRoleKey });
  }

  addMemberPosition(guildId: string, userId: string, positionRoleKey: string): MemberProfile {
    const existing = this.ensureMemberExists(guildId, userId);
    const positions: string[] = JSON.parse(existing.positionRoleKeysJson);

    // Проверка на дубликат
    if (positions.includes(positionRoleKey)) {
      return existing;
    }

    positions.push(positionRoleKey);
    const updatedJson = JSON.stringify(positions);

    return this.upsertMember({
      guildId,
      userId,
      positionRoleKeysJson: updatedJson,
    });
  }

  removeMemberPosition(guildId: string, userId: string, positionRoleKey: string): MemberProfile {
    const existing = this.ensureMemberExists(guildId, userId);
    const positions: string[] = JSON.parse(existing.positionRoleKeysJson);

    // Удаляем элемент, если он есть
    const filtered = positions.filter((key) => key !== positionRoleKey);

    // Если ничего не изменилось, возвращаем существующий профиль
    if (filtered.length === positions.length) {
      return existing;
    }

    const updatedJson = JSON.stringify(filtered);

    return this.upsertMember({
      guildId,
      userId,
      positionRoleKeysJson: updatedJson,
    });
  }

  addMemberClearance(guildId: string, userId: string, clearanceRoleKey: string): MemberProfile {
    const existing = this.ensureMemberExists(guildId, userId);
    const clearances: string[] = JSON.parse(existing.clearanceRoleKeysJson);

    // Проверка на дубликат
    if (clearances.includes(clearanceRoleKey)) {
      return existing;
    }

    clearances.push(clearanceRoleKey);
    const updatedJson = JSON.stringify(clearances);

    return this.upsertMember({
      guildId,
      userId,
      clearanceRoleKeysJson: updatedJson,
    });
  }

  removeMemberClearance(guildId: string, userId: string, clearanceRoleKey: string): MemberProfile {
    const existing = this.ensureMemberExists(guildId, userId);
    const clearances: string[] = JSON.parse(existing.clearanceRoleKeysJson);

    // Удаляем элемент, если он есть
    const filtered = clearances.filter((key) => key !== clearanceRoleKey);

    // Если ничего не изменилось, возвращаем существующий профиль
    if (filtered.length === clearances.length) {
      return existing;
    }

    const updatedJson = JSON.stringify(filtered);

    return this.upsertMember({
      guildId,
      userId,
      clearanceRoleKeysJson: updatedJson,
    });
  }
}


