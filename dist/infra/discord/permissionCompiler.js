import { OverwriteType, PermissionFlagsBits } from "discord.js";
import { AppError } from "../../shared/errors/appError.js";
const PermissionNameToFlag = {
    ViewChannel: PermissionFlagsBits.ViewChannel,
    ReadMessageHistory: PermissionFlagsBits.ReadMessageHistory,
    SendMessages: PermissionFlagsBits.SendMessages,
    ManageChannels: PermissionFlagsBits.ManageChannels,
    ManageRoles: PermissionFlagsBits.ManageRoles,
    ManageMessages: PermissionFlagsBits.ManageMessages,
    EmbedLinks: PermissionFlagsBits.EmbedLinks,
};
export function compilePolicy(params) {
    const policy = params.template.policies[params.policyKey];
    if (!policy) {
        throw new AppError({
            code: "VALIDATION_FAILED",
            message: `Unknown policyKey: ${params.policyKey}`,
        });
    }
    const byPrincipal = new Map();
    for (const rule of policy.rules) {
        const id = rule.principal.type === "everyone"
            ? params.guildEveryoneRoleId
            : params.roleIdByKey.get(rule.principal.roleKey);
        if (!id) {
            throw new AppError({
                code: "VALIDATION_FAILED",
                message: `RoleId not resolved for roleKey ${rule.principal.type === "role" ? rule.principal.roleKey : "@everyone"}`,
            });
        }
        const entry = byPrincipal.get(id) ?? { allow: 0n, deny: 0n, type: OverwriteType.Role };
        for (const perm of rule.permissions) {
            const bit = PermissionNameToFlag[perm];
            if (!bit) {
                throw new AppError({
                    code: "VALIDATION_FAILED",
                    message: `Unknown permission in policy ${params.policyKey}: ${perm}`,
                });
            }
            if (rule.effect === "allow")
                entry.allow |= bit;
            else
                entry.deny |= bit;
        }
        byPrincipal.set(id, entry);
    }
    return [...byPrincipal.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, v]) => ({
        id,
        type: v.type,
        allow: v.allow,
        deny: v.deny,
    }));
}
