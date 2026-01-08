import { migrateSqlite } from "./migrator.js";
import { openSqliteDb } from "./sqliteDb.js";
import { GuildRepository } from "./repositories/guildRepository.js";
import { MappingRepository } from "./repositories/mappingRepository.js";
import { SetupSessionRepository } from "./repositories/setupSessionRepository.js";
import { DeploymentStepRepository } from "./repositories/deploymentStepRepository.js";
import { AuditRepository } from "./repositories/auditRepository.js";

export type Storage = {
  guilds: GuildRepository;
  mappings: MappingRepository;
  setupSessions: SetupSessionRepository;
  deploymentSteps: DeploymentStepRepository;
  audit: AuditRepository;
  close(): void;
};

export async function createSqliteStorage(params: {
  databasePath: string;
  migrationsDir: string;
}): Promise<Storage> {
  const db = openSqliteDb(params.databasePath);
  await migrateSqlite(db, params.migrationsDir);

  return {
    guilds: new GuildRepository(db),
    mappings: new MappingRepository(db),
    setupSessions: new SetupSessionRepository(db),
    deploymentSteps: new DeploymentStepRepository(db),
    audit: new AuditRepository(db),
    close() {
      db.close();
    },
  };
}

