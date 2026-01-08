import { ulid } from "ulid";
import { AppError } from "../../shared/errors/appError.js";
import { DiscordGateway } from "../../infra/discord/discordGateway.js";
import { RateLimitQueue } from "../../infra/ratelimit/rateLimitQueue.js";
import { SetupWizardService } from "../../app/services/setupWizardService.js";
import { TemplateDeploymentService } from "../../app/services/templateDeploymentService.js";
export function createInteractionRouter(params) {
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
    async function mustBeGuild(interaction) {
        if (!interaction.inGuild() || !interaction.guildId) {
            throw new AppError({ code: "VALIDATION_FAILED", message: "Команда доступна только в guild.", retryable: false });
        }
    }
    async function mustBeOwnerOrBotAdmin(interaction) {
        await mustBeGuild(interaction);
        const ownerId = await discord.getGuildOwnerId(interaction.guildId);
        if (interaction.user.id === ownerId)
            return;
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!member)
            throw new AppError({ code: "FORBIDDEN", message: "Не удалось проверить роли пользователя.", retryable: false });
        // MVP: считаем бот-админом того, у кого есть роль с именем, совпадающим с managed-name SYS_BOT_ADMIN
        const botAdminRoleName = `〚SSO〛 Админ бота 〔${params.runtime.botAdminRoleKey ?? "SYS_BOT_ADMIN"}〕`;
        const has = member.roles.cache.some((r) => r.name === botAdminRoleName);
        if (!has) {
            throw new AppError({ code: "FORBIDDEN", message: "Требуются права владельца сервера или роль админа бота.", retryable: false });
        }
    }
    async function respond(interaction, result) {
        if (result.type === "success") {
            await interaction.reply({
                ephemeral: true,
                content: `**${result.title}**\n${result.message}`,
            });
            return;
        }
        await interaction.reply({
            ephemeral: true,
            content: `Ошибка: ${result.errorCode}\n${result.userMessage}\nrequestId=${interaction.id}`,
        });
    }
    return async function route(interaction) {
        const requestId = ulid();
        try {
            if (interaction.commandName === "setup") {
                await mustBeOwnerOrBotAdmin(interaction);
                const sub = interaction.options.getSubcommand(true);
                const ctx = {
                    guildId: interaction.guildId,
                    channelId: interaction.channelId,
                    actorUserId: interaction.user.id,
                    requestId,
                    locale: interaction.locale,
                };
                if (sub === "start")
                    return await respond(interaction, await setupWizard.start(ctx));
                if (sub === "status")
                    return await respond(interaction, await setupWizard.status(ctx));
                if (sub === "cancel")
                    return await respond(interaction, await setupWizard.cancel(ctx));
                throw new AppError({ code: "VALIDATION_FAILED", message: "Неизвестная subcommand для setup.", retryable: false });
            }
            if (interaction.commandName === "deploy") {
                await mustBeOwnerOrBotAdmin(interaction);
                const sub = interaction.options.getSubcommand(true);
                const ctx = {
                    guildId: interaction.guildId,
                    channelId: interaction.channelId,
                    actorUserId: interaction.user.id,
                    requestId,
                    locale: interaction.locale,
                };
                if (sub === "preview")
                    return await respond(interaction, await deploy.preview(ctx));
                if (sub === "apply")
                    return await respond(interaction, await deploy.apply(ctx));
                throw new AppError({ code: "VALIDATION_FAILED", message: "Неизвестная subcommand для deploy.", retryable: false });
            }
            await interaction.reply({ ephemeral: true, content: "Неизвестная команда." });
        }
        catch (e) {
            const err = e instanceof AppError
                ? e
                : new AppError({ code: "TRANSIENT_FAILURE", message: "Unhandled error", retryable: true, details: String(e) });
            const msg = `${err.code}: ${err.message}\nrequestId=${requestId}`;
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ ephemeral: true, content: msg });
            }
            else {
                await interaction.reply({ ephemeral: true, content: msg });
            }
        }
    };
}
