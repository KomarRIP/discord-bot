import { ulid } from "ulid";
import type { ButtonInteraction, ChatInputCommandInteraction, Client, Interaction, ModalSubmitInteraction, AutocompleteInteraction } from "discord.js";
import { AppError } from "../../shared/errors/appError.js";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import type { Storage } from "../../infra/storage/sqlite/sqliteStorage.js";
import { DiscordGateway } from "../../infra/discord/discordGateway.js";
import { TemplateRegistry } from "../../infra/templates/templateRegistry.js";
import { RateLimitQueue } from "../../infra/ratelimit/rateLimitQueue.js";
import { SetupWizardService } from "../../app/services/setupWizardService.js";
import { TemplateDeploymentService } from "../../app/services/templateDeploymentService.js";
import { IntakeService } from "../../app/services/intakeService.js";
import { MemberRoleManagementService } from "../../app/services/memberRoleManagementService.js";
import { AuditLogService } from "../../infra/audit/auditLogService.js";
import type { CommandContextDto } from "../../app/dto/commandContextDto.js";
import type { ResultDto } from "../../app/dto/resultDto.js";
import { decodeCustomId } from "./customId.js";
import { buildDeployPreviewMessage } from "./render/deployPreviewRenderer.js";
import {
  buildSetupWizardMessage,
  buildSetupWizardModal,
  buildSetupWizardPreviewMessage,
} from "./render/setupWizardRenderer.js";
import {
  buildApplicationModal,
  buildApplicationQueueMessage,
  buildApplicationListMessage,
  buildApplicationEmbed,
} from "./render/intakeRenderer.js";
import type { SetupWizardStateDto, SetupWizardUiDto } from "../../app/services/setupWizardService.js";
import type { DeploymentPreviewDto } from "../../app/services/templateDeploymentService.js";

