import {
  ChannelType as DjsChannelType,
  Client,
  Guild,
  GuildBasedChannel,
  type OverwriteResolvable,
  Role,
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
      return {
        channelId: ch.id,
        name: ch.name,
        type: "text",
        parentId: ch.parentId ?? null,
        topic: (ch as any).topic ?? null,
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

    const patch: Record<string, unknown> = {};
    if (ch.name !== params.managedName) patch.name = params.managedName;
    if ((ch as any).topic !== (params.topic ?? null)) patch.topic = params.topic ?? null;
    if (params.parentCategoryId !== undefined && ch.parentId !== params.parentCategoryId)
      patch.parent = params.parentCategoryId;

    if (Object.keys(patch).length === 0) return { id: ch.id, changed: false };
    const updated = await ch.edit({
      ...(patch as any),
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
    await (ch as any).permissionOverwrites.set(params.overwrites, params.ctx.reason ?? `requestId=${params.ctx.requestId}`);
    return { changed: true };
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
    const matches = guild.channels.cache.filter((c) => c.type === type && (c as any).name === managedName);
    if (matches.size === 1) return matches.first() ?? null;
    if (matches.size > 1) {
      throw new AppError({
        code: "CONFLICT",
        message: `Multiple channels match managed name: ${managedName}`,
      });
    }
    return null;
  }
}

