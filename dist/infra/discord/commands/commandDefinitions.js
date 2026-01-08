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
    return [setup, deploy].map((c) => c.toJSON());
}
