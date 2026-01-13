import { ulid } from "ulid";
import type { CommandContextDto } from "../dto/commandContextDto.js";
import type { ResultDto } from "../dto/resultDto.js";
import { AppError } from "../../shared/errors/appError.js";
import type { Storage } from "../../infra/storage/sqlite/sqliteStorage.js";
import type { DiscordGateway } from "../../infra/discord/discordGateway.js";
import type { TemplateRegistry } from "../../infra/templates/templateRegistry.js";
import type { AuditLogService } from "../../infra/audit/auditLogService.js";
import type { TemplateConfig } from "../../domain/template/templateConfig.js";
import type { RoleType } from "../../domain/template/types.js";

export type MemberProfileDto = {
  guildId: string;
  userId: string;
  rankRoleKey: string | null;
  positionRoleKeys: string[];
  clearanceRoleKeys: string[];
  createdAt: string;
  updatedAt: string;
};

export class MemberRoleManagementService {
  constructor(
    private readonly storage: Storage,
    private readonly discord: DiscordGateway,
    private readonly templates: TemplateRegistry,
    private readonly auditLog?: AuditLogService,
  ) {}

  async setRank(ctx: CommandContextDto, targetUserId: string, rankRoleKey: string | null): Promise<ResultDto<{ profile: MemberProfileDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    // Валидация: если rankRoleKey указан, он должен существовать в шаблоне и быть типа "rank"
    if (rankRoleKey !== null) {
      const validation = await this.validateRoleKey(ctx.guildId, rankRoleKey, "rank");
      if (!validation.valid) {
        return validation.error;
      }
    }

    // Получаем текущий профиль
    const currentProfile = this.storage.members.getMemberProfile(ctx.guildId, targetUserId);
    const oldRankRoleKey = currentProfile?.rankRoleKey ?? null;

    // Если звание не изменилось, возвращаем текущий профиль
    if (oldRankRoleKey === rankRoleKey) {
      return {
        type: "success",
        title: "Звание установлено",
        message: "Звание уже было установлено.",
        data: { profile: this.toDto(currentProfile ?? this.storage.members.getMemberProfile(ctx.guildId, targetUserId)!) },
      };
    }

    // Удаляем старое звание из Discord (если было)
    if (oldRankRoleKey) {
      const oldMapping = this.storage.mappings.getMapping(ctx.guildId, "role", oldRankRoleKey);
      if (oldMapping) {
        try {
          await this.discord.removeRoleFromMember(
            ctx.guildId,
            targetUserId,
            oldMapping.discordId,
            `Изменение звания на ${rankRoleKey ?? "отсутствует"}`,
          );
        } catch (e) {
          // Игнорируем ошибки удаления (роль может уже отсутствовать)
          const error = e instanceof Error ? e.message : String(e);
          console.warn(`Failed to remove old rank role: ${error}`);
        }
      }
    }

    // Добавляем новое звание в Discord (если указано)
    if (rankRoleKey !== null) {
      const newMapping = this.storage.mappings.getMapping(ctx.guildId, "role", rankRoleKey);
      if (!newMapping) {
        return {
          type: "error",
          errorCode: "NOT_FOUND",
          userMessage: `Роль "${rankRoleKey}" не найдена в Discord. Возможно, деплой ещё не выполнен.`,
          retryable: false,
        };
      }

      try {
        await this.discord.addRoleToMember(
          ctx.guildId,
          targetUserId,
          newMapping.discordId,
          `Установка звания: ${rankRoleKey}`,
        );
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return {
          type: "error",
          errorCode: "TRANSIENT_FAILURE",
          userMessage: `Не удалось выдать роль в Discord: ${error}`,
          retryable: true,
        };
      }
    }

    // Обновляем в БД
    const updatedProfile = this.storage.members.updateMemberRank(ctx.guildId, targetUserId, rankRoleKey);

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "MemberRankSet",
      payloadJson: JSON.stringify({
        targetUserId,
        roleKey: rankRoleKey,
        oldRoleKey: oldRankRoleKey,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "MemberRankSet",
        payload: {
          targetUserId,
          roleKey: rankRoleKey ?? undefined,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    return {
      type: "success",
      title: "Звание установлено",
      message: rankRoleKey ? `Звание "${rankRoleKey}" установлено участнику.` : "Звание снято с участника.",
      data: { profile: this.toDto(updatedProfile) },
    };
  }

  async addPosition(ctx: CommandContextDto, targetUserId: string, positionRoleKey: string): Promise<ResultDto<{ profile: MemberProfileDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    // Валидация: роль должна существовать в шаблоне и быть типа "position"
    const validation = await this.validateRoleKey(ctx.guildId, positionRoleKey, "position");
    if (!validation.valid) {
      return validation.error;
    }

    // Проверка инварианта: максимум 2 positions
    const currentProfile = this.storage.members.getMemberProfile(ctx.guildId, targetUserId);
    const currentPositions: string[] = currentProfile
      ? JSON.parse(currentProfile.positionRoleKeysJson)
      : [];

    if (currentPositions.includes(positionRoleKey)) {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: "У участника уже есть эта должность.",
        retryable: false,
      };
    }

    if (currentPositions.length >= 2) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "У участника уже максимальное количество должностей (2).",
        retryable: false,
      };
    }

    // Получаем Discord roleId
    const mapping = this.storage.mappings.getMapping(ctx.guildId, "role", positionRoleKey);
    if (!mapping) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: `Роль "${positionRoleKey}" не найдена в Discord. Возможно, деплой ещё не выполнен.`,
        retryable: false,
      };
    }

    // Добавляем роль в Discord
    try {
      await this.discord.addRoleToMember(ctx.guildId, targetUserId, mapping.discordId, `Добавление должности: ${positionRoleKey}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        type: "error",
        errorCode: "TRANSIENT_FAILURE",
        userMessage: `Не удалось выдать роль в Discord: ${error}`,
        retryable: true,
      };
    }

    // Обновляем в БД
    const updatedProfile = this.storage.members.addMemberPosition(ctx.guildId, targetUserId, positionRoleKey);

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "MemberPositionAdded",
      payloadJson: JSON.stringify({
        targetUserId,
        roleKey: positionRoleKey,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "MemberPositionAdded",
        payload: {
          targetUserId,
          roleKey: positionRoleKey,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    return {
      type: "success",
      title: "Должность добавлена",
      message: `Должность "${positionRoleKey}" добавлена участнику.`,
      data: { profile: this.toDto(updatedProfile) },
    };
  }

  async removePosition(ctx: CommandContextDto, targetUserId: string, positionRoleKey: string): Promise<ResultDto<{ profile: MemberProfileDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    // Проверка: должность должна быть у участника
    const currentProfile = this.storage.members.getMemberProfile(ctx.guildId, targetUserId);
    const currentPositions: string[] = currentProfile
      ? JSON.parse(currentProfile.positionRoleKeysJson)
      : [];

    if (!currentPositions.includes(positionRoleKey)) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "У участника нет этой должности.",
        retryable: false,
      };
    }

    // Получаем Discord roleId
    const mapping = this.storage.mappings.getMapping(ctx.guildId, "role", positionRoleKey);
    if (!mapping) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: `Роль "${positionRoleKey}" не найдена в Discord.`,
        retryable: false,
      };
    }

    // Удаляем роль из Discord
    try {
      await this.discord.removeRoleFromMember(ctx.guildId, targetUserId, mapping.discordId, `Снятие должности: ${positionRoleKey}`);
    } catch (e) {
      // Игнорируем ошибки удаления (роль может уже отсутствовать)
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`Failed to remove position role: ${error}`);
    }

    // Обновляем в БД
    const updatedProfile = this.storage.members.removeMemberPosition(ctx.guildId, targetUserId, positionRoleKey);

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "MemberPositionRemoved",
      payloadJson: JSON.stringify({
        targetUserId,
        roleKey: positionRoleKey,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "MemberPositionRemoved",
        payload: {
          targetUserId,
          roleKey: positionRoleKey,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    return {
      type: "success",
      title: "Должность снята",
      message: `Должность "${positionRoleKey}" снята с участника.`,
      data: { profile: this.toDto(updatedProfile) },
    };
  }

  async grantClearance(ctx: CommandContextDto, targetUserId: string, clearanceRoleKey: string): Promise<ResultDto<{ profile: MemberProfileDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    // Валидация: роль должна существовать в шаблоне и быть типа "clearance"
    const validation = await this.validateRoleKey(ctx.guildId, clearanceRoleKey, "clearance");
    if (!validation.valid) {
      return validation.error;
    }

    // Проверка: допуск уже есть у участника
    const currentProfile = this.storage.members.getMemberProfile(ctx.guildId, targetUserId);
    const currentClearances: string[] = currentProfile
      ? JSON.parse(currentProfile.clearanceRoleKeysJson)
      : [];

    if (currentClearances.includes(clearanceRoleKey)) {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: "У участника уже есть этот допуск.",
        retryable: false,
      };
    }

    // Получаем Discord roleId
    const mapping = this.storage.mappings.getMapping(ctx.guildId, "role", clearanceRoleKey);
    if (!mapping) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: `Роль "${clearanceRoleKey}" не найдена в Discord. Возможно, деплой ещё не выполнен.`,
        retryable: false,
      };
    }

    // Добавляем роль в Discord
    try {
      await this.discord.addRoleToMember(ctx.guildId, targetUserId, mapping.discordId, `Выдача допуска: ${clearanceRoleKey}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        type: "error",
        errorCode: "TRANSIENT_FAILURE",
        userMessage: `Не удалось выдать роль в Discord: ${error}`,
        retryable: true,
      };
    }

    // Обновляем в БД
    const updatedProfile = this.storage.members.addMemberClearance(ctx.guildId, targetUserId, clearanceRoleKey);

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "MemberClearanceGranted",
      payloadJson: JSON.stringify({
        targetUserId,
        roleKey: clearanceRoleKey,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "MemberClearanceGranted",
        payload: {
          targetUserId,
          roleKey: clearanceRoleKey,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    return {
      type: "success",
      title: "Допуск выдан",
      message: `Допуск "${clearanceRoleKey}" выдан участнику.`,
      data: { profile: this.toDto(updatedProfile) },
    };
  }

  async revokeClearance(ctx: CommandContextDto, targetUserId: string, clearanceRoleKey: string): Promise<ResultDto<{ profile: MemberProfileDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    // Проверка: допуск должен быть у участника
    const currentProfile = this.storage.members.getMemberProfile(ctx.guildId, targetUserId);
    const currentClearances: string[] = currentProfile
      ? JSON.parse(currentProfile.clearanceRoleKeysJson)
      : [];

    if (!currentClearances.includes(clearanceRoleKey)) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "У участника нет этого допуска.",
        retryable: false,
      };
    }

    // Получаем Discord roleId
    const mapping = this.storage.mappings.getMapping(ctx.guildId, "role", clearanceRoleKey);
    if (!mapping) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: `Роль "${clearanceRoleKey}" не найдена в Discord.`,
        retryable: false,
      };
    }

    // Удаляем роль из Discord
    try {
      await this.discord.removeRoleFromMember(ctx.guildId, targetUserId, mapping.discordId, `Отзыв допуска: ${clearanceRoleKey}`);
    } catch (e) {
      // Игнорируем ошибки удаления (роль может уже отсутствовать)
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`Failed to remove clearance role: ${error}`);
    }

    // Обновляем в БД
    const updatedProfile = this.storage.members.removeMemberClearance(ctx.guildId, targetUserId, clearanceRoleKey);

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "MemberClearanceRevoked",
      payloadJson: JSON.stringify({
        targetUserId,
        roleKey: clearanceRoleKey,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "MemberClearanceRevoked",
        payload: {
          targetUserId,
          roleKey: clearanceRoleKey,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    return {
      type: "success",
      title: "Допуск отозван",
      message: `Допуск "${clearanceRoleKey}" отозван у участника.`,
      data: { profile: this.toDto(updatedProfile) },
    };
  }

  async getMemberProfile(ctx: CommandContextDto, userId: string): Promise<ResultDto<{ profile: MemberProfileDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    const profile = this.storage.members.getMemberProfile(ctx.guildId, userId);
    if (!profile) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "Профиль участника не найден.",
        retryable: false,
      };
    }

    return {
      type: "success",
      title: "Профиль участника",
      message: "Профиль успешно получен.",
      data: { profile: this.toDto(profile) },
    };
  }

  /**
   * Валидирует, что роль существует в активном шаблоне гильдии и имеет правильный тип
   */
  private async validateRoleKey(
    guildId: string,
    roleKey: string,
    expectedType: RoleType,
  ): Promise<{ valid: true } | { valid: false; error: ResultDto<never> }> {
    // Получаем активный шаблон гильдии
    const guildState = this.storage.guilds.getGuildState(guildId);
    if (!guildState || !guildState.activeTemplateId) {
      return {
        valid: false,
        error: {
          type: "error",
          errorCode: "NOT_FOUND",
          userMessage: "Активный шаблон не найден. Возможно, деплой ещё не выполнен.",
          retryable: false,
        },
      };
    }

    // Получаем шаблон из реестра
    let template: TemplateConfig;
    try {
      template = await this.templates.getTemplate(guildState.activeTemplateId);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return {
        valid: false,
        error: {
          type: "error",
          errorCode: "TRANSIENT_FAILURE",
          userMessage: `Не удалось загрузить шаблон: ${error}`,
          retryable: false,
        },
      };
    }

    // Ищем роль в шаблоне
    const role = template.roles.find((r) => r.key === roleKey);
    if (!role) {
      return {
        valid: false,
        error: {
          type: "error",
          errorCode: "VALIDATION_FAILED",
          userMessage: `Роль "${roleKey}" не найдена в шаблоне.`,
          retryable: false,
        },
      };
    }

    // Проверяем тип роли
    if (role.type !== expectedType) {
      return {
        valid: false,
        error: {
          type: "error",
          errorCode: "VALIDATION_FAILED",
          userMessage: `Роль "${roleKey}" имеет тип "${role.type}", а ожидался "${expectedType}".`,
          retryable: false,
        },
      };
    }

    return { valid: true };
  }

  private toDto(profile: import("../../infra/storage/sqlite/repositories/memberRepository.js").MemberProfile): MemberProfileDto {
    return {
      guildId: profile.guildId,
      userId: profile.userId,
      rankRoleKey: profile.rankRoleKey,
      positionRoleKeys: JSON.parse(profile.positionRoleKeysJson),
      clearanceRoleKeys: JSON.parse(profile.clearanceRoleKeysJson),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  }
}

