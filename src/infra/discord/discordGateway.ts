import {
  ChannelType as DjsChannelType,
  Client,
  Guild,
  GuildBasedChannel,
  type OverwriteResolvable,
  type TextChannel,
  Role,
  type MessageOptions,
  type MessageEditOptions,
  type EmbedBuilder,
  type ActionRowBuilder,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import { AppError } from "../../shared/errors/appError.js";

export type RequestContext = {
  requestId: string;
  actorUserId: string;
  reason?: string;
};

export type RoleSnapshot = {
  roleId: string;
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
};

export type ChannelSnapshot = {
  channelId: string;
  name: string;
  type: "category" | "text";
  parentId: string | null;
  topic?: string | null;
};

export type EnsureResult = { id: string; changed: boolean };

export class DiscordGateway {
  constructor(private readonly client: Client) {}

  async getGuildOwnerId(guildId: string): Promise<string> {
    const g = await this.fetchGuild(guildId);
    return g.ownerId;
  }

  async getEveryoneRoleId(guildId: string): Promise<string> {
    const g = await this.fetchGuild(guildId);
    return g.roles.everyone.id;
  }

  getBotUserId(): string {
    const id = this.client.user?.id;
    if (!id) throw new Error("Bot user is not ready yet");
    return id;
  }

  async getRoleById(guildId: string, roleId: string): Promise<RoleSnapshot | null> {
    const g = await this.fetchGuild(guildId);
    try {
      const r = await g.roles.fetch(roleId);
      if (!r) return null;
      return {
        roleId: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
      };
    } catch {
      return null;
    }
  }

  async ensureRole(params: {
    guildId: string;
    name: string;
    managedName: string;
    color?: number;
    hoist?: boolean;
    mentionable?: boolean;
    existingRoleId?: string;
    ctx: RequestContext;
  }): Promise<EnsureResult> {
    const g = await this.fetchGuild(params.guildId);

    let role: Role | null = null;
    if (params.existingRoleId) {
      role = (await g.roles.fetch(params.existingRoleId).catch(() => null)) as Role | null;
    }

    if (!role) {
      role = this.adoptRoleByName(g, params.managedName);
    }

    if (!role) {
      const created = await g.roles.create({
        name: params.managedName,
        color: params.color,
        hoist: params.hoist,
        mentionable: params.mentionable,
        reason: params.ctx.reason ?? `requestId=${params.ctx.requestId}`,
      });
      return { id: created.id, changed: true };
    }

    const patch: Record<string, unknown> = {};
    if (role.name !== params.managedName) patch.name = params.managedName;
    if (params.color !== undefined && role.color !== params.color) patch.color = params.color;
    if (params.hoist !== undefined && role.hoist !== params.hoist) patch.hoist = params.hoist;
    if (params.mentionable !== undefined && role.mentionable !== params.mentionable)
      patch.mentionable = params.mentionable;

    if (Object.keys(patch).length === 0) return { id: role.id, changed: false };

    const updated = await role.edit({
      ...patch,
      reason: params.ctx.reason ?? `requestId=${params.ctx.requestId}`,
    });
    return { id: updated.id, changed: true };
  }

  async getChannelById(guildId: string, channelId: string): Promise<ChannelSnapshot | null> {
    const g = await this.fetchGuild(guildId);
    const ch = await g.channels.fetch(channelId).catch(() => null);
    if (!ch) return null;
    if (ch.type === DjsChannelType.GuildCategory) {
      return { channelId: ch.id, name: ch.name, type: "category", parentId: null };
    }
    if (ch.type === DjsChannelType.GuildText) {
      const text = ch as TextChannel;
      return {
        channelId: ch.id,
        name: ch.name,
        type: "text",
        parentId: ch.parentId ?? null,
        topic: text.topic ?? null,
      };
    }
    return null;
  }

  async ensureCategory(params: {
    guildId: string;
    name: string;
    managedName: string;
    existingCategoryId?: string;
    ctx: RequestContext;
  }): Promise<EnsureResult> {
    const g = await this.fetchGuild(params.guildId);

    let cat: GuildBasedChannel | null = null;
    if (params.existingCategoryId) {
      cat = await g.channels.fetch(params.existingCategoryId).catch(() => null);
    }

    if (!cat) {
      cat = this.adoptChannelByName(g, DjsChannelType.GuildCategory, params.managedName);
    }

    if (!cat) {
      const created = await g.channels.create({
        name: params.managedName,
        type: DjsChannelType.GuildCategory,
        reason: params.ctx.reason ?? `requestId=${params.ctx.requestId}`,
      });
      return { id: created.id, changed: true };
    }

    if (cat.type !== DjsChannelType.GuildCategory) {
      throw new AppError({
        code: "CONFLICT",
        message: `Adopted channel is not a category: ${cat.id}`,
      });
    }

    if (cat.name === params.managedName) return { id: cat.id, changed: false };
    const updated = await cat.edit({
      name: params.managedName,
      reason: params.ctx.reason ?? `requestId=${params.ctx.requestId}`,
    });
    return { id: updated.id, changed: true };
  }

  async ensureTextChannel(params: {
    guildId: string;
    name: string;
    managedName: string;
    topic?: string;
    parentCategoryId?: string;
    existingChannelId?: string;
    ctx: RequestContext;
  }): Promise<EnsureResult> {
    const g = await this.fetchGuild(params.guildId);

    let ch: GuildBasedChannel | null = null;
    if (params.existingChannelId) {
      ch = await g.channels.fetch(params.existingChannelId).catch(() => null);
    }

    if (!ch) {
      ch = this.adoptChannelByName(g, DjsChannelType.GuildText, params.managedName);
    }

    if (!ch) {
      const created = await g.channels.create({
        name: params.managedName,
        type: DjsChannelType.GuildText,
        parent: params.parentCategoryId,
        topic: params.topic,
        reason: params.ctx.reason ?? `requestId=${params.ctx.requestId}`,
      });
      return { id: created.id, changed: true };
    }

    if (ch.type !== DjsChannelType.GuildText) {
      throw new AppError({
        code: "CONFLICT",
        message: `Adopted channel is not a text channel: ${ch.id}`,
      });
    }

    const text = ch as TextChannel;
    const patch: Partial<Parameters<TextChannel["edit"]>[0]> = {};
    if (text.name !== params.managedName) patch.name = params.managedName;
    if (text.topic !== (params.topic ?? null)) patch.topic = params.topic ?? null;
    if (params.parentCategoryId !== undefined && text.parentId !== params.parentCategoryId) patch.parent = params.parentCategoryId;

    if (Object.keys(patch).length === 0) return { id: ch.id, changed: false };
    const updated = await text.edit({
      ...patch,
      reason: params.ctx.reason ?? `requestId=${params.ctx.requestId}`,
    });
    return { id: updated.id, changed: true };
  }

  async setPermissionOverwrites(params: {
    guildId: string;
    targetChannelId: string;
    overwrites: OverwriteResolvable[];
    ctx: RequestContext;
  }): Promise<{ changed: boolean }> {
    const g = await this.fetchGuild(params.guildId);
    const ch = await g.channels.fetch(params.targetChannelId).catch(() => null);
    if (!ch) {
      throw new AppError({ code: "NOT_FOUND", message: `Channel not found: ${params.targetChannelId}` });
    }
    // MVP: replace
    if (!("permissionOverwrites" in ch)) {
      throw new AppError({ code: "CONFLICT", message: `Channel does not support overwrites: ${params.targetChannelId}` });
    }
    await ch.permissionOverwrites.set(params.overwrites, params.ctx.reason ?? `requestId=${params.ctx.requestId}`);
    return { changed: true };
  }

  async ensureMessage(params: {
    guildId: string;
    channelId: string;
    messageKey: string;
    content: string;
    existingMessageId?: string;
    ctx: RequestContext;
  }): Promise<{ messageId: string; changed: boolean }> {
    const g = await this.fetchGuild(params.guildId);
    const ch = await g.channels.fetch(params.channelId).catch(() => null);
    if (!ch || ch.type !== DjsChannelType.GuildText) {
      throw new AppError({ code: "NOT_FOUND", message: `Text channel not found: ${params.channelId}` });
    }

    const channel = ch as TextChannel;
    const marker = `〔${params.messageKey}〕`;
    const desired = params.content.includes(marker) ? params.content : `${params.content}\n\n${marker}`;

    let msg = params.existingMessageId
      ? await channel.messages.fetch(params.existingMessageId).catch(() => null)
      : null;

    if (!msg) {
      // Adoption: ищем маркер среди последних сообщений
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recent) {
        const matches = [...recent.values()].filter((m) => (m.content ?? "").includes(marker));
        if (matches.length === 1) msg = matches[0]!;
        if (matches.length > 1) {
          throw new AppError({
            code: "CONFLICT",
            message: `Multiple messages match key ${params.messageKey} in channel ${params.channelId}`,
          });
        }
      }
    }

    if (!msg) {
      const created = await channel.send({ content: desired });
      return { messageId: created.id, changed: true };
    }

    if (msg.content === desired) return { messageId: msg.id, changed: false };
    const edited = await msg.edit({ content: desired });
    return { messageId: edited.id, changed: true };
  }

  private async fetchGuild(guildId: string): Promise<Guild> {
    const g = await this.client.guilds.fetch(guildId).catch(() => null);
    if (!g) throw new AppError({ code: "NOT_FOUND", message: `Guild not found: ${guildId}` });
    return g;
  }

  private adoptRoleByName(guild: Guild, managedName: string): Role | null {
    const matches = guild.roles.cache.filter((r) => r.name === managedName);
    if (matches.size === 1) return matches.first() ?? null;
    if (matches.size > 1) {
      throw new AppError({
        code: "CONFLICT",
        message: `Multiple roles match managed name: ${managedName}`,
      });
    }
    return null;
  }

  private adoptChannelByName(guild: Guild, type: DjsChannelType, managedName: string): GuildBasedChannel | null {
    const matches = guild.channels.cache.filter((c) => {
      if (c.type !== type) return false;
      const name = (c as unknown as Record<string, unknown>).name;
      return typeof name === "string" && name === managedName;
    });
    if (matches.size === 1) return matches.first() ?? null;
    if (matches.size > 1) {
      throw new AppError({
        code: "CONFLICT",
        message: `Multiple channels match managed name: ${managedName}`,
      });
    }
    return null;
  }

  async checkUserHasRole(guildId: string, userId: string, roleId: string): Promise<boolean> {
    const g = await this.fetchGuild(guildId);
    const member = await g.members.fetch(userId).catch(() => null);
    if (!member) return false;
    return member.roles.cache.has(roleId);
  }

  async addRoleToMember(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    const g = await this.fetchGuild(guildId);
    const member = await g.members.fetch(userId).catch(() => null);
    if (!member) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `Member not found: ${userId}`,
        retryable: false,
      });
    }
    await member.roles.add(roleId, reason);
  }

  async removeRoleFromMember(guildId: string, userId: string, roleId: string, reason?: string): Promise<void> {
    const g = await this.fetchGuild(guildId);
    const member = await g.members.fetch(userId).catch(() => null);
    if (!member) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `Member not found: ${userId}`,
        retryable: false,
      });
    }
    await member.roles.remove(roleId, reason);
  }

  /**
   * Отправляет сообщение с embeds и components в канал
   */
  async sendMessage(params: {
    guildId: string;
    channelId: string;
    options: MessageOptions;
    ctx?: RequestContext;
  }): Promise<{ messageId: string }> {
    const g = await this.fetchGuild(params.guildId);
    const ch = await g.channels.fetch(params.channelId).catch(() => null);
    if (!ch || ch.type !== DjsChannelType.GuildText) {
      throw new AppError({ code: "NOT_FOUND", message: `Text channel not found: ${params.channelId}` });
    }

    const channel = ch as TextChannel;
    const message = await channel.send(params.options);
    return { messageId: message.id };
  }

  /**
   * Обновляет существующее сообщение с embeds и components
   */
  async updateMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    options: MessageEditOptions;
    ctx?: RequestContext;
  }): Promise<{ messageId: string }> {
    const g = await this.fetchGuild(params.guildId);
    const ch = await g.channels.fetch(params.channelId).catch(() => null);
    if (!ch || ch.type !== DjsChannelType.GuildText) {
      throw new AppError({ code: "NOT_FOUND", message: `Text channel not found: ${params.channelId}` });
    }

    const channel = ch as TextChannel;
    const message = await channel.messages.fetch(params.messageId).catch(() => null);
    if (!message) {
      throw new AppError({ code: "NOT_FOUND", message: `Message not found: ${params.messageId}` });
    }

    await message.edit(params.options);
    return { messageId: message.id };
  }

  /**
   * Идемпотентная публикация/обновление сообщения с embeds и components по ключу
   */
  async ensureMessageWithEmbed(params: {
    guildId: string;
    channelId: string;
    messageKey: string;
    embeds: EmbedBuilder[];
    components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
    content?: string;
    existingMessageId?: string;
    ctx: RequestContext;
  }): Promise<{ messageId: string; changed: boolean }> {
    const g = await this.fetchGuild(params.guildId);
    const ch = await g.channels.fetch(params.channelId).catch(() => null);
    if (!ch || ch.type !== DjsChannelType.GuildText) {
      throw new AppError({ code: "NOT_FOUND", message: `Text channel not found: ${params.channelId}` });
    }

    const channel = ch as TextChannel;
    const marker = `〔${params.messageKey}〕`;
    const content = params.content ? `${params.content}\n\n${marker}` : marker;

    // Пытаемся найти существующее сообщение
    let msg = params.existingMessageId
      ? await channel.messages.fetch(params.existingMessageId).catch(() => null)
      : null;

    if (!msg) {
      // Adoption: ищем маркер среди последних сообщений
      const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
      if (recent) {
        const matches = [...recent.values()].filter((m) => (m.content ?? "").includes(marker));
        if (matches.length === 1) msg = matches[0]!;
        if (matches.length > 1) {
          throw new AppError({
            code: "CONFLICT",
            message: `Multiple messages match key ${params.messageKey} in channel ${params.channelId}`,
          });
        }
      }
    }

    const messageOptions: MessageOptions | MessageEditOptions = {
      embeds: params.embeds,
      components: params.components ?? [],
      content,
    };

    if (!msg) {
      // Создаём новое сообщение
      const created = await channel.send(messageOptions as MessageOptions);
      return { messageId: created.id, changed: true };
    }

    // Обновляем существующее сообщение
    // Проверяем, нужно ли обновлять (сравниваем основные поля)
    const needsUpdate =
      JSON.stringify(msg.embeds.map((e) => e.toJSON())) !== JSON.stringify(params.embeds.map((e) => e.toJSON())) ||
      JSON.stringify(msg.components.map((c) => c.toJSON())) !==
        JSON.stringify((params.components ?? []).map((c) => c.toJSON())) ||
      msg.content !== content;

    if (!needsUpdate) {
      return { messageId: msg.id, changed: false };
    }

    await msg.edit(messageOptions as MessageEditOptions);
    return { messageId: msg.id, changed: true };
  }
}

