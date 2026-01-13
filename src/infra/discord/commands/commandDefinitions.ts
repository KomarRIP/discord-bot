import { SlashCommandBuilder } from "discord.js";

export function buildCommandDefinitions() {
  const setup = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Мастер настройки (MVP)")
    .addSubcommand((s) => s.setName("start").setDescription("Начать мастер настройки"))
    .addSubcommand((s) => s.setName("status").setDescription("Показать статус мастера"))
    .addSubcommand((s) => s.setName("cancel").setDescription("Отменить мастер"));

  const deploy = new SlashCommandBuilder()
    .setName("deploy")
    .setDescription("Деплой шаблона (MVP)")
    .addSubcommand((s) => s.setName("preview").setDescription("Показать план изменений (preview)"))
    .addSubcommand((s) => s.setName("apply").setDescription("Применить план (apply)"));

  const intake = new SlashCommandBuilder()
    .setName("intake")
    .setDescription("Приёмная: заявки на вступление")
    .addSubcommand((s) => s.setName("apply").setDescription("Подать заявку на вступление"))
    .addSubcommand((s) =>
      s
        .setName("list")
        .setDescription("Список заявок (для персонала)")
        .addStringOption((o) =>
          o
            .setName("status")
            .setDescription("Фильтр по статусу")
            .addChoices(
              { name: "Поданные", value: "submitted" },
              { name: "В рассмотрении", value: "under_review" },
              { name: "Одобренные", value: "approved" },
              { name: "Отклонённые", value: "rejected" },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("approve")
        .setDescription("Одобрить заявку (для персонала)")
        .addStringOption((o) => o.setName("id").setDescription("ID заявки").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Причина одобрения")),
    )
    .addSubcommand((s) =>
      s
        .setName("reject")
        .setDescription("Отклонить заявку (для персонала)")
        .addStringOption((o) => o.setName("id").setDescription("ID заявки").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Причина отклонения").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("cancel").setDescription("Отменить свою заявку"));

  const roles = new SlashCommandBuilder()
    .setName("roles")
    .setDescription("Управление ролями участников")
    .addSubcommand((s) =>
      s
        .setName("set-rank")
        .setDescription("Установить звание участнику")
        .addUserOption((o) => o.setName("user").setDescription("Участник").setRequired(true))
        .addStringOption((o) =>
          o.setName("rank").setDescription("Звание").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("add-position")
        .setDescription("Добавить должность участнику")
        .addUserOption((o) => o.setName("user").setDescription("Участник").setRequired(true))
        .addStringOption((o) =>
          o.setName("position").setDescription("Должность").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("remove-position")
        .setDescription("Снять должность с участника")
        .addUserOption((o) => o.setName("user").setDescription("Участник").setRequired(true))
        .addStringOption((o) =>
          o.setName("position").setDescription("Должность").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("grant-clearance")
        .setDescription("Выдать допуск участнику")
        .addUserOption((o) => o.setName("user").setDescription("Участник").setRequired(true))
        .addStringOption((o) =>
          o.setName("clearance").setDescription("Допуск").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("revoke-clearance")
        .setDescription("Отозвать допуск у участника")
        .addUserOption((o) => o.setName("user").setDescription("Участник").setRequired(true))
        .addStringOption((o) =>
          o.setName("clearance").setDescription("Допуск").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("profile")
        .setDescription("Показать профиль участника")
        .addUserOption((o) => o.setName("user").setDescription("Участник").setRequired(true)),
    );

  return [setup, deploy, intake, roles].map((c) => c.toJSON());
}

