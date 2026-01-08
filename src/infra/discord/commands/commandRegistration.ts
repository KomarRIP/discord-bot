import { REST, Routes, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";

export async function registerSlashCommands(params: {
  token: string;
  applicationId: string;
  commands: RESTPostAPIApplicationCommandsJSONBody[];
  guildId?: string;
}): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(params.token);

  if (params.guildId) {
    await rest.put(Routes.applicationGuildCommands(params.applicationId, params.guildId), {
      body: params.commands,
    });
    return;
  }

  await rest.put(Routes.applicationCommands(params.applicationId), {
    body: params.commands,
  });
}

