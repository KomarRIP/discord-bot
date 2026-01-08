import { z } from "zod";
const TemplateMetaSchema = z.object({
    displayName: z.string().min(1),
    language: z.string().min(1).default("ru-RU"),
});
const RoleSpecSchema = z.object({
    key: z.string().min(1),
    type: z.enum(["base", "rank", "position", "clearance", "system"]),
    name: z.string().min(1),
    color: z.number().int().min(0).max(0xffffff).optional(),
    hoist: z.boolean().optional(),
    mentionable: z.boolean().optional(),
});
const ChannelSpecSchema = z.object({
    key: z.string().min(1),
    type: z.enum(["category", "text"]),
    name: z.string().min(1),
    parentKey: z.string().min(1).optional(),
    topic: z.string().optional(),
    policyKey: z.string().min(1),
});
const PrincipalSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("everyone") }),
    z.object({ type: z.literal("role"), roleKey: z.string().min(1) }),
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
    templateId: z.string().min(1),
    schemaVersion: z.string().min(1),
    templateVersion: z.string().min(1),
    meta: TemplateMetaSchema,
    roles: z.array(RoleSpecSchema).min(1),
    channels: z.array(ChannelSpecSchema).min(1),
    policies: z.record(z.string().min(1), PolicySchema),
});
export function validateTemplateConfig(config) {
    const parsed = TemplateConfigSchema.parse(config);
    // Базовые валидации ссылок/уникальности согласно deployment.md/permissions.md
    const roleKeys = new Set();
    for (const r of parsed.roles) {
        if (roleKeys.has(r.key))
            throw new Error(`Template validation failed: duplicate role key ${r.key}`);
        roleKeys.add(r.key);
    }
    const channelKeys = new Set();
    for (const ch of parsed.channels) {
        if (channelKeys.has(ch.key))
            throw new Error(`Template validation failed: duplicate channel key ${ch.key}`);
        channelKeys.add(ch.key);
    }
    for (const ch of parsed.channels) {
        if (ch.parentKey && !channelKeys.has(ch.parentKey)) {
            throw new Error(`Template validation failed: channel ${ch.key} refers missing parentKey ${ch.parentKey}`);
        }
        if (!(ch.policyKey in parsed.policies)) {
            throw new Error(`Template validation failed: channel ${ch.key} refers missing policyKey ${ch.policyKey}`);
        }
    }
    for (const [policyKey, policy] of Object.entries(parsed.policies)) {
        const seen = new Set();
        for (const rule of policy.rules) {
            if (rule.principal.type === "role" && !roleKeys.has(rule.principal.roleKey)) {
                throw new Error(`Template validation failed: policy ${policyKey} refers missing roleKey ${rule.principal.roleKey}`);
            }
            for (const perm of rule.permissions) {
                const k = `${rule.principal.type}:${rule.principal.type === "role" ? rule.principal.roleKey : "everyone"}:${perm}`;
                if (seen.has(k))
                    continue;
                seen.add(k);
            }
        }
    }
    // Конфликт allow/deny для одного principal+permission: считаем ошибкой (permissions.md)
    for (const [policyKey, policy] of Object.entries(parsed.policies)) {
        const byPrincipalPerm = new Map();
        for (const rule of policy.rules) {
            const principal = rule.principal.type === "everyone" ? "everyone" : `role:${rule.principal.roleKey}`;
            for (const perm of rule.permissions) {
                const key = `${principal}:${perm}`;
                const prev = byPrincipalPerm.get(key);
                if (prev && prev !== rule.effect) {
                    throw new Error(`Template validation failed: policy ${policyKey} has both allow and deny for ${key}`);
                }
                byPrincipalPerm.set(key, rule.effect);
            }
        }
    }
    return parsed;
}
