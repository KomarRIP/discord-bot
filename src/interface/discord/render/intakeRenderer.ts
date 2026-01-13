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
import type { ApplicationDto } from "../../../app/services/intakeService.js";
import { encodeCustomId } from "../customId.js";

function statusEmoji(status: ApplicationDto["status"]): string {
  switch (status) {
    case "draft":
      return "📝";
    case "submitted":
      return "⏳";
    case "under_review":
      return "👀";
    case "approved":
      return "✅";
    case "rejected":
      return "❌";
    case "cancelled":
      return "🚫";
  }
}

function statusLabel(status: ApplicationDto["status"]): string {
  switch (status) {
    case "draft":
      return "Черновик";
    case "submitted":
      return "Подана";
    case "under_review":
      return "В рассмотрении";
    case "approved":
      return "Одобрена";
    case "rejected":
      return "Отклонена";
    case "cancelled":
      return "Отменена";
  }
}

export function buildApplicationEmbed(application: ApplicationDto): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(`${statusEmoji(application.status)} Заявка ${application.applicationId.slice(0, 8)}`)
    .setDescription(`**Статус:** ${statusLabel(application.status)}`)
    .addFields(
      {
        name: "Подана пользователем",
        value: `<@${application.applicantUserId}>`,
        inline: true,
      },
      {
        name: "Тип",
        value: application.type === "join" ? "Вступление" : application.type,
        inline: true,
      },
      {
        name: "Создана",
        value: `<t:${Math.floor(new Date(application.createdAt).getTime() / 1000)}:R>`,
        inline: true,
      },
    )
    .setTimestamp(new Date(application.createdAt));

  // Добавляем поля из payload
  const payload = application.payload;
  embed.addFields(
    { name: "Позывной", value: payload.nickname || "—", inline: true },
    { name: "Возраст", value: String(payload.age || "—"), inline: true },
    { name: "Часовой пояс", value: payload.timezone || "—", inline: true },
    { name: "Доступность", value: payload.availability || "—", inline: false },
    { name: "Опыт в Arma", value: payload.armaExperience?.slice(0, 1024) || "—", inline: false },
    { name: "Опыт в милсиме", value: payload.milsimExperience?.slice(0, 1024) || "—", inline: false },
    { name: "Микрофон и моды", value: payload.micAndMods || "—", inline: false },
    { name: "Мотивация", value: payload.whyUnit?.slice(0, 1024) || "—", inline: false },
  );

  // Если есть решение
  if (application.decisionByUserId && application.decisionAt) {
    embed.addFields({
      name: "Решение",
      value: `**${application.status === "approved" ? "Одобрено" : "Отклонено"}** <@${application.decisionByUserId}>\n<t:${Math.floor(new Date(application.decisionAt).getTime() / 1000)}:R>`,
      inline: false,
    });
    if (application.decisionReason) {
      embed.addFields({
        name: "Причина",
        value: application.decisionReason.slice(0, 1024),
        inline: false,
      });
    }
  }

  // Цвет в зависимости от статуса
  switch (application.status) {
    case "approved":
      embed.setColor(0x57f287); // Зелёный
      break;
    case "rejected":
      embed.setColor(0xed4245); // Красный
      break;
    case "submitted":
    case "under_review":
      embed.setColor(0xfee75c); // Жёлтый
      break;
    default:
      embed.setColor(0x95a5a6); // Серый
  }

  return embed;
}

export function buildApplicationQueueMessage(application: ApplicationDto, isStaff: boolean): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = buildApplicationEmbed(application);

  const components: ActionRowBuilder<ButtonBuilder>[] = [];

  if (isStaff && (application.status === "submitted" || application.status === "under_review")) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ ns: "intake", action: "approve", version: "v1", applicationId: application.applicationId }))
        .setLabel("Одобрить")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ ns: "intake", action: "reject", version: "v1", applicationId: application.applicationId }))
        .setLabel("Отклонить")
        .setStyle(ButtonStyle.Danger),
    );
    components.push(row);
  }

  if (application.applicantUserId && application.status === "draft") {
    const row = new ActionRowBuilder<ButtonBuilder>();
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ ns: "intake", action: "submit", version: "v1", applicationId: application.applicationId }))
        .setLabel("Подать на рассмотрение")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(encodeCustomId({ ns: "intake", action: "cancel", version: "v1", applicationId: application.applicationId }))
        .setLabel("Отменить")
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  }

  return { embeds: [embed], components };
}

export function buildApplicationListMessage(applications: ApplicationDto[]): {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  if (applications.length === 0) {
    return {
      content: "**Список заявок**\nЗаявок не найдено.",
      embeds: [],
      components: [],
    };
  }

  const embeds: EmbedBuilder[] = [];
  const chunks: ApplicationDto[][] = [];

  // Разбиваем на чанки по 10 заявок (лимит embeds в сообщении)
  for (let i = 0; i < applications.length; i += 10) {
    chunks.push(applications.slice(i, i + 10));
  }

  for (const chunk of chunks) {
    const embed = new EmbedBuilder().setTitle(`Заявки (${applications.length} всего)`).setDescription(
      chunk
        .map(
          (app) =>
            `${statusEmoji(app.status)} \`${app.applicationId.slice(0, 8)}\` <@${app.applicantUserId}> — ${statusLabel(app.status)}`,
        )
        .join("\n"),
    );
    embeds.push(embed);
  }

  return {
    content: `**Список заявок** (${applications.length} найдено)`,
    embeds,
    components: [],
  };
}

export function buildApplicationModal(): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(encodeCustomId({ ns: "intake", action: "modal", version: "v1" })).setTitle("Подать заявку на вступление");

  const nicknameInput = new TextInputBuilder()
    .setCustomId("nickname")
    .setLabel("Позывной")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Ваш позывной/ник в подразделении")
    .setRequired(true)
    .setMaxLength(50);

  const ageInput = new TextInputBuilder()
    .setCustomId("age")
    .setLabel("Возраст")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("18")
    .setRequired(true)
    .setMaxLength(3);

  const timezoneInput = new TextInputBuilder()
    .setCustomId("timezone")
    .setLabel("Часовой пояс")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("MSK / UTC+3")
    .setRequired(true)
    .setMaxLength(20);

  const availabilityInput = new TextInputBuilder()
    .setCustomId("availability")
    .setLabel("Доступность")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Когда вы обычно доступны для игр?")
    .setRequired(true)
    .setMaxLength(500);

  const armaExperienceInput = new TextInputBuilder()
    .setCustomId("armaExperience")
    .setLabel("Опыт в Arma 3")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Опишите ваш опыт в Arma 3")
    .setRequired(true)
    .setMaxLength(1000);

  // Объединяем опыт в милсиме и Arma в одно поле
  const experienceInput = new TextInputBuilder()
    .setCustomId("experience")
    .setLabel("Опыт (Arma и милсим)")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Опишите ваш опыт в Arma 3 и милсим подразделениях. Разделите на два абзаца.")
    .setRequired(true)
    .setMaxLength(2000);

  const micAndModsInput = new TextInputBuilder()
    .setCustomId("micAndMods")
    .setLabel("Микрофон, моды и мотивация")
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder("Есть ли микрофон? Готовы установить моды? Почему хотите вступить?")
    .setRequired(true)
    .setMaxLength(2000);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nicknameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(ageInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(timezoneInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(availabilityInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(experienceInput),
  );

  // Примечание: micAndMods и whyUnit будут заполняться в experienceInput (объединено для ограничения Discord на 5 полей)
  return modal;
}

