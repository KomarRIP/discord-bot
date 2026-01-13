import { ulid } from "ulid";
import type { CommandContextDto } from "../dto/commandContextDto.js";
import type { ResultDto } from "../dto/resultDto.js";
import type { TemplateRegistry } from "../../infra/templates/templateRegistry.js";
import type { Storage } from "../../infra/storage/sqlite/sqliteStorage.js";
import type { TemplateConfig, ChannelSpec, RoleSpec } from "../../domain/template/templateConfig.js";
import type { ChannelKey, PolicyKey, RoleKey } from "../../domain/template/types.js";
import { sha256Fingerprint } from "../../shared/crypto/fingerprint.js";
import { AppError } from "../../shared/errors/appError.js";
import { managedChannelName, managedRoleName } from "../../infra/discord/managedNames.js";
import type { DiscordGateway, RequestContext } from "../../infra/discord/discordGateway.js";
import { RateLimitQueue } from "../../infra/ratelimit/rateLimitQueue.js";
import { compilePolicy } from "../../infra/discord/permissionCompiler.js";

type DeploymentPreviewItem = {
  scope: "role" | "category" | "channel" | "overwrites" | "message";
  key: string;
  action: "create" | "update" | "skip";
  reason: string;
  managedName?: string;
};

export type DeploymentPreviewDto = {
  templateId: string;
  templateVersion: string;
  schemaVersion: string;
  deploymentConfigHash: string;
  summary: Record<string, { create: number; update: number; skip: number }>;
  warnings: string[];
  items: DeploymentPreviewItem[];
};

type PlanStep = {
  stepId: string;
  seq: number;
  scope: "role" | "category" | "channel" | "overwrites" | "message";
  kind: string;
  key: string;
  fingerprint: string;
  idempotencyKey: string;
  action: "create" | "update" | "skip";
  reason: string;
  managedName?: string;
  spec?: RoleSpec | ChannelSpec;
  policyKey?: PolicyKey;
  message?: { channelKey: ChannelKey; content: string };
};

export class TemplateDeploymentService {
  constructor(
    private readonly deps: {
      templates: TemplateRegistry;
      storage: Storage;
      discord: DiscordGateway;
      queue: RateLimitQueue;
      botAdminRoleKey?: string;
    },
  ) {}

  async preview(ctx: CommandContextDto): Promise<ResultDto<DeploymentPreviewDto>> {
    const { template, configHash } = await this.loadInputs(ctx);
    const plan = await this.buildPlan(ctx, template, configHash);
    const warnings = await this.computeWarnings(ctx, template);

    const summary = this.summarize(plan);
    return {
      type: "success",
      title: "Deploy preview",
      message: `template=${template.templateId}@${template.templateVersion}, schema=${template.schemaVersion}`,
      data: {
        templateId: template.templateId,
        templateVersion: template.templateVersion,
        schemaVersion: template.schemaVersion,
        deploymentConfigHash: configHash,
        summary,
        warnings,
        items: plan.map((p) => ({
          scope: p.scope,
          key: p.key,
          action: p.action,
          reason: p.reason,
          managedName: p.managedName,
        })),
      },
    };
  }

