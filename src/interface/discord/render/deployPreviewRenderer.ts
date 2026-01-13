import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type APIEmbedField,
} from "discord.js";
import type { DeploymentPreviewDto } from "../../../app/services/templateDeploymentService.js";
import { encodeCustomId } from "../customId.js";

const PAGE_SIZE = 10;

function formatCounts(c: { create: number; update: number; skip: number }) {
  return `создать: ${c.create}, обновить: ${c.update}, пропустить: ${c.skip}`;
}

export function buildDeployPreviewMessage(params: { preview: DeploymentPreviewDto; page: number }) {
  const page = Math.max(1, params.page);
  const items = params.preview.items;
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const start = (safePage - 1) * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  const fields: APIEmbedField[] = [
    {
      name: "Шаблон",
      value: `${params.preview.templateId}@${params.preview.templateVersion} (schema ${params.preview.schemaVersion})`,
      inline: false,
    },
    {
      name: "Summary",
      value:
        `**roles**: ${formatCounts(params.preview.summary.roles)}\n` +
        `**categories**: ${formatCounts(params.preview.summary.categories)}\n` +
        `**channels**: ${formatCounts(params.preview.summary.channels)}\n` +
        `**overwrites**: ${formatCounts(params.preview.summary.overwrites)}`,
      inline: false,
    },
  ];

  if (params.preview.warnings.length > 0) {
    fields.push({
      name: "Warnings",
      value: params.preview.warnings.map((w) => `- ${w}`).join("\n"),
      inline: false,
    });
  }

  const details =
    slice.length === 0
      ? "Нет шагов."
      : slice
          .map((it) => {
            const name = it.scope === "overwrites" ? `overwrites:${it.key}` : `${it.scope}:${it.key}`;
            const extra = it.managedName ? ` → ${it.managedName}` : "";
            return `- **${it.action.toUpperCase()}** ${name} (${it.reason})${extra}`;
          })
          .join("\n");

  fields.push({
    name: `Детали (стр. ${safePage}/${totalPages})`,
    value: details.slice(0, 1024),
    inline: false,
  });

  const embed = new EmbedBuilder()
    .setTitle("Deployment preview")
    .addFields(fields)
    .setFooter({ text: `configHash=${params.preview.deploymentConfigHash}` });

  const prevBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "deploy", action: "preview", version: "v1", page: Math.max(1, safePage - 1) }))
    .setLabel("Назад")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 1);

  const nextBtn = new ButtonBuilder()
    .setCustomId(
      encodeCustomId({ ns: "deploy", action: "preview", version: "v1", page: Math.min(totalPages, safePage + 1) }),
    )
    .setLabel("Далее")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages);

  const applyBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "deploy", action: "apply", version: "v1" }))
    .setLabel("Apply")
    .setStyle(ButtonStyle.Danger);

  const cancelBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "deploy", action: "cancel", version: "v1" }))
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn, applyBtn, cancelBtn);

  return {
    embeds: [embed],
    components: [row],
  } as const;
}

