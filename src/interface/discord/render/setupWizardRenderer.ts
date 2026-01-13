import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type APIEmbedField,
} from "discord.js";
import type { DeploymentPreviewDto } from "../../../app/services/templateDeploymentService.js";
import type { SetupWizardStateDto, SetupWizardStepKey } from "../../../app/services/setupWizardService.js";
import { encodeCustomId } from "../customId.js";

const PREVIEW_PAGE_SIZE = 10;

function stepIndex(stepKey: SetupWizardStepKey): number {
  const order: SetupWizardStepKey[] = ["template", "unit_name", "unit_size", "intake_mode", "guest_policy", "preview"];
  const idx = order.indexOf(stepKey);
  return idx >= 0 ? idx + 1 : 1;
}

function stepTitle(stepKey: SetupWizardStepKey): string {
  switch (stepKey) {
    case "template":
      return "Шаблон";
    case "unit_name":
      return "Имя подразделения";
    case "unit_size":
      return "Размер и лимиты";
    case "intake_mode":
      return "Режим приёма";
    case "guest_policy":
      return "Политика гостя";
    case "preview":
      return "Preview и подтверждение";
  }
}

function stepHint(stepKey: SetupWizardStepKey): string {
  switch (stepKey) {
    case "template":
      return "В MVP доступен один шаблон: **SSO_RF**.";
    case "unit_name":
      return "Укажите отображаемое имя подразделения (используется в текстах/заголовках).";
    case "unit_size":
      return "Укажите примерный размер и лимит должностей на одного участника.";
    case "intake_mode":
      return "В MVP режим приёма фиксирован: **gated** (через очередь/подтверждение).";
    case "guest_policy":
      return "В MVP политика гостя фиксирована шаблоном (можно расширить в фазе 2).";
    case "preview":
      return "Проверьте план изменений. Нажмите **Confirm & Apply** чтобы развернуть структуру на сервере.";
  }
}

function summaryFields(state: SetupWizardStateDto): APIEmbedField[] {
  return [
    { name: "Template", value: `\`${state.answers.templateId}\``, inline: true },
    { name: "Unit", value: `\`${state.answers.unit.name}\``, inline: true },
    { name: "Size", value: `${state.answers.unit.size}`, inline: true },
    { name: "Positions per member", value: `${state.answers.unit.positionsLimitPerMember}`, inline: true },
    { name: "Intake mode", value: `\`${state.answers.unit.intakeMode}\``, inline: true },
    { name: "Log channel key", value: `\`${state.answers.security.logChannelKey}\``, inline: true },
  ];
}

export function buildSetupWizardMessage(params: { state: SetupWizardStateDto }) {
  const { state } = params;
  const embed = new EmbedBuilder()
    .setTitle(`Setup Wizard — шаг ${stepIndex(state.stepKey)}/6: ${stepTitle(state.stepKey)}`)
    .setDescription(stepHint(state.stepKey))
    .addFields(summaryFields(state))
    .setFooter({ text: `sessionId=${state.sessionId} • status=${state.status} • expiresAt=${state.expiresAt}` });

  const canEdit = state.stepKey === "unit_name" || state.stepKey === "unit_size";
  const editField = state.stepKey === "unit_name" ? "unit_name" : state.stepKey === "unit_size" ? "unit_size" : "none";

  const backBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "back", version: "v1", sessionId: state.sessionId }))
    .setLabel("Back")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(state.stepKey === "template" || state.status === "deploying");

  const editBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "edit", version: "v1", sessionId: state.sessionId, field: editField }))
    .setLabel("Изменить")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(!canEdit || state.status === "deploying");

  const nextBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "next", version: "v1", sessionId: state.sessionId }))
    .setLabel("Next")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(state.stepKey === "preview" || state.status === "deploying");

  const cancelBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "cancel", version: "v1", sessionId: state.sessionId }))
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(state.status === "deploying");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(backBtn, editBtn, nextBtn, cancelBtn);

  return { embeds: [embed], components: [row] } as const;
}

function formatCounts(c: { create: number; update: number; skip: number }) {
  return `создать: ${c.create}, обновить: ${c.update}, пропустить: ${c.skip}`;
}

export function buildSetupWizardPreviewMessage(params: { state: SetupWizardStateDto; preview: DeploymentPreviewDto; page: number }) {
  const page = Math.max(1, params.page);
  const items = params.preview.items;
  const totalPages = Math.max(1, Math.ceil(items.length / PREVIEW_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const start = (safePage - 1) * PREVIEW_PAGE_SIZE;
  const slice = items.slice(start, start + PREVIEW_PAGE_SIZE);

  const fields: APIEmbedField[] = [
    { name: "Setup", value: `Шаг ${stepIndex(params.state.stepKey)}/6 • sessionId=\`${params.state.sessionId}\``, inline: false },
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
    .setCustomId(
      encodeCustomId({ ns: "wizard", action: "preview", version: "v1", sessionId: params.state.sessionId, page: Math.max(1, safePage - 1) }),
    )
    .setLabel("Назад")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage <= 1);

  const nextBtn = new ButtonBuilder()
    .setCustomId(
      encodeCustomId({
        ns: "wizard",
        action: "preview",
        version: "v1",
        sessionId: params.state.sessionId,
        page: Math.min(totalPages, safePage + 1),
      }),
    )
    .setLabel("Далее")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(safePage >= totalPages);

  const backWizardBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "back", version: "v1", sessionId: params.state.sessionId }))
    .setLabel("Back")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(params.state.status === "deploying");

  const confirmBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "confirm", version: "v1", sessionId: params.state.sessionId }))
    .setLabel("Confirm & Apply")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(params.state.status === "deploying");

  const cancelBtn = new ButtonBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "cancel", version: "v1", sessionId: params.state.sessionId }))
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(params.state.status === "deploying");

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, nextBtn);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(backWizardBtn, confirmBtn, cancelBtn);

  return { embeds: [embed], components: [row1, row2] } as const;
}

export function buildSetupWizardModal(params: { state: SetupWizardStateDto; field: "unit_name" | "unit_size" }) {
  if (params.field === "unit_name") {
    const modal = new ModalBuilder()
      .setCustomId(encodeCustomId({ ns: "wizard", action: "modal", version: "v1", sessionId: params.state.sessionId, field: "unit_name" }))
      .setTitle("Имя подразделения");

    const input = new TextInputBuilder()
      .setCustomId("unit_name")
      .setLabel("Название")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(params.state.answers.unit.name.slice(0, 50));

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    return modal;
  }

  const modal = new ModalBuilder()
    .setCustomId(encodeCustomId({ ns: "wizard", action: "modal", version: "v1", sessionId: params.state.sessionId, field: "unit_size" }))
    .setTitle("Размер и лимиты");

  const size = new TextInputBuilder()
    .setCustomId("unit_size")
    .setLabel("Размер подразделения (5..100)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(params.state.answers.unit.size));

  const limit = new TextInputBuilder()
    .setCustomId("positions_limit")
    .setLabel("Должностей на участника (1..5)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(String(params.state.answers.unit.positionsLimitPerMember));

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(size),
    new ActionRowBuilder<TextInputBuilder>().addComponents(limit),
  );
  return modal;
}