  async apply(ctx: CommandContextDto): Promise<ResultDto<{ deploymentId: string }>> {
    const { template, configHash } = await this.loadInputs(ctx);
    const plan = await this.buildPlan(ctx, template, configHash);

    const ownerId = await this.deps.discord.getGuildOwnerId(ctx.guildId);
    const warnings = await this.computeWarnings(ctx, template);
    const hasLockoutRisk = warnings.includes("RISK_LOCKOUT");
    if (hasLockoutRisk && ctx.actorUserId !== ownerId) {
      throw new AppError({
        code: "SAFETY_LOCKOUT_RISK",
        message: "Операция может заблокировать доступ владельцу. Применение разрешено только владельцу.",
      });
    }

    const deploymentId = ulid();
    const startedAt = new Date().toISOString();
    this.deps.storage.guilds.beginDeployment({
      deploymentId,
      guildId: ctx.guildId,
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      schemaVersion: template.schemaVersion,
      configHash,
      actorUserId: ctx.actorUserId,
      startedAt,
    });

    // План -> deployment_steps
    for (const step of plan) {
      this.deps.storage.deploymentSteps.insertPlanned({
        stepId: step.stepId,
        deploymentId,
        guildId: ctx.guildId,
        seq: step.seq,
        scope: step.scope,
        kind: step.kind,
        key: step.key,
        fingerprint: step.fingerprint,
        idempotencyKey: step.idempotencyKey,
        action: step.action,
        reason: step.reason,
        plannedAt: startedAt,
      });
    }

    const requestCtx: RequestContext = {
      requestId: ctx.requestId,
      actorUserId: ctx.actorUserId,
      reason: `deploy=${deploymentId} requestId=${ctx.requestId}`,
    };

    try {
      await this.executePlan(ctx, template, deploymentId, plan, requestCtx);
      this.deps.storage.guilds.finishDeployment({
        deploymentId,
        status: "completed",
        finishedAt: new Date().toISOString(),
      });

      this.deps.storage.guilds.upsertGuildState(ctx.guildId, {
        activeTemplateId: template.templateId,
        activeTemplateVersion: template.templateVersion,
        activeSchemaVersion: template.schemaVersion,
        deploymentConfigHash: configHash,
        installedAt: startedAt,
      });

      return {
        type: "success",
        title: "Деплой завершён",
        message: `deploymentId=${deploymentId}`,
        data: { deploymentId },
      };
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError({ code: "TRANSIENT_FAILURE", message: "Deploy failed", retryable: true, details: String(e) });
      this.deps.storage.guilds.finishDeployment({
        deploymentId,
        status: "failed",
        finishedAt: new Date().toISOString(),
        errorCode: err.code,
        errorJson: JSON.stringify({ message: err.message, details: err.details }),
      });
      throw err;
    }
  }

  private async loadInputs(ctx: CommandContextDto): Promise<{ template: TemplateConfig; configHash: string }> {
    const active = this.deps.storage.setupSessions.getActiveSession(ctx.guildId);
    let templateId = "SSO_RF";
    let unitConfig: unknown = null;
    if (active) {
      try {
        const parsed = JSON.parse(active.answersJson) as Record<string, unknown>;
        if (typeof parsed.templateId === "string") templateId = parsed.templateId;
        unitConfig = parsed;
      } catch {
        unitConfig = null;
      }
    }
    const template = await this.deps.templates.getTemplate(templateId);
    const configHash = sha256Fingerprint({
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      schemaVersion: template.schemaVersion,
      roles: template.roles,
      channels: template.channels,
      policies: template.policies,
      // unitConfig (в MVP — из setup answers, но пока дефолт внутри setup)
      unitConfig,
    });
    return { template, configHash };
  }

  private roleFingerprint(spec: RoleSpec, managedName: string): string {
    return sha256Fingerprint({
      name: managedName,
      color: spec.color ?? null,
      hoist: spec.hoist ?? null,
      mentionable: spec.mentionable ?? null,
    });
  }

  private channelFingerprint(spec: ChannelSpec, managedName: string): string {
    return sha256Fingerprint({
      name: managedName,
      type: spec.type,
      topic: spec.topic ?? null,
      parentKey: spec.parentKey ?? null,
      policyKey: spec.policyKey,
    });
  }

  private overwritesFingerprint(template: TemplateConfig, policyKey: PolicyKey): string {
    const policy = template.policies[policyKey];
    return sha256Fingerprint({
      policyKey,
      rules: policy.rules.map((r) => ({
        principal: r.principal,
        effect: r.effect,
        permissions: [...r.permissions].sort(),
      })),
    });
  }

