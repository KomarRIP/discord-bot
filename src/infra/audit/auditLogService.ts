import { ulid } from "ulid";
import type { Storage } from "../storage/sqlite/sqliteStorage.js";
import type { DiscordGateway, RequestContext } from "../discord/discordGateway.js";
import { EmbedBuilder } from "discord.js";

export type AuditEventType =
  | "ApplicationSubmitted"
  | "ApplicationApproved"
  | "ApplicationRejected"
  | "ApplicationCancelled"
  | "MemberRankSet"
  | "MemberPositionAdded"
  | "MemberPositionRemoved"
  | "MemberClearanceGranted"
  | "MemberClearanceRevoked"
  | "DisciplineRecordAdded"
  | "DisciplineRecordRevoked"
  | "DeploymentStarted"
  | "DeploymentCompleted"
  | "DeploymentFailed";

export type AuditEventPayload = {
  applicationId?: string;
  type?: string;
  applicantUserId?: string;
  decisionReason?: string;
  targetUserId?: string;
  roleKey?: string;
  recordId?: string;
  kind?: string;
  severity?: number;
  reason?: string;
  [key: string]: unknown;
};

export class AuditLogService {
  constructor(
    private readonly storage: Storage,
    private readonly discord: DiscordGateway,
  ) {}

  /**
   * Публикует audit событие в канал CH_AUDIT
   */
  async publishEvent(params: {
    guildId: string;
    eventType: AuditEventType;
    payload: AuditEventPayload;
    actorUserId: string;
  }): Promise<void> {
    // Получаем канал CH_AUDIT
    const auditChannelMapping = this.storage.mappings.getMapping(params.guildId, "channel", "CH_AUDIT");
    if (!auditChannelMapping) {
      // Канал не найден - возможно, деплой ещё не выполнен
      // Не бросаем ошибку, просто логируем (graceful degradation)
      return;
    }

    // Генерируем embed для события
    const embed = this.buildAuditEmbed(params.eventType, params.payload, params.actorUserId);

    try {
      await this.discord.sendMessage({
        guildId: params.guildId,
        channelId: auditChannelMapping.discordId,
        options: {
          embeds: [embed],
        },
        ctx: {
          requestId: ulid(),
          actorUserId: params.actorUserId,
          reason: `Audit event: ${params.eventType}`,
        },
      });
    } catch (e) {
      // Graceful degradation: если не удалось опубликовать, не падаем
      // Ошибка уже зафиксирована в БД через audit.insert в соответствующих сервисах
      const error = e instanceof Error ? e.message : String(e);
      // Можно добавить дополнительное логирование здесь, если нужно
      console.warn(`Failed to publish audit event to Discord: ${error}`);
    }
  }

