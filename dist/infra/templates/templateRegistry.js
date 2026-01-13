import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateTemplateConfig } from "../../domain/template/templateConfig.js";
export class TemplateRegistry {
    templatesPath;
    cache = new Map();
    constructor(templatesPath) {
        this.templatesPath = templatesPath;
    }
    async listTemplates() {
        const files = (await readdir(this.templatesPath)).filter((f) => f.endsWith(".json")).sort();
        const metas = [];
        for (const f of files) {
            const full = path.join(this.templatesPath, f);
            const raw = await readFile(full, "utf-8");
            const cfg = validateTemplateConfig(JSON.parse(raw));
            metas.push({
                templateId: cfg.templateId,
                schemaVersion: cfg.schemaVersion,
                templateVersion: cfg.templateVersion,
                displayName: cfg.meta.displayName,
                language: cfg.meta.language,
            });
            this.cache.set(cfg.templateId, cfg);
        }
        return metas;
    }
    async getTemplate(templateId) {
        const cached = this.cache.get(templateId);
        if (cached)
            return cached;
        const files = (await readdir(this.templatesPath)).filter((f) => f.endsWith(".json"));
        const file = files.find((f) => f.replace(/\.json$/i, "") === templateId || f === `${templateId}.json`);
        if (!file)
            throw new Error(`Template not found: ${templateId}`);
        const full = path.join(this.templatesPath, file);
        const raw = await readFile(full, "utf-8");
        const cfg = validateTemplateConfig(JSON.parse(raw));
        this.cache.set(cfg.templateId, cfg);
        return cfg;
    }
}
