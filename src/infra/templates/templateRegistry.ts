import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validateTemplateConfig, type TemplateConfig } from "../../domain/template/templateConfig.js";
import type { TemplateId } from "../../domain/template/types.js";

export type TemplateMeta = {
  templateId: string;
  schemaVersion: string;
  templateVersion: string;
  displayName: string;
  language: string;
};

export class TemplateRegistry {
  private cache = new Map<TemplateId, TemplateConfig>();

  constructor(private readonly templatesPath: string) {}

  async listTemplates(): Promise<TemplateMeta[]> {
    const files = (await readdir(this.templatesPath)).filter((f) => f.endsWith(".json")).sort();
    const metas: TemplateMeta[] = [];
    for (const f of files) {
      const full = path.join(this.templatesPath, f);
      const raw = await readFile(full, "utf-8");
      const cfg = validateTemplateConfig(JSON.parse(raw) as unknown);
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

  async getTemplate(templateId: TemplateId): Promise<TemplateConfig> {
    const cached = this.cache.get(templateId);
    if (cached) return cached;

    const files = (await readdir(this.templatesPath)).filter((f) => f.endsWith(".json"));
    const file = files.find((f) => f.replace(/\.json$/i, "") === templateId || f === `${templateId}.json`);
    if (!file) throw new Error(`Template not found: ${templateId}`);

    const full = path.join(this.templatesPath, file);
    const raw = await readFile(full, "utf-8");
    const cfg = validateTemplateConfig(JSON.parse(raw) as unknown);
    this.cache.set(cfg.templateId, cfg);
    return cfg;
  }
}