  private buildAuditEmbed(
    eventType: AuditEventType,
    payload: AuditEventPayload,
    actorUserId: string,
  ): EmbedBuilder {
    const embed = new EmbedBuilder().setTimestamp(new Date());

    // Устанавливаем цвет в зависимости от типа события
    switch (eventType) {
      case "ApplicationApproved":
      case "MemberRankSet":
      case "MemberPositionAdded":
      case "MemberClearanceGranted":
        embed.setColor(0x57f287); // Зелёный - положительные действия
        break;
      case "ApplicationRejected":
      case "DisciplineRecordAdded":
        embed.setColor(0xed4245); // Красный - отрицательные действия
        break;
      case "ApplicationSubmitted":
      case "MemberPositionRemoved":
      case "MemberClearanceRevoked":
        embed.setColor(0xfee75c); // Жёлтый - нейтральные/внимание
        break;
      default:
        embed.setColor(0x95a5a6); // Серый - по умолчанию
    }

    // Заголовок и описание в зависимости от типа события
    switch (eventType) {
      case "ApplicationSubmitted": {
        embed
          .setTitle("📝 Заявка подана")
          .setDescription(`Заявка **${payload.applicationId?.slice(0, 8) ?? "неизвестна"}** подана на рассмотрение`)
          .addFields(
            { name: "Заявитель", value: payload.applicantUserId ? `<@${payload.applicantUserId}>` : "—", inline: true },
            { name: "Тип", value: payload.type === "join" ? "Вступление" : payload.type ?? "—", inline: true },
          );
        break;
      }
      case "ApplicationApproved": {
        embed
          .setTitle("✅ Заявка одобрена")
          .setDescription(`Заявка **${payload.applicationId?.slice(0, 8) ?? "неизвестна"}** одобрена`)
          .addFields(
            { name: "Заявитель", value: payload.applicantUserId ? `<@${payload.applicantUserId}>` : "—", inline: true },
            { name: "Одобрил", value: `<@${actorUserId}>`, inline: true },
          );
        if (payload.decisionReason) {
          embed.addFields({ name: "Примечание", value: payload.decisionReason.slice(0, 1024), inline: false });
        }
        break;
      }
      case "ApplicationRejected": {
        embed
          .setTitle("❌ Заявка отклонена")
          .setDescription(`Заявка **${payload.applicationId?.slice(0, 8) ?? "неизвестна"}** отклонена`)
          .addFields(
            { name: "Заявитель", value: payload.applicantUserId ? `<@${payload.applicantUserId}>` : "—", inline: true },
            { name: "Отклонил", value: `<@${actorUserId}>`, inline: true },
          );
        if (payload.decisionReason) {
          embed.addFields({ name: "Причина", value: payload.decisionReason.slice(0, 1024), inline: false });
        }
        break;
      }
      case "ApplicationCancelled": {
        embed
          .setTitle("🚫 Заявка отменена")
          .setDescription(`Заявка **${payload.applicationId?.slice(0, 8) ?? "неизвестна"}** отменена`)
          .addFields({
            name: "Отменил",
            value: `<@${actorUserId}>`,
            inline: true,
          });
        break;
      }
      case "MemberRankSet": {
        embed
          .setTitle("⭐ Звание изменено")
          .setDescription(`Звание участника изменено`)
          .addFields(
            { name: "Участник", value: payload.targetUserId ? `<@${payload.targetUserId}>` : "—", inline: true },
            { name: "Звание", value: payload.roleKey ?? "—", inline: true },
            { name: "Изменил", value: `<@${actorUserId}>`, inline: true },
          );
        break;
      }
      case "MemberPositionAdded": {
        embed
          .setTitle("➕ Должность добавлена")
          .setDescription(`Должность назначена участнику`)
          .addFields(
            { name: "Участник", value: payload.targetUserId ? `<@${payload.targetUserId}>` : "—", inline: true },
            { name: "Должность", value: payload.roleKey ?? "—", inline: true },
            { name: "Назначил", value: `<@${actorUserId}>`, inline: true },
          );
        break;
      }
      case "MemberPositionRemoved": {
        embed
          .setTitle("➖ Должность снята")
          .setDescription(`Должность снята с участника`)
          .addFields(
            { name: "Участник", value: payload.targetUserId ? `<@${payload.targetUserId}>` : "—", inline: true },
            { name: "Должность", value: payload.roleKey ?? "—", inline: true },
            { name: "Снял", value: `<@${actorUserId}>`, inline: true },
          );
        break;
      }
      case "MemberClearanceGranted": {
        embed
          .setTitle("🔓 Допуск выдан")
          .setDescription(`Допуск выдан участнику`)
          .addFields(
            { name: "Участник", value: payload.targetUserId ? `<@${payload.targetUserId}>` : "—", inline: true },
            { name: "Допуск", value: payload.roleKey ?? "—", inline: true },
            { name: "Выдал", value: `<@${actorUserId}>`, inline: true },
          );
        break;
      }
      case "MemberClearanceRevoked": {
        embed
          .setTitle("🔒 Допуск отозван")
          .setDescription(`Допуск отозван у участника`)
          .addFields(
            { name: "Участник", value: payload.targetUserId ? `<@${payload.targetUserId}>` : "—", inline: true },
            { name: "Допуск", value: payload.roleKey ?? "—", inline: true },
            { name: "Отозвал", value: `<@${actorUserId}>`, inline: true },
          );
        break;
      }
      case "DisciplineRecordAdded": {
        const severityEmoji = payload.severity
          ? payload.severity >= 4
            ? "🔴"
            : payload.severity >= 3
              ? "🟠"
              : payload.severity >= 2
                ? "🟡"
                : "🟢"
          : "⚪";
        embed
          .setTitle(`${severityEmoji} Дисциплинарная запись`)
          .setDescription(`Добавлена дисциплинарная запись`)
          .addFields(
            { name: "Участник", value: payload.targetUserId ? `<@${payload.targetUserId}>` : "—", inline: true },
            { name: "Тип", value: payload.kind === "warning" ? "Предупреждение" : "Замечание", inline: true },
            { name: "Серьёзность", value: payload.severity ? String(payload.severity) : "—", inline: true },
            { name: "Добавил", value: `<@${actorUserId}>`, inline: true },
          );
        if (payload.reason) {
          embed.addFields({ name: "Причина", value: payload.reason.slice(0, 1024), inline: false });
        }
        break;
      }
      default: {
        embed
          .setTitle(`📋 Событие: ${eventType}`)
          .setDescription("Зафиксировано audit событие")
          .addFields({
            name: "Исполнитель",
            value: `<@${actorUserId}>`,
            inline: true,
          });
      }
    }

    return embed;
  }
}