  private async buildPlan(ctx: CommandContextDto, template: TemplateConfig, configHash: string): Promise<PlanStep[]> {
    const steps: PlanStep[] = [];
    let seq = 1;
    const deploymentIdForKey = `preview:${configHash.slice(0, 8)}`;

    // roles
    for (const role of template.roles) {
      const managedName = managedRoleName(role.name, role.key);
      const fp = this.roleFingerprint(role, managedName);
      const mapping = this.deps.storage.mappings.getMapping(ctx.guildId, "role", role.key);

      let action: PlanStep["action"] = "create";
      let reason = "missing_mapping";
      if (mapping) {
        const exists = await this.deps.discord.getRoleById(ctx.guildId, mapping.discordId);
        if (!exists) {
          action = "create";
          reason = "missing_in_discord";
        } else if (mapping.fingerprint !== fp) {
          action = "update";
          reason = "fingerprint_changed";
        } else {
          action = "skip";
          reason = "unchanged";
        }
      }

      steps.push({
        stepId: ulid(),
        seq: seq++,
        scope: "role",
        kind: "RoleEnsure",
        key: role.key,
        fingerprint: fp,
        idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/RoleEnsure/${role.key}/${fp}`,
        action,
        reason,
        managedName,
        spec: role,
      });
    }

    // categories and channels in declared order (SSO_RF is already safe)
    const categories = template.channels.filter((c) => c.type === "category");
    const channels = template.channels.filter((c) => c.type === "text");

    for (const cat of categories) {
      const managedName = managedChannelName(cat.name, cat.key, cat.type);
      const fp = this.channelFingerprint(cat, managedName);
      const mapping = this.deps.storage.mappings.getMapping(ctx.guildId, "category", cat.key);

      let action: PlanStep["action"] = "create";
      let reason = "missing_mapping";
      if (mapping) {
        const exists = await this.deps.discord.getChannelById(ctx.guildId, mapping.discordId);
        if (!exists) {
          action = "create";
          reason = "missing_in_discord";
        } else if (mapping.fingerprint !== fp) {
          action = "update";
          reason = "fingerprint_changed";
        } else {
          action = "skip";
          reason = "unchanged";
        }
      }

      steps.push({
        stepId: ulid(),
        seq: seq++,
        scope: "category",
        kind: "CategoryEnsure",
        key: cat.key,
        fingerprint: fp,
        idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/CategoryEnsure/${cat.key}/${fp}`,
        action,
        reason,
        managedName,
        spec: cat,
      });

      // overwrites for category (separate step)
      const ofp = this.overwritesFingerprint(template, cat.policyKey);
      steps.push({
        stepId: ulid(),
        seq: seq++,
        scope: "overwrites",
        kind: "OverwritesReplace",
        key: cat.key,
        fingerprint: ofp,
        idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/OverwritesReplace/${cat.key}/${ofp}`,
        action: "update",
        reason: "replace",
        policyKey: cat.policyKey,
      });
    }

    for (const ch of channels) {
      const managedName = managedChannelName(ch.name, ch.key, ch.type);
      const fp = this.channelFingerprint(ch, managedName);
      const mapping = this.deps.storage.mappings.getMapping(ctx.guildId, "channel", ch.key);

      let action: PlanStep["action"] = "create";
      let reason = "missing_mapping";
      if (mapping) {
        const exists = await this.deps.discord.getChannelById(ctx.guildId, mapping.discordId);
        if (!exists) {
          action = "create";
          reason = "missing_in_discord";
        } else if (mapping.fingerprint !== fp) {
          action = "update";
          reason = "fingerprint_changed";
        } else {
          action = "skip";
          reason = "unchanged";
        }
      }

      steps.push({
        stepId: ulid(),
        seq: seq++,
        scope: "channel",
        kind: "ChannelEnsure",
        key: ch.key,
        fingerprint: fp,
        idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/ChannelEnsure/${ch.key}/${fp}`,
        action,
        reason,
        managedName,
        spec: ch,
      });

      const ofp = this.overwritesFingerprint(template, ch.policyKey);
      steps.push({
        stepId: ulid(),
        seq: seq++,
        scope: "overwrites",
        kind: "OverwritesReplace",
        key: ch.key,
        fingerprint: ofp,
        idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/OverwritesReplace/${ch.key}/${ofp}`,
        action: "update",
        reason: "replace",
        policyKey: ch.policyKey,
      });
    }

    // messages (последними, как в deployment.md)
    const msgAudit = `✅ Деплой завершён.\nШаблон: ${template.templateId}@${template.templateVersion}\nСхема: ${template.schemaVersion}`;
    steps.push({
      stepId: ulid(),
      seq: seq++,
      scope: "message",
      kind: "MessageEnsure",
      key: "MSG_AUDIT_DEPLOY_SUMMARY",
      fingerprint: sha256Fingerprint({ content: msgAudit }),
      idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/MessageEnsure/MSG_AUDIT_DEPLOY_SUMMARY/${sha256Fingerprint({ content: msgAudit })}`,
      action: "update",
      reason: "replace",
      message: { channelKey: "CH_AUDIT", content: msgAudit },
    });

    const msgIntake =
      "Чтобы подать заявку на вступление, используйте `/intake apply`.\n" +
      "Если команды ещё не включены — дождитесь завершения деплоя.";
    steps.push({
      stepId: ulid(),
      seq: seq++,
      scope: "message",
      kind: "MessageEnsure",
      key: "MSG_INTAKE_INSTRUCTIONS",
      fingerprint: sha256Fingerprint({ content: msgIntake }),
      idempotencyKey: `guild:${ctx.guildId}/deploy:${deploymentIdForKey}/MessageEnsure/MSG_INTAKE_INSTRUCTIONS/${sha256Fingerprint({ content: msgIntake })}`,
      action: "update",
      reason: "replace",
      message: { channelKey: "CH_INTAKE", content: msgIntake },
    });

    return steps;
  }

  private summarize(plan: PlanStep[]): DeploymentPreviewDto["summary"] {
    const init = () => ({ create: 0, update: 0, skip: 0 });
    const out: DeploymentPreviewDto["summary"] = {
      roles: init(),
      categories: init(),
      channels: init(),
      overwrites: init(),
    };

    for (const p of plan) {
      const bucket =
        p.scope === "role"
          ? out.roles
          : p.scope === "category"
            ? out.categories
            : p.scope === "channel"
              ? out.channels
              : out.overwrites;
      bucket[p.action] += 1;
    }
    return out;
  }

  private async computeWarnings(ctx: CommandContextDto, template: TemplateConfig): Promise<string[]> {
    // MVP safety check (preview-and-diff.md): нужен "путь управления ботом"
    const warnings: string[] = [];
    const auditChannel = template.channels.find((c) => c.key === "CH_AUDIT");
    if (!auditChannel) return warnings;

    const policy = template.policies[auditChannel.policyKey];
    const botAdminRoleKey = this.deps.botAdminRoleKey;
    if (botAdminRoleKey) {
      const hasRole = template.roles.some((r) => r.key === botAdminRoleKey);
      if (!hasRole) {
        warnings.push("RISK_LOCKOUT");
        return warnings;
      }
      const hasAllow = policy.rules.some(
        (r) => r.effect === "allow" && r.principal.type === "role" && r.principal.roleKey === botAdminRoleKey && r.permissions.includes("ViewChannel"),
      );
      if (!hasAllow) warnings.push("RISK_LOCKOUT");
    } else {
      warnings.push("RISK_LOCKOUT");
    }
    return warnings;
  }

  private classifyDiscordError(e: unknown): AppError {
    // MVP: дискорд-ошибки маппим грубо, затем уточним по мере интеграции
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("Missing Permissions") || msg.includes("Missing Access")) {
      return new AppError({ code: "FORBIDDEN", message: msg, retryable: false });
    }
    if (msg.includes("Unknown") || msg.includes("404")) {
      return new AppError({ code: "NOT_FOUND", message: msg, retryable: false });
    }
    if (msg.includes("rate limit") || msg.includes("429")) {
      return new AppError({ code: "RATE_LIMITED", message: msg, retryable: true });
    }
    return new AppError({ code: "TRANSIENT_FAILURE", message: msg, retryable: true });
  }

