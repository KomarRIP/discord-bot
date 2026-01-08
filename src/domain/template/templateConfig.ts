import { z } from "zod";
import type {
  ChannelKey,
  ChannelType,
  PolicyKey,
  RoleKey,
  RoleType,
  SchemaVersion,
  TemplateId,
  TemplateVersion,
} from "./types.js";

const TemplateMetaSchema = z.object({
  displayName: z.string().min(1),
  language: z.string().min(1).default("ru-RU"),
});

const RoleSpecSchema = z.object({
  key: z.string().min(1) satisfies z.ZodType<RoleKey>,
  type: z.enum(["base", "rank", "position", "clearance", "system"]) satisfies z.ZodType<RoleType>,
  name: z.string().min(1),
  color: z.number().int().min(0).max(0xffffff).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

const ChannelSpecSchema = z.object({
  key: z.string().min(1) satisfies z.ZodType<ChannelKey>,
  type: z.enum(["category", "text"]) satisfies z.ZodType<ChannelType>,
  name: z.string().min(1),
  parentKey: z.string().min(1).optional() satisfies z.ZodType<ChannelKey | undefined>,
  topic: z.string().optional(),
  policyKey: z.string().min(1) satisfies z.ZodType<PolicyKey>,
});

const PrincipalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("everyone") }),
  z.object({ type: z.literal("role"), roleKey: z.string().min(1) satisfies z.ZodType<RoleKey> }),
]);

const PolicyRuleSchema = z.object({
  principal: PrincipalSchema,
  effect: z.enum(["allow", "deny"]),
  permissions: z.array(z.string().min(1)).min(1),
});

const PolicySchema = z.object({
  rules: z.array(PolicyRuleSchema).min(1),
});

export const TemplateConfigSchema = z.object({
  templateId: z.string().min(1) satisfies z.ZodType<TemplateId>,
  schemaVersion: z.string().min(1) satisfies z.ZodType<SchemaVersion>,
  templateVersion: z.string().min(1) satisfies z.ZodType<TemplateVersion>,
  meta: TemplateMetaSchema,
  roles: z.array(RoleSpecSchema).min(1),
  channels: z.array(ChannelSpecSchema).min(1),
  policies: z.record(z.string().min(1), PolicySchema),
});

export type TemplateConfig = z.infer<typeof TemplateConfigSchema>;
export type RoleSpec = z.infer<typeof RoleSpecSchema>;
export type ChannelSpec = z.infer<typeof ChannelSpecSchema>;
export type Policy = z.infer<typeof PolicySchema>;

export function validateTemplateConfig(config: unknown): TemplateConfig {
  const parsed = TemplateConfigSchema.parse(config);

  // Базовые валидации ссылок/уникальности согласно deployment.md/permissions.md
  const roleKeys = new Set<string>();
  for (const r of parsed.roles) {
    if (roleKeys.has(r.key)) throw new Error(`Template validation failed: duplicate role key ${r.key}`);
    roleKeys.add(r.key);
  }

  const channelKeys = new Set<string>();
  for (const ch of parsed.channels) {
    if (channelKeys.has(ch.key)) throw new Error(`Template validation failed: duplicate channel key ${ch.key}`);
    channelKeys.add(ch.key);
  }

  for (const ch of parsed.channels) {
    if (ch.parentKey && !channelKeys.has(ch.parentKey)) {
      throw new Error(
        `Template validation failed: channel ${ch.key} refers missing parentKey ${ch.parentKey}`,
      );
    }
    if (!(ch.policyKey in parsed.policies)) {
      throw new Error(
        `Template validation failed: channel ${ch.key} refers missing policyKey ${ch.policyKey}`,
      );
    }
  }

  for (const [policyKey, policy] of Object.entries(parsed.policies)) {
    const seen = new Set<string>();
    for (const rule of policy.rules) {
      if (rule.principal.type === "role" && !roleKeys.has(rule.principal.roleKey)) {
        throw new Error(
          `Template validation failed: policy ${policyKey} refers missing roleKey ${rule.principal.roleKey}`,
        );
      }
      for (const perm of rule.permissions) {
        const k = `${rule.principal.type}:${rule.principal.type === "role" ? rule.principal.roleKey : "everyone"}:${perm}`;
        if (seen.has(k)) continue;
        seen.add(k);
      }
    }
  }

  // Конфликт allow/deny для одного principal+permission: считаем ошибкой (permissions.md)
  for (const [policyKey, policy] of Object.entries(parsed.policies)) {
    const byPrincipalPerm = new Map<string, "allow" | "deny">();
    for (const rule of policy.rules) {
      const principal =
        rule.principal.type === "everyone" ? "everyone" : `role:${rule.principal.roleKey}`;
      for (const perm of rule.permissions) {
        const key = `${principal}:${perm}`;
        const prev = byPrincipalPerm.get(key);
        if (prev && prev !== rule.effect) {
          throw new Error(
            `Template validation failed: policy ${policyKey} has both allow and deny for ${key}`,
          );
        }
        byPrincipalPerm.set(key, rule.effect);
      }
    }
  }

  return parsed;
}

