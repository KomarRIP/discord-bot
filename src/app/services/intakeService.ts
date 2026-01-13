import { ulid } from "ulid";
import type { CommandContextDto } from "../dto/commandContextDto.js";
import type { ResultDto } from "../dto/resultDto.js";
import { AppError } from "../../shared/errors/appError.js";
import type { Storage } from "../../infra/storage/sqlite/sqliteStorage.js";
import type { Application, ApplicationStatus, ApplicationType } from "../../infra/storage/sqlite/repositories/applicationRepository.js";
import type { DiscordGateway } from "../../infra/discord/discordGateway.js";
import { buildApplicationQueueMessage } from "../../interface/discord/render/intakeRenderer.js";
import type { AuditLogService } from "../../infra/audit/auditLogService.js";

export type JoinApplicationPayload = {
  nickname: string;
  age: number;
  timezone: string;
  availability: string;
  armaExperience: string;
  milsimExperience: string;
  micAndMods: string;
  whyUnit: string;
};

export type ApplicationDto = {
  applicationId: string;
  guildId: string;
  type: ApplicationType;
  status: ApplicationStatus;
  applicantUserId: string;
  payload: JoinApplicationPayload;
  decisionByUserId: string | null;
  decisionReason: string | null;
  decisionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export class IntakeService {
  constructor(
    private readonly storage: Storage,
    private readonly discord: DiscordGateway,
    private readonly auditLog?: AuditLogService,
  ) {}

  async createApplication(ctx: CommandContextDto, payload: JoinApplicationPayload): Promise<ResultDto<{ application: ApplicationDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере (не в DM).",
        retryable: false,
      };
    }

    // Валидация полей
    const validation = this.validateJoinPayload(payload);
    if (!validation.valid) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: validation.error ?? "Ошибка валидации данных",
        retryable: false,
      };
    }

    // Проверка: может ли пользователь подать заявку (должен иметь BASE_GUEST)
    const hasGuestRole = await this.checkUserHasRole(ctx.guildId, ctx.actorUserId, "BASE_GUEST");
    if (!hasGuestRole) {
      return {
        type: "error",
        errorCode: "FORBIDDEN",
        userMessage: "Для подачи заявки требуется роль 'Гость'. Обратитесь к администратору.",
        retryable: false,
      };
    }

    // Проверка: нет ли активной заявки
    const active = this.storage.applications.getActiveApplicationByApplicant(ctx.guildId, ctx.actorUserId, "join");
    if (active) {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: `У вас уже есть активная заявка: ${active.applicationId} (статус: ${active.status}). Дождитесь рассмотрения или отмените её.`,
        retryable: false,
      };
    }

    // Создание заявки в статусе draft
    const applicationId = ulid();
    const application = this.storage.applications.create({
      applicationId,
      guildId: ctx.guildId,
      type: "join",
      status: "draft",
      applicantUserId: ctx.actorUserId,
      payloadJson: JSON.stringify(payload),
    });

    // Audit log
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "ApplicationCreated",
      payloadJson: JSON.stringify({
        applicationId: application.applicationId,
        type: application.type,
        applicantUserId: application.applicantUserId,
      }),
      createdAt: new Date().toISOString(),
    });

    return {
      type: "success",
      title: "Заявка создана",
      message: "Заявка создана в черновике. Используйте команду для подачи на рассмотрение.",
      data: { application: this.toDto(application) },
    };
  }

  async submitApplication(ctx: CommandContextDto, applicationId: string): Promise<ResultDto<{ application: ApplicationDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    const application = this.storage.applications.getById(applicationId);
    if (!application || application.guildId !== ctx.guildId) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "Заявка не найдена.",
        retryable: false,
      };
    }

    if (application.applicantUserId !== ctx.actorUserId) {
      return {
        type: "error",
        errorCode: "FORBIDDEN",
        userMessage: "Вы можете подавать только свои заявки.",
        retryable: false,
      };
    }

    if (application.status !== "draft") {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: `Заявка уже находится в статусе: ${application.status}`,
        retryable: false,
      };
    }

    // Переход: draft -> submitted
    const updated = this.storage.applications.updateStatus({
      applicationId,
      status: "submitted",
    });

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "ApplicationSubmitted",
      payloadJson: JSON.stringify({
        applicationId: updated.applicationId,
        type: updated.type,
        applicantUserId: updated.applicantUserId,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "ApplicationSubmitted",
        payload: {
          applicationId: updated.applicationId,
          type: updated.type,
          applicantUserId: updated.applicantUserId,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    // Публикация заявки в CH_INTAKE_QUEUE
    try {
      await this.publishApplicationToQueue(ctx.guildId, this.toDto(updated));
    } catch (e) {
      // Логируем ошибку, но не прерываем процесс (заявка уже подана)
      const error = e instanceof Error ? e.message : String(e);
      this.storage.audit.insert({
        eventId: ulid(),
        guildId: ctx.guildId,
        deploymentId: null,
        actorUserId: ctx.actorUserId,
        type: "ApplicationQueuePublishFailed",
        payloadJson: JSON.stringify({
          applicationId: updated.applicationId,
          error,
        }),
        createdAt: new Date().toISOString(),
      });
    }

    return {
      type: "success",
      title: "Заявка подана",
      message: "Заявка отправлена на рассмотрение. Персонал рассмотрит её в ближайшее время.",
      data: { application: this.toDto(updated) },
    };
  }

  async listApplications(
    ctx: CommandContextDto,
    filters?: { status?: ApplicationStatus; type?: ApplicationType },
  ): Promise<ResultDto<{ applications: ApplicationDto[] }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    const applications = this.storage.applications.listByGuild(ctx.guildId, filters);
    return {
      type: "success",
      title: "Список заявок",
      message: `Найдено заявок: ${applications.length}`,
      data: { applications: applications.map((a) => this.toDto(a)) },
    };
  }

  async approveApplication(
    ctx: CommandContextDto,
    applicationId: string,
    reason?: string,
  ): Promise<ResultDto<{ application: ApplicationDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    const application = this.storage.applications.getById(applicationId);
    if (!application || application.guildId !== ctx.guildId) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "Заявка не найдена.",
        retryable: false,
      };
    }

    if (application.status !== "submitted" && application.status !== "under_review") {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: `Нельзя одобрить заявку в статусе: ${application.status}`,
        retryable: false,
      };
    }

    // Переход в approved
    const updated = this.storage.applications.updateStatus({
      applicationId,
      status: "approved",
      decisionByUserId: ctx.actorUserId,
      decisionReason: reason ?? null,
      decisionAt: new Date().toISOString(),
    });

    // Продвижение пользователя: выдать BASE_MEMBER, убрать BASE_GUEST
    try {
      await this.promoteToMember(ctx.guildId, application.applicantUserId);
    } catch (e) {
      // Если не удалось выдать роль, логируем ошибку, но заявка уже одобрена
      const error = e instanceof Error ? e.message : String(e);
      this.storage.audit.insert({
        eventId: ulid(),
        guildId: ctx.guildId,
        deploymentId: null,
        actorUserId: ctx.actorUserId,
        type: "ApplicationApprovedButRoleFailed",
        payloadJson: JSON.stringify({
          applicationId: updated.applicationId,
          applicantUserId: updated.applicantUserId,
          error,
        }),
        createdAt: new Date().toISOString(),
      });
    }

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "ApplicationApproved",
      payloadJson: JSON.stringify({
        applicationId: updated.applicationId,
        type: updated.type,
        applicantUserId: updated.applicantUserId,
        decisionReason: updated.decisionReason,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "ApplicationApproved",
        payload: {
          applicationId: updated.applicationId,
          type: updated.type,
          applicantUserId: updated.applicantUserId,
          decisionReason: updated.decisionReason ?? undefined,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    // Обновление сообщения в CH_INTAKE_QUEUE
    try {
      await this.updateApplicationInQueue(ctx.guildId, this.toDto(updated));
    } catch (e) {
      // Логируем ошибку, но не прерываем процесс
      const error = e instanceof Error ? e.message : String(e);
      this.storage.audit.insert({
        eventId: ulid(),
        guildId: ctx.guildId,
        deploymentId: null,
        actorUserId: ctx.actorUserId,
        type: "ApplicationQueueUpdateFailed",
        payloadJson: JSON.stringify({
          applicationId: updated.applicationId,
          error,
        }),
        createdAt: new Date().toISOString(),
      });
    }

    return {
      type: "success",
      title: "Заявка одобрена",
      message: `Заявка одобрена. Пользователю назначена роль 'Боец'.`,
      data: { application: this.toDto(updated) },
    };
  }

  async rejectApplication(
    ctx: CommandContextDto,
    applicationId: string,
    reason: string,
  ): Promise<ResultDto<{ application: ApplicationDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    if (!reason || reason.trim().length < 3) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Причина отклонения обязательна и должна быть не менее 3 символов.",
        retryable: false,
      };
    }

    const application = this.storage.applications.getById(applicationId);
    if (!application || application.guildId !== ctx.guildId) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "Заявка не найдена.",
        retryable: false,
      };
    }

    if (application.status !== "submitted" && application.status !== "under_review") {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: `Нельзя отклонить заявку в статусе: ${application.status}`,
        retryable: false,
      };
    }

    // Переход в rejected
    const updated = this.storage.applications.updateStatus({
      applicationId,
      status: "rejected",
      decisionByUserId: ctx.actorUserId,
      decisionReason: reason.trim(),
      decisionAt: new Date().toISOString(),
    });

    // Audit log в БД
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "ApplicationRejected",
      payloadJson: JSON.stringify({
        applicationId: updated.applicationId,
        type: updated.type,
        applicantUserId: updated.applicantUserId,
        decisionReason: updated.decisionReason,
      }),
      createdAt: new Date().toISOString(),
    });

    // Публикация в Discord канал CH_AUDIT
    if (this.auditLog) {
      await this.auditLog.publishEvent({
        guildId: ctx.guildId,
        eventType: "ApplicationRejected",
        payload: {
          applicationId: updated.applicationId,
          type: updated.type,
          applicantUserId: updated.applicantUserId,
          decisionReason: updated.decisionReason ?? undefined,
        },
        actorUserId: ctx.actorUserId,
      });
    }

    // Обновление сообщения в CH_INTAKE_QUEUE
    try {
      await this.updateApplicationInQueue(ctx.guildId, this.toDto(updated));
    } catch (e) {
      // Логируем ошибку, но не прерываем процесс
      const error = e instanceof Error ? e.message : String(e);
      this.storage.audit.insert({
        eventId: ulid(),
        guildId: ctx.guildId,
        deploymentId: null,
        actorUserId: ctx.actorUserId,
        type: "ApplicationQueueUpdateFailed",
        payloadJson: JSON.stringify({
          applicationId: updated.applicationId,
          error,
        }),
        createdAt: new Date().toISOString(),
      });
    }

    return {
      type: "success",
      title: "Заявка отклонена",
      message: `Заявка отклонена. Причина: ${reason.trim()}`,
      data: { application: this.toDto(updated) },
    };
  }

  async cancelApplication(ctx: CommandContextDto, applicationId: string): Promise<ResultDto<{ application: ApplicationDto }>> {
    if (!ctx.guildId) {
      return {
        type: "error",
        errorCode: "VALIDATION_FAILED",
        userMessage: "Команда доступна только на сервере.",
        retryable: false,
      };
    }

    const application = this.storage.applications.getById(applicationId);
    if (!application || application.guildId !== ctx.guildId) {
      return {
        type: "error",
        errorCode: "NOT_FOUND",
        userMessage: "Заявка не найдена.",
        retryable: false,
      };
    }

    if (application.applicantUserId !== ctx.actorUserId) {
      return {
        type: "error",
        errorCode: "FORBIDDEN",
        userMessage: "Вы можете отменять только свои заявки.",
        retryable: false,
      };
    }

    if (application.status === "approved" || application.status === "rejected" || application.status === "cancelled") {
      return {
        type: "error",
        errorCode: "CONFLICT",
        userMessage: `Нельзя отменить заявку в статусе: ${application.status}`,
        retryable: false,
      };
    }

    // Переход в cancelled
    const updated = this.storage.applications.updateStatus({
      applicationId,
      status: "cancelled",
    });

    // Audit log
    this.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId: null,
      actorUserId: ctx.actorUserId,
      type: "ApplicationCancelled",
      payloadJson: JSON.stringify({
        applicationId: updated.applicationId,
        type: updated.type,
        applicantUserId: updated.applicantUserId,
      }),
      createdAt: new Date().toISOString(),
    });

    return {
      type: "success",
      title: "Заявка отменена",
      message: "Заявка успешно отменена.",
      data: { application: this.toDto(updated) },
    };
  }

  private validateJoinPayload(payload: JoinApplicationPayload): { valid: boolean; error?: string } {
    if (!payload.nickname || payload.nickname.trim().length < 2 || payload.nickname.trim().length > 50) {
      return { valid: false, error: "Позывной должен быть длиной 2-50 символов." };
    }
    if (!Number.isFinite(payload.age) || payload.age < 14 || payload.age > 100) {
      return { valid: false, error: "Возраст должен быть числом от 14 до 100." };
    }
    if (!payload.timezone || payload.timezone.trim().length === 0) {
      return { valid: false, error: "Часовой пояс обязателен." };
    }
    if (!payload.availability || payload.availability.trim().length === 0) {
      return { valid: false, error: "Доступность обязательна." };
    }
    if (!payload.armaExperience || payload.armaExperience.trim().length === 0) {
      return { valid: false, error: "Опыт в Arma обязателен." };
    }
    if (!payload.milsimExperience || payload.milsimExperience.trim().length === 0) {
      return { valid: false, error: "Опыт в милсиме обязателен." };
    }
    if (!payload.micAndMods || payload.micAndMods.trim().length === 0) {
      return { valid: false, error: "Информация о микрофоне и модах обязательна." };
    }
    if (!payload.whyUnit || payload.whyUnit.trim().length < 10) {
      return { valid: false, error: "Мотивация должна быть не менее 10 символов." };
    }
    return { valid: true };
  }

  private async checkUserHasRole(guildId: string, userId: string, roleKey: string): Promise<boolean> {
    try {
      const mapping = this.storage.mappings.getMapping(guildId, "role", roleKey);
      if (!mapping) return false;

      return await this.discord.checkUserHasRole(guildId, userId, mapping.discordId);
    } catch {
      return false;
    }
  }

  private async promoteToMember(guildId: string, userId: string): Promise<void> {
    // Получаем роли
    const baseMemberMapping = this.storage.mappings.getMapping(guildId, "role", "BASE_MEMBER");
    const baseGuestMapping = this.storage.mappings.getMapping(guildId, "role", "BASE_GUEST");

    if (!baseMemberMapping) {
      throw new AppError({
        code: "NOT_FOUND",
        message: "Роль BASE_MEMBER не найдена. Возможно, деплой ещё не выполнен.",
        retryable: false,
      });
    }

    // Выдаём BASE_MEMBER
    await this.discord.addRoleToMember(guildId, userId, baseMemberMapping.discordId, "Заявка одобрена");

    // Убираем BASE_GUEST (если есть)
    if (baseGuestMapping) {
      try {
        await this.discord.removeRoleFromMember(guildId, userId, baseGuestMapping.discordId, "Продвижение в бойцы");
      } catch {
        // Игнорируем, если роли нет
      }
    }
  }

  private async publishApplicationToQueue(guildId: string, application: ApplicationDto): Promise<void> {
    const queueChannelMapping = this.storage.mappings.getMapping(guildId, "channel", "CH_INTAKE_QUEUE");
    if (!queueChannelMapping) {
      // Канал не найден - возможно, деплой ещё не выполнен
      return;
    }

    // Проверяем, есть ли уже сообщение для этой заявки
    const messageKey = `application:${application.applicationId}`;
    const existingMessageMapping = this.storage.mappings.getMapping(guildId, "message", messageKey);

    // Определяем, является ли текущий пользователь персоналом (для кнопок)
    // В MVP всегда показываем кнопки для персонала (проверка будет на уровне интерфейса)
    const isStaff = true; // Кнопки показываются всем, но проверка прав происходит при нажатии

    const queueMessage = buildApplicationQueueMessage(application, isStaff);

    const result = await this.discord.ensureMessageWithEmbed({
      guildId,
      channelId: queueChannelMapping.discordId,
      messageKey,
      embeds: queueMessage.embeds,
      components: queueMessage.components,
      existingMessageId: existingMessageMapping?.discordId,
      ctx: {
        requestId: ulid(),
        actorUserId: application.applicantUserId,
        reason: "Публикация заявки в очередь",
      },
    });

    // Сохраняем mapping сообщения
    this.storage.mappings.upsertMapping({
      guildId,
      kind: "message",
      key: messageKey,
      discordId: result.messageId,
      fingerprint: application.applicationId, // Используем applicationId как fingerprint
      managedName: null,
    });
  }

  private async updateApplicationInQueue(guildId: string, application: ApplicationDto): Promise<void> {
    const queueChannelMapping = this.storage.mappings.getMapping(guildId, "channel", "CH_INTAKE_QUEUE");
    if (!queueChannelMapping) {
      return;
    }

    const messageKey = `application:${application.applicationId}`;
    const existingMessageMapping = this.storage.mappings.getMapping(guildId, "message", messageKey);
    if (!existingMessageMapping) {
      // Сообщение не найдено - возможно, его ещё не было опубликовано
      // Попытаемся опубликовать сейчас
      await this.publishApplicationToQueue(guildId, application);
      return;
    }

    const isStaff = true; // Кнопки показываются, если статус позволяет
    const queueMessage = buildApplicationQueueMessage(application, isStaff);

    await this.discord.updateMessage({
      guildId,
      channelId: queueChannelMapping.discordId,
      messageId: existingMessageMapping.discordId,
      options: {
        embeds: queueMessage.embeds,
        components: queueMessage.components,
      },
      ctx: {
        requestId: ulid(),
        actorUserId: application.applicantUserId,
        reason: "Обновление статуса заявки",
      },
    });
  }

  private toDto(application: Application): ApplicationDto {
    let payload: JoinApplicationPayload;
    try {
      payload = JSON.parse(application.payloadJson) as JoinApplicationPayload;
    } catch {
      // Fallback для повреждённых данных
      payload = {
        nickname: "Неизвестно",
        age: 0,
        timezone: "",
        availability: "",
        armaExperience: "",
        milsimExperience: "",
        micAndMods: "",
        whyUnit: "",
      };
    }

    return {
      applicationId: application.applicationId,
      guildId: application.guildId,
      type: application.type,
      status: application.status,
      applicantUserId: application.applicantUserId,
      payload,
      decisionByUserId: application.decisionByUserId,
      decisionReason: application.decisionReason,
      decisionAt: application.decisionAt,
      createdAt: application.createdAt,
      updatedAt: application.updatedAt,
    };
  }
}