export function createInteractionRouter(params: {
  client: Client;
  storage: Storage;
  templates: TemplateRegistry;
  runtime: RuntimeConfig;
}) {
  const discord = new DiscordGateway(params.client);
  const queue = new RateLimitQueue({ maxGlobalConcurrency: params.runtime.rateLimit.maxGlobalConcurrency });

  const setupWizard = new SetupWizardService(params.storage);
  const deploy = new TemplateDeploymentService({
    templates: params.templates,
    storage: params.storage,
    discord,
    queue,
    botAdminRoleKey: params.runtime.botAdminRoleKey,
  });
  const auditLog = new AuditLogService(params.storage, discord);
  const intake = new IntakeService(params.storage, discord, auditLog);
  const memberRoles = new MemberRoleManagementService(params.storage, discord, params.templates, auditLog);

  async function mustBeGuild(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction) {
    if (!interaction.inGuild() || !interaction.guildId) {
      throw new AppError({ code: "VALIDATION_FAILED", message: "Команда доступна только в guild.", retryable: false });
    }
  }

  async function mustBeOwnerOrBotAdmin(interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction) {
    await mustBeGuild(interaction);
    const ownerId = await discord.getGuildOwnerId(interaction.guildId!);
    if (interaction.user.id === ownerId) return;

    const member = await interaction.guild!.members.fetch(interaction.user.id).catch(() => null);
    if (!member) throw new AppError({ code: "FORBIDDEN", message: "Не удалось проверить роли пользователя.", retryable: false });

    // MVP: считаем бот-админом того, у кого есть роль с именем, совпадающим с managed-name SYS_BOT_ADMIN
    const botAdminRoleName = `〚SSO〛 Админ бота 〔${params.runtime.botAdminRoleKey ?? "SYS_BOT_ADMIN"}〕`;
    const has = member.roles.cache.some((r) => r.name === botAdminRoleName);
    if (!has) {
      throw new AppError({ code: "FORBIDDEN", message: "Требуются права владельца сервера или роль админа бота.", retryable: false });
    }
  }

  async function checkUserHasRole(guildId: string, userId: string, roleKey: string): Promise<boolean> {
    try {
      const mapping = params.storage.mappings.getMapping(guildId, "role", roleKey);
      if (!mapping) return false;
      return await discord.checkUserHasRole(guildId, userId, mapping.discordId);
    } catch {
      return false;
    }
  }

  async function mustHaveRole(
    interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
    roleKey: string,
  ): Promise<void> {
    await mustBeGuild(interaction);
    const ownerId = await discord.getGuildOwnerId(interaction.guildId!);
    if (interaction.user.id === ownerId) return;

    const hasRole = await checkUserHasRole(interaction.guildId!, interaction.user.id, roleKey);
    if (!hasRole) {
      throw new AppError({ code: "FORBIDDEN", message: `Требуется роль: ${roleKey}`, retryable: false });
    }
  }

  async function mustHaveAnyRole(
    interaction: ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction,
    roleKeys: string[],
  ): Promise<void> {
    await mustBeGuild(interaction);
    const ownerId = await discord.getGuildOwnerId(interaction.guildId!);
    if (interaction.user.id === ownerId) return;

    for (const roleKey of roleKeys) {
      if (await checkUserHasRole(interaction.guildId!, interaction.user.id, roleKey)) {
        return;
      }
    }

    throw new AppError({
      code: "FORBIDDEN",
      message: `Требуется одна из ролей: ${roleKeys.join(", ")}`,
      retryable: false,
    });
  }

  function asWizardUi(data: unknown): SetupWizardUiDto | null {
    if (!data || typeof data !== "object") return null;
    const ui = (data as Record<string, unknown>).ui;
    if (!ui || typeof ui !== "object") return null;
    const kind = (ui as Record<string, unknown>).kind;
    if (kind !== "wizard") return null;
    return ui as SetupWizardUiDto;
  }

  function isDeploymentPreviewDto(data: unknown): data is DeploymentPreviewDto {
    if (!data || typeof data !== "object") return false;
    const o = data as Record<string, unknown>;
    return (
      typeof o.templateId === "string" &&
      typeof o.templateVersion === "string" &&
      typeof o.schemaVersion === "string" &&
      typeof o.deploymentConfigHash === "string" &&
      Array.isArray(o.items) &&
      Array.isArray(o.warnings) &&
      typeof o.summary === "object" &&
      o.summary !== null
    );
  }

  async function respond(interaction: ChatInputCommandInteraction, result: ResultDto<unknown>) {
    if (result.type === "success") {
      // setup wizard UI renderer
      const wizardUi = asWizardUi(result.data);
      if (wizardUi) {
        const msg = buildSetupWizardMessage({ state: wizardUi.state });
        await interaction.reply({ ...msg, ephemeral: true });
        return;
      }

      // special renderer for deploy preview
      if (result.title === "Deploy preview" && isDeploymentPreviewDto(result.data)) {
        const msg = buildDeployPreviewMessage({ preview: result.data, page: 1 });
        await interaction.reply({ ...msg, ephemeral: true });
        return;
      }

      const payload = { ephemeral: true, content: `**${result.title}**\n${result.message}` };
      await interaction.reply(payload);
      return;
    }
    const payload = {
      ephemeral: true,
      content: `Ошибка: ${result.errorCode}\n${result.userMessage}\nrequestId=${interaction.id}`,
    };
    await interaction.reply(payload);
  }

  async function handleDeployButtons(interaction: ButtonInteraction) {
    await mustBeOwnerOrBotAdmin(interaction);
    const parsed = decodeCustomId(interaction.customId);
    if (!parsed || parsed.ns !== "deploy") return;

    const ctx = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      requestId: ulid(),
      locale: interaction.locale,
    };

    if (parsed.action === "cancel") {
      return await interaction.update({ content: "Ок, отменено.", components: [], embeds: [] });
    }

    if (parsed.action === "apply") {
      // apply может занять время; в MVP отвечаем сразу
      await interaction.reply({ ephemeral: true, content: "Запускаю деплой..." });
      const res = await deploy.apply(ctx);
      if (res.type === "success") {
        await interaction.followUp({ ephemeral: true, content: `Готово: ${res.message}` });
      } else {
        await interaction.followUp({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
      }
      return;
    }

    if (parsed.action === "preview") {
      const res = await deploy.preview(ctx);
      if (res.type !== "success" || !res.data) {
        return await interaction.reply({ ephemeral: true, content: "Не удалось построить preview." });
      }
      const msg = buildDeployPreviewMessage({ preview: res.data, page: parsed.page });
      return await interaction.update(msg);
    }
  }

  async function renderWizard(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    ctx: CommandContextDto,
    state: SetupWizardStateDto,
    page = 1,
  ) {
    if (state.stepKey === "preview") {
      const res = await deploy.preview(ctx);
      if (res.type === "success" && res.data) {
        const msg = buildSetupWizardPreviewMessage({ state, preview: res.data, page });
        if (interaction.isChatInputCommand()) return await interaction.reply({ ...msg, ephemeral: true });
        return await (interaction as ButtonInteraction).update(msg);
      }
      const fallback = buildSetupWizardMessage({ state });
      const content = "Не удалось построить preview. Попробуйте позже или используйте `/deploy preview`.";
      if (interaction.isChatInputCommand()) return await interaction.reply({ ...fallback, ephemeral: true, content });
      return await (interaction as ButtonInteraction).update({ ...fallback, content });
    }

    const msg = buildSetupWizardMessage({ state });
    if (interaction.isChatInputCommand()) return await interaction.reply({ ...msg, ephemeral: true });
    return await (interaction as ButtonInteraction).update(msg);
  }

  async function handleWizardButtons(interaction: ButtonInteraction) {
    await mustBeOwnerOrBotAdmin(interaction);
    const parsed = decodeCustomId(interaction.customId);
    if (!parsed || parsed.ns !== "wizard") return;

    const ctx: CommandContextDto = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      requestId: ulid(),
      locale: interaction.locale,
    };

    if (parsed.action === "cancel") {
      await setupWizard.cancel(ctx);
      return await interaction.update({ content: "Ок, мастер отменён.", components: [], embeds: [] });
    }

    if (parsed.action === "back" || parsed.action === "next") {
      const res = await setupWizard.navigate(ctx, { sessionId: parsed.sessionId, dir: parsed.action === "back" ? "back" : "next" });
      if (res.type !== "success") return await interaction.reply({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
      if (!res.data?.ui) return await interaction.reply({ ephemeral: true, content: "Не удалось получить состояние мастера." });
      const state = res.data.ui.state;
      return await renderWizard(interaction, ctx, state, 1);
    }

    if (parsed.action === "preview") {
      const status = await setupWizard.status(ctx);
      if (status.type !== "success" || !status.data?.ui) {
        return await interaction.reply({ ephemeral: true, content: "Setup-сессия не найдена. Запустите `/setup start`." });
      }
      const state = status.data.ui.state;
      return await renderWizard(interaction, ctx, state, parsed.page);
    }

    if (parsed.action === "edit") {
      const status = await setupWizard.status(ctx);
      if (status.type !== "success" || !status.data?.ui) {
        return await interaction.reply({ ephemeral: true, content: "Setup-сессия не найдена. Запустите `/setup start`." });
      }
      const state = status.data.ui.state;
      if (state.sessionId !== parsed.sessionId) {
        return await interaction.reply({ ephemeral: true, content: "Сессия изменилась. Обновите `/setup status`." });
      }
      if (parsed.field !== "unit_name" && parsed.field !== "unit_size") {
        return await interaction.reply({ ephemeral: true, content: "Этот шаг пока не редактируется в MVP." });
      }
      const modal = buildSetupWizardModal({ state, field: parsed.field });
      return await interaction.showModal(modal);
    }

    if (parsed.action === "confirm") {
      // подтверждение может занять время — сначала гасим UI, потом работаем
      setupWizard.markDeploying(ctx.guildId, parsed.sessionId);
      await interaction.update({ content: "Запускаю деплой... Это может занять несколько минут.", components: [], embeds: [] });
      try {
        const res = await deploy.apply(ctx);
        if (res.type === "success") {
          setupWizard.markCompleted(ctx.guildId, parsed.sessionId);
          await interaction.followUp({ ephemeral: true, content: `Готово: ${res.message}` });
        } else {
          setupWizard.markFailed(ctx.guildId, parsed.sessionId);
          await interaction.followUp({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
        }
      } catch (e) {
        setupWizard.markFailed(ctx.guildId, parsed.sessionId);
        throw e;
      }
      return;
    }
  }

  async function handleWizardModal(interaction: ModalSubmitInteraction, parsed: { sessionId: string; field: string }, requestId: string) {
    const ctx: CommandContextDto = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId!,
      actorUserId: interaction.user.id,
      requestId,
      locale: interaction.locale,
    };

    let res: ResultDto<{ ui: SetupWizardUiDto }>;
    if (parsed.field === "unit_name") {
      const unitName = interaction.fields.getTextInputValue("unit_name");
      res = await setupWizard.updateAnswersFromModal(ctx, { sessionId: parsed.sessionId, field: "unit_name", unitName });
    } else if (parsed.field === "unit_size") {
      const unitSize = Number(interaction.fields.getTextInputValue("unit_size"));
      const positionsLimitPerMember = Number(interaction.fields.getTextInputValue("positions_limit"));
      res = await setupWizard.updateAnswersFromModal(ctx, {
        sessionId: parsed.sessionId,
        field: "unit_size",
        unitSize,
        positionsLimitPerMember,
      });
    } else {
      res = { type: "error", errorCode: "VALIDATION_FAILED", userMessage: "Неизвестное поле модалки.", retryable: false };
    }

    if (res.type !== "success") {
      const msg = { content: `Ошибка: ${res.errorCode}\n${res.userMessage}\nrequestId=${requestId}`, ephemeral: true };
      if (interaction.isFromMessage()) return await interaction.update({ ...msg, components: [], embeds: [] });
      return await interaction.reply(msg);
    }

    const ui = res.data?.ui;
    if (!ui) {
      const msg = { content: `Ошибка: TRANSIENT_FAILURE\nНе удалось получить состояние мастера.\nrequestId=${requestId}`, ephemeral: true };
      if (interaction.isFromMessage()) return await interaction.update({ ...msg, components: [], embeds: [] });
      return await interaction.reply(msg);
    }
    const state = ui.state;
    const msg = state.stepKey === "preview"
      ? await (async () => {
          const pr = await deploy.preview(ctx);
          if (pr.type === "success" && pr.data) return buildSetupWizardPreviewMessage({ state, preview: pr.data, page: 1 });
          return buildSetupWizardMessage({ state });
        })()
      : buildSetupWizardMessage({ state });

    if (interaction.isFromMessage()) return await interaction.update(msg);
    return await interaction.reply({ ...msg, ephemeral: true });
  }

  async function handleIntakeModal(interaction: ModalSubmitInteraction, requestId: string) {
    const ctx: CommandContextDto = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId!,
      actorUserId: interaction.user.id,
      requestId,
      locale: interaction.locale,
    };

    const nickname = interaction.fields.getTextInputValue("nickname");
    const age = Number(interaction.fields.getTextInputValue("age"));
    const timezone = interaction.fields.getTextInputValue("timezone");
    const availability = interaction.fields.getTextInputValue("availability");
    const experience = interaction.fields.getTextInputValue("experience");

    // Разделяем experience на armaExperience и milsimExperience (первый абзац - Arma, второй - милсим)
    const experienceParts = experience.split("\n\n");
    const armaExperience = experienceParts[0]?.trim() || experience;
    const milsimExperience = experienceParts[1]?.trim() || "";

    // Для MVP объединяем micAndMods и whyUnit в одно поле (в experience)
    // В будущем можно добавить вторую модалку или использовать другой подход
    const micAndMods = "Уточнить в собеседовании"; // Заглушка
    const whyUnit = "Указано в заявке"; // Заглушка

    const payload = {
      nickname: nickname.trim(),
      age: Math.trunc(age),
      timezone: timezone.trim(),
      availability: availability.trim(),
      armaExperience: armaExperience.trim(),
      milsimExperience: milsimExperience.trim() || armaExperience.trim(),
      micAndMods: micAndMods,
      whyUnit: whyUnit,
    };

    const res = await intake.createApplication(ctx, payload);
    if (res.type === "success") {
      await interaction.reply({
        ephemeral: true,
        content: `**${res.title}**\n${res.message}\n\nID заявки: \`${res.data?.application?.applicationId || "?"}\`\nИспользуйте команду для подачи на рассмотрение.`,
      });
    } else {
      await interaction.reply({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
    }
  }

  async function handleIntakeButtons(interaction: ButtonInteraction) {
    await mustBeGuild(interaction);
    const parsed = decodeCustomId(interaction.customId);
    if (!parsed || parsed.ns !== "intake") return;

    const ctx: CommandContextDto = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      requestId: ulid(),
      locale: interaction.locale,
    };

    if (parsed.action === "apply") {
      const modal = buildApplicationModal();
      return await interaction.showModal(modal);
    }

    if (parsed.action === "submit") {
      await mustHaveRole(interaction, "BASE_GUEST");
      const res = await intake.submitApplication(ctx, parsed.applicationId);
      if (res.type === "success") {
        await interaction.update({ content: "✅ Заявка подана на рассмотрение!", components: [], embeds: [] });
      } else {
        await interaction.reply({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
      }
      return;
    }

    if (parsed.action === "approve") {
      await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
      const res = await intake.approveApplication(ctx, parsed.applicationId);
      if (res.type === "success" && res.data?.application) {
        const isStaff = await checkUserHasRole(ctx.guildId, ctx.actorUserId, "BASE_STAFF") || (await checkUserHasRole(ctx.guildId, ctx.actorUserId, "BASE_COMMAND"));
        const msg = buildApplicationQueueMessage(res.data.application, isStaff);
        await interaction.update(msg);
      } else if (res.type === "error") {
        await interaction.reply({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
      } else {
        await interaction.reply({ ephemeral: true, content: "Не удалось одобрить заявку." });
      }
      return;
    }

    if (parsed.action === "reject") {
      await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
      // Для reject нужно запросить причину - пока простой ответ
      await interaction.reply({
        ephemeral: true,
        content: "Используйте команду `/intake reject <id> <reason>` для отклонения с указанием причины.",
      });
      return;
    }

    if (parsed.action === "cancel") {
      const res = await intake.cancelApplication(ctx, parsed.applicationId);
      if (res.type === "success") {
        await interaction.update({ content: "🚫 Заявка отменена.", components: [], embeds: [] });
      } else {
        await interaction.reply({ ephemeral: true, content: `Ошибка: ${res.errorCode}\n${res.userMessage}` });
      }
      return;
    }
  }

  async function handleRolesAutocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.inGuild() || !interaction.guildId) return;

    const focused = interaction.options.getFocused(true);
    const subcommand = interaction.options.getSubcommand(true);
    const filter = interaction.options.getString(focused.name) || "";

    // Определяем тип роли в зависимости от subcommand
    let roleType: "rank" | "position" | "clearance" = "rank";
    if (subcommand === "add-position" || subcommand === "remove-position") {
      roleType = "position";
    } else if (subcommand === "grant-clearance" || subcommand === "revoke-clearance") {
      roleType = "clearance";
    }

    try {
      // Получаем активный шаблон гильдии
      const guildState = params.storage.guilds.getGuildState(interaction.guildId);
      if (!guildState || !guildState.activeTemplateId) {
        return await interaction.respond([]);
      }

      // Получаем шаблон
      const template = await params.templates.getTemplate(guildState.activeTemplateId);
      
      // Для set-rank добавляем опцию "Снять звание"
      const options: Array<{ name: string; value: string }> = [];
      if (subcommand === "set-rank" && (filter === "" || "снять".includes(filter.toLowerCase()) || "нет".includes(filter.toLowerCase()))) {
        options.push({
          name: "— Снять звание —",
          value: "",
        });
      }

      // Фильтруем роли по типу и поисковому запросу
      const roles = template.roles
        .filter((r) => r.type === roleType)
        .filter((r) => r.key.toLowerCase().includes(filter.toLowerCase()) || r.name.toLowerCase().includes(filter.toLowerCase()))
        .slice(0, 25 - options.length); // Discord ограничивает autocomplete до 25 вариантов

      options.push(
        ...roles.map((r) => ({
          name: `${r.name} (${r.key})`,
          value: r.key,
        })),
      );

      await interaction.respond(options);
    } catch {
      await interaction.respond([]);
    }
  }

  return async function route(interaction: Interaction) {
    const requestId = ulid();

    try {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === "roles") {
          return await handleRolesAutocomplete(interaction);
        }
        return;
      }

      if (interaction.isButton()) {
        const parsed = decodeCustomId(interaction.customId);
        if (parsed?.ns === "deploy") return await handleDeployButtons(interaction);
        if (parsed?.ns === "wizard") return await handleWizardButtons(interaction);
        if (parsed?.ns === "intake") return await handleIntakeButtons(interaction);
        return;
      }

      if (interaction.isModalSubmit()) {
        const parsed = decodeCustomId(interaction.customId);
        if (parsed?.ns === "wizard" && parsed.action === "modal") {
          await mustBeOwnerOrBotAdmin(interaction);
          return await handleWizardModal(interaction, parsed, requestId);
        }
        if (parsed?.ns === "intake" && parsed.action === "modal") {
          await mustHaveRole(interaction, "BASE_GUEST");
          return await handleIntakeModal(interaction, requestId);
        }
        return;
      }


      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "setup") {
        await mustBeOwnerOrBotAdmin(interaction);
        const sub = interaction.options.getSubcommand(true);
        const ctx = {
          guildId: interaction.guildId!,
          channelId: interaction.channelId,
          actorUserId: interaction.user.id,
          requestId,
          locale: interaction.locale,
        };
        if (sub === "start") {
          const res = await setupWizard.start(ctx);
          if (res.type === "success" && res.data?.ui?.kind === "wizard") {
            return await renderWizard(interaction, ctx, res.data.ui.state, 1);
          }
          return await respond(interaction, res);
        }
        if (sub === "status") {
          const res = await setupWizard.status(ctx);
          if (res.type === "success" && res.data?.ui?.kind === "wizard") {
            return await renderWizard(interaction, ctx, res.data.ui.state, 1);
          }
          return await respond(interaction, res);
        }
        if (sub === "cancel") return await respond(interaction, await setupWizard.cancel(ctx));
        throw new AppError({ code: "VALIDATION_FAILED", message: "Неизвестная subcommand для setup.", retryable: false });
      }

      if (interaction.commandName === "deploy") {
        await mustBeOwnerOrBotAdmin(interaction);
        const sub = interaction.options.getSubcommand(true);
        const ctx = {
          guildId: interaction.guildId!,
          channelId: interaction.channelId,
          actorUserId: interaction.user.id,
          requestId,
          locale: interaction.locale,
        };
        if (sub === "preview") return await respond(interaction, await deploy.preview(ctx));
        if (sub === "apply") return await respond(interaction, await deploy.apply(ctx));
        throw new AppError({ code: "VALIDATION_FAILED", message: "Неизвестная subcommand для deploy.", retryable: false });
      }

      if (interaction.commandName === "intake") {
        await mustBeGuild(interaction);
        const sub = interaction.options.getSubcommand(true);
        const ctx = {
          guildId: interaction.guildId!,
          channelId: interaction.channelId,
          actorUserId: interaction.user.id,
          requestId,
          locale: interaction.locale,
        };

        if (sub === "apply") {
          const modal = buildApplicationModal();
          return await interaction.showModal(modal);
        }

        if (sub === "list") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const statusFilter = interaction.options.getString("status") as "submitted" | "under_review" | "approved" | "rejected" | undefined;
          const res = await intake.listApplications(ctx, statusFilter ? { status: statusFilter } : undefined);
          if (res.type === "success" && res.data?.applications) {
            const msg = buildApplicationListMessage(res.data.applications);
            return await interaction.reply({ ...msg, ephemeral: true });
          }
          return await respond(interaction, res);
        }

        if (sub === "approve") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const applicationId = interaction.options.getString("id", true);
          const reason = interaction.options.getString("reason");
          return await respond(interaction, await intake.approveApplication(ctx, applicationId, reason ?? undefined));
        }

        if (sub === "reject") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const applicationId = interaction.options.getString("id", true);
          const reason = interaction.options.getString("reason", true);
          return await respond(interaction, await intake.rejectApplication(ctx, applicationId, reason));
        }

        if (sub === "cancel") {
          // Отмена своей заявки - проверка на авторство будет в сервисе
          const active = params.storage.applications.getActiveApplicationByApplicant(ctx.guildId, ctx.actorUserId, "join");
          if (!active) {
            return await interaction.reply({ ephemeral: true, content: "У вас нет активной заявки для отмены." });
          }
          return await respond(interaction, await intake.cancelApplication(ctx, active.applicationId));
        }

        throw new AppError({ code: "VALIDATION_FAILED", message: "Неизвестная subcommand для intake.", retryable: false });
      }

      if (interaction.commandName === "roles") {
        await mustBeGuild(interaction);
        const sub = interaction.options.getSubcommand(true);
        const ctx = {
          guildId: interaction.guildId!,
          channelId: interaction.channelId,
          actorUserId: interaction.user.id,
          requestId,
          locale: interaction.locale,
        };

        if (sub === "set-rank") {
          await mustHaveRole(interaction, "BASE_COMMAND");
          const targetUser = interaction.options.getUser("user", true);
          const rankRoleKey = interaction.options.getString("rank", true);
          return await respond(interaction, await memberRoles.setRank(ctx, targetUser.id, rankRoleKey === "" ? null : rankRoleKey));
        }

        if (sub === "add-position") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const targetUser = interaction.options.getUser("user", true);
          const positionRoleKey = interaction.options.getString("position", true);
          return await respond(interaction, await memberRoles.addPosition(ctx, targetUser.id, positionRoleKey));
        }

        if (sub === "remove-position") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const targetUser = interaction.options.getUser("user", true);
          const positionRoleKey = interaction.options.getString("position", true);
          return await respond(interaction, await memberRoles.removePosition(ctx, targetUser.id, positionRoleKey));
        }

        if (sub === "grant-clearance") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const targetUser = interaction.options.getUser("user", true);
          const clearanceRoleKey = interaction.options.getString("clearance", true);
          return await respond(interaction, await memberRoles.grantClearance(ctx, targetUser.id, clearanceRoleKey));
        }

        if (sub === "revoke-clearance") {
          await mustHaveAnyRole(interaction, ["BASE_STAFF", "BASE_COMMAND"]);
          const targetUser = interaction.options.getUser("user", true);
          const clearanceRoleKey = interaction.options.getString("clearance", true);
          return await respond(interaction, await memberRoles.revokeClearance(ctx, targetUser.id, clearanceRoleKey));
        }

        if (sub === "profile") {
          const targetUser = interaction.options.getUser("user", true);
          return await respond(interaction, await memberRoles.getMemberProfile(ctx, targetUser.id));
        }

        throw new AppError({ code: "VALIDATION_FAILED", message: "Неизвестная subcommand для roles.", retryable: false });
      }

      await interaction.reply({ ephemeral: true, content: "Неизвестная команда." });
    } catch (e) {
      const err =
        e instanceof AppError
          ? e
          : new AppError({ code: "TRANSIENT_FAILURE", message: "Unhandled error", retryable: true, details: String(e) });
      const msg = `${err.code}: ${err.message}\nrequestId=${requestId}`;
      if (!interaction.isRepliable()) return;
      if (interaction.deferred || interaction.replied) await interaction.followUp({ ephemeral: true, content: msg });
      else await interaction.reply({ ephemeral: true, content: msg });
    }
  };
}

