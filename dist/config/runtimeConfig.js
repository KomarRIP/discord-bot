import { readFile } from "node:fs/promises";
import { z } from "zod";
const RuntimeConfigSchema = z.object({
    templatesPath: z.string().min(1),
    defaultLocale: z.string().min(1).default("ru-RU"),
    botAdminRoleKey: z.string().min(1).optional(),
    rateLimit: z
        .object({
        maxGuildConcurrency: z.number().int().min(1).default(1),
        maxGlobalConcurrency: z.number().int().min(1).default(3),
        operationDeadlineSeconds: z.number().int().min(1).default(600),
    })
        .default({
        maxGuildConcurrency: 1,
        maxGlobalConcurrency: 3,
        operationDeadlineSeconds: 600,
    }),
    features: z
        .object({
        enablePrune: z.boolean().default(false),
        enableDMNotifications: z.boolean().default(false),
    })
        .default({
        enablePrune: false,
        enableDMNotifications: false,
    }),
});
export async function loadRuntimeConfig(path) {
    const raw = await readFile(path, "utf-8");
    const json = JSON.parse(raw);
    return RuntimeConfigSchema.parse(json);
}
