import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, GatewayIntentBits, Interaction } from "discord.js";
import { createLogger } from "./shared/logging/logger.js";
import { loadRuntimeConfig } from "./config/runtimeConfig.js";
import { createSqliteStorage } from "./infra/storage/sqlite/sqliteStorage.js";
import { TemplateRegistry } from "./infra/templates/templateRegistry.js";
import { buildCommandDefinitions } from "./infra/discord/commands/commandDefinitions.js";
import { registerSlashCommands } from "./infra/discord/commands/commandRegistration.js";
import { createInteractionRouter } from "./interface/discord/interactionRouter.js";

const log = createLogger();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const token = requireEnv("DISCORD_TOKEN");
const databaseUrl = requireEnv("DATABASE_URL");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimeConfigPath = process.env.RUNTIME_CONFIG_PATH ?? path.join(__dirname, "../config/runtime.json");
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.join(__dirname, "../migrations");

const runtimeConfig = await loadRuntimeConfig(runtimeConfigPath);
const runtimeConfigDir = path.dirname(runtimeConfigPath);
const templatesPath = path.isAbsolute(runtimeConfig.templatesPath)
  ? runtimeConfig.templatesPath
  : path.join(runtimeConfigDir, runtimeConfig.templatesPath);
const storage = await createSqliteStorage({
  databasePath: databaseUrl,
  migrationsDir,
});
const templates = new TemplateRegistry(templatesPath);
await templates.listTemplates(); // preload + validate

const routeInteraction = createInteractionRouter({
  client,
  storage,
  templates,
  runtime: runtimeConfig,
});

client.once("ready", () => {
  log.info(
    { botUserId: client.user?.id, botTag: client.user?.tag },
    "Bot ready",
  );

  const guildId = process.env.DISCORD_GUILD_ID;
  const commands = buildCommandDefinitions();
  const appId = client.application?.id ?? client.user?.id;
  if (!appId) {
    log.error("Cannot register commands: missing application id");
    return;
  }

  registerSlashCommands({
    token,
    applicationId: appId,
    commands,
    guildId,
  })
    .then(() =>
      log.info(
        { scope: guildId ? "guild" : "global", guildId: guildId ?? null, count: commands.length },
        "Slash commands registered",
      ),
    )
    .catch((e) => log.error({ err: e }, "Failed to register slash commands"));
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await routeInteraction(interaction);
});

await client.login(token);

process.on("SIGINT", () => {
  storage.close();
  process.exit(0);
});