  private async executePlan(
    ctx: CommandContextDto,
    template: TemplateConfig,
    deploymentId: string,
    plan: PlanStep[],
    requestCtx: RequestContext,
  ): Promise<void> {
    const deadlineAt = new Date(Date.now() + 10 * 60 * 1000);
    const roleIdByKey = new Map<RoleKey, string>();
    const categoryIdByKey = new Map<ChannelKey, string>();
    const channelIdByKey = new Map<ChannelKey, string>();

    // 1) roles
    for (const step of plan.filter((p) => p.scope === "role")) {
      const role = step.spec as RoleSpec;
      const existing = this.deps.storage.mappings.getMapping(ctx.guildId, "role", role.key);
      try {
        const res = await this.deps.queue.enqueue({
          guildId: ctx.guildId,
          kind: "RoleEnsure",
          idempotencyKey: step.idempotencyKey,
          budget: { deadlineAt, maxAttempts: 8 },
          execute: async () =>
            this.deps.discord.ensureRole({
              guildId: ctx.guildId,
              name: role.name,
              managedName: step.managedName!,
              color: role.color,
              hoist: role.hoist,
              mentionable: role.mentionable,
              existingRoleId: existing?.discordId,
              ctx: requestCtx,
            }),
          classifyError: (e) => this.classifyDiscordError(e),
        });

        roleIdByKey.set(role.key, res.id);
        this.deps.storage.mappings.upsertMapping({
          guildId: ctx.guildId,
          kind: "role",
          key: role.key,
          discordId: res.id,
          fingerprint: step.fingerprint,
          managedName: step.managedName!,
        });
        this.deps.storage.deploymentSteps.markApplied({
          stepId: step.stepId,
          status: step.action === "skip" ? "skipped" : "applied",
          discordId: res.id,
          resultJson: JSON.stringify({ changed: res.changed }),
        });
      } catch (e) {
        const err = this.classifyDiscordError(e);
        this.deps.storage.deploymentSteps.markFailed({
          stepId: step.stepId,
          errorCode: err.code,
          errorJson: JSON.stringify({ message: err.message }),
        });
        throw err;
      }
    }

    // 2) categories
    for (const step of plan.filter((p) => p.scope === "category")) {
      const cat = step.spec as ChannelSpec;
      const existing = this.deps.storage.mappings.getMapping(ctx.guildId, "category", cat.key);
      try {
        const res = await this.deps.queue.enqueue({
          guildId: ctx.guildId,
          kind: "CategoryEnsure",
          idempotencyKey: step.idempotencyKey,
          budget: { deadlineAt, maxAttempts: 8 },
          execute: async () =>
            this.deps.discord.ensureCategory({
              guildId: ctx.guildId,
              name: cat.name,
              managedName: step.managedName!,
              existingCategoryId: existing?.discordId,
              ctx: requestCtx,
            }),
          classifyError: (e) => this.classifyDiscordError(e),
        });
        categoryIdByKey.set(cat.key, res.id);
        this.deps.storage.mappings.upsertMapping({
          guildId: ctx.guildId,
          kind: "category",
          key: cat.key,
          discordId: res.id,
          fingerprint: step.fingerprint,
          managedName: step.managedName!,
        });
        this.deps.storage.deploymentSteps.markApplied({
          stepId: step.stepId,
          status: step.action === "skip" ? "skipped" : "applied",
          discordId: res.id,
          resultJson: JSON.stringify({ changed: res.changed }),
        });
      } catch (e) {
        const err = this.classifyDiscordError(e);
        this.deps.storage.deploymentSteps.markFailed({
          stepId: step.stepId,
          errorCode: err.code,
          errorJson: JSON.stringify({ message: err.message }),
        });
        throw err;
      }
    }

    // 3) channels
    for (const step of plan.filter((p) => p.scope === "channel")) {
      const ch = step.spec as ChannelSpec;
      const existing = this.deps.storage.mappings.getMapping(ctx.guildId, "channel", ch.key);
      const parentId = ch.parentKey ? categoryIdByKey.get(ch.parentKey) ?? this.deps.storage.mappings.getMapping(ctx.guildId, "category", ch.parentKey)?.discordId : undefined;
      try {
        const res = await this.deps.queue.enqueue({
          guildId: ctx.guildId,
          kind: "ChannelEnsure",
          idempotencyKey: step.idempotencyKey,
          budget: { deadlineAt, maxAttempts: 8 },
          execute: async () =>
            this.deps.discord.ensureTextChannel({
              guildId: ctx.guildId,
              name: ch.name,
              managedName: step.managedName!,
              topic: ch.topic,
              parentCategoryId: parentId,
              existingChannelId: existing?.discordId,
              ctx: requestCtx,
            }),
          classifyError: (e) => this.classifyDiscordError(e),
        });
        channelIdByKey.set(ch.key, res.id);
        this.deps.storage.mappings.upsertMapping({
          guildId: ctx.guildId,
          kind: "channel",
          key: ch.key,
          discordId: res.id,
          fingerprint: step.fingerprint,
          managedName: step.managedName!,
        });
        this.deps.storage.deploymentSteps.markApplied({
          stepId: step.stepId,
          status: step.action === "skip" ? "skipped" : "applied",
          discordId: res.id,
          resultJson: JSON.stringify({ changed: res.changed }),
        });
      } catch (e) {
        const err = this.classifyDiscordError(e);
        this.deps.storage.deploymentSteps.markFailed({
          stepId: step.stepId,
          errorCode: err.code,
          errorJson: JSON.stringify({ message: err.message }),
        });
        throw err;
      }
    }

    // 4) overwrites (categories then channels; plan already ordered)
    const everyoneRoleId = await this.deps.discord.getEveryoneRoleId(ctx.guildId);
    for (const step of plan.filter((p) => p.scope === "overwrites")) {
      const key = step.key as ChannelKey;
      const targetId =
        categoryIdByKey.get(key) ??
        channelIdByKey.get(key) ??
        this.deps.storage.mappings.getMapping(ctx.guildId, "category", key)?.discordId ??
        this.deps.storage.mappings.getMapping(ctx.guildId, "channel", key)?.discordId;

      if (!targetId) {
        throw new AppError({ code: "NOT_FOUND", message: `Target for overwrites not found: ${key}` });
      }

      const overwrites = compilePolicy({
        guildEveryoneRoleId: everyoneRoleId,
        template,
        policyKey: step.policyKey!,
        roleIdByKey,
      });

      try {
        await this.deps.queue.enqueue({
          guildId: ctx.guildId,
          kind: "OverwritesReplace",
          idempotencyKey: step.idempotencyKey,
          budget: { deadlineAt, maxAttempts: 8 },
          execute: async () =>
            this.deps.discord.setPermissionOverwrites({
              guildId: ctx.guildId,
              targetChannelId: targetId,
              overwrites,
              ctx: requestCtx,
            }),
          classifyError: (e) => this.classifyDiscordError(e),
        });
        this.deps.storage.deploymentSteps.markApplied({
          stepId: step.stepId,
          status: "applied",
          discordId: targetId,
          resultJson: JSON.stringify({ replaced: true }),
        });
      } catch (e) {
        const err = this.classifyDiscordError(e);
        this.deps.storage.deploymentSteps.markFailed({
          stepId: step.stepId,
          errorCode: err.code,
          errorJson: JSON.stringify({ message: err.message }),
        });
        throw err;
      }
    }

    // 5) messages (последними)
    for (const step of plan.filter((p) => p.scope === "message")) {
      const msg = step.message!;
      const channelId =
        channelIdByKey.get(msg.channelKey) ??
        this.deps.storage.mappings.getMapping(ctx.guildId, "channel", msg.channelKey)?.discordId;
      if (!channelId) throw new AppError({ code: "NOT_FOUND", message: `Channel not found for message: ${msg.channelKey}` });

      const existing = this.deps.storage.mappings.getMapping(ctx.guildId, "message", step.key);
      try {
        const res = await this.deps.queue.enqueue({
          guildId: ctx.guildId,
          kind: "MessageEnsure",
          idempotencyKey: step.idempotencyKey,
          budget: { deadlineAt, maxAttempts: 8 },
          execute: async () =>
            this.deps.discord.ensureMessage({
              guildId: ctx.guildId,
              channelId,
              messageKey: step.key,
              content: msg.content,
              existingMessageId: existing?.discordId,
              ctx: requestCtx,
            }),
          classifyError: (e) => this.classifyDiscordError(e),
        });

        this.deps.storage.mappings.upsertMapping({
          guildId: ctx.guildId,
          kind: "message",
          key: step.key,
          discordId: res.messageId,
          fingerprint: step.fingerprint,
          managedName: `〔${step.key}〕`,
        });

        this.deps.storage.deploymentSteps.markApplied({
          stepId: step.stepId,
          status: "applied",
          discordId: res.messageId,
          resultJson: JSON.stringify({ changed: res.changed, channelId }),
        });
      } catch (e) {
        const err = this.classifyDiscordError(e);
        this.deps.storage.deploymentSteps.markFailed({
          stepId: step.stepId,
          errorCode: err.code,
          errorJson: JSON.stringify({ message: err.message }),
        });
        throw err;
      }
    }

    // audit event (storage)
    this.deps.storage.audit.insert({
      eventId: ulid(),
      guildId: ctx.guildId,
      deploymentId,
      actorUserId: ctx.actorUserId,
      type: "DeploymentCompleted",
      payloadJson: JSON.stringify({ templateId: template.templateId, templateVersion: template.templateVersion }),
      createdAt: new Date().toISOString(),
    });
  }
}

