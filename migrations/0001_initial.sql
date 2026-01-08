-- MVP schema based on docs/specs/storage-schema-and-migrations.md

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  appliedAt TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  guildId TEXT PRIMARY KEY,
  activeTemplateId TEXT,
  activeTemplateVersion TEXT,
  activeSchemaVersion TEXT,
  deploymentVersion INTEGER NOT NULL DEFAULT 0,
  deploymentConfigHash TEXT,
  installedAt TEXT,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  deploymentId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  templateId TEXT NOT NULL,
  templateVersion TEXT NOT NULL,
  schemaVersion TEXT NOT NULL,
  configHash TEXT NOT NULL,
  status TEXT NOT NULL,
  actorUserId TEXT NOT NULL,
  errorCode TEXT,
  errorJson TEXT,
  startedAt TEXT NOT NULL,
  finishedAt TEXT
);

CREATE INDEX IF NOT EXISTS deployments_guild_started_idx
  ON deployments (guildId, startedAt DESC);
CREATE INDEX IF NOT EXISTS deployments_guild_status_idx
  ON deployments (guildId, status);

CREATE TABLE IF NOT EXISTS deployment_steps (
  stepId TEXT PRIMARY KEY,
  deploymentId TEXT NOT NULL,
  guildId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  discordId TEXT,
  resultJson TEXT,
  errorCode TEXT,
  errorJson TEXT,
  plannedAt TEXT NOT NULL,
  finishedAt TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS deployment_steps_deploy_seq_uq
  ON deployment_steps (deploymentId, seq);
CREATE INDEX IF NOT EXISTS deployment_steps_guild_status_idx
  ON deployment_steps (guildId, status);
CREATE INDEX IF NOT EXISTS deployment_steps_deploy_status_idx
  ON deployment_steps (deploymentId, status);

CREATE TABLE IF NOT EXISTS discord_mappings (
  guildId TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  discordId TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  managedName TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (guildId, kind, key)
);

CREATE UNIQUE INDEX IF NOT EXISTS discord_mappings_discordId_uq
  ON discord_mappings (guildId, kind, discordId);
CREATE INDEX IF NOT EXISTS discord_mappings_kind_idx
  ON discord_mappings (guildId, kind);

CREATE TABLE IF NOT EXISTS setup_sessions (
  sessionId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  status TEXT NOT NULL,
  stepKey TEXT NOT NULL,
  answersJson TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS setup_sessions_guild_idx
  ON setup_sessions (guildId);

CREATE TABLE IF NOT EXISTS members (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  rankRoleKey TEXT,
  positionRoleKeysJson TEXT NOT NULL,
  clearanceRoleKeysJson TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (guildId, userId)
);

CREATE TABLE IF NOT EXISTS applications (
  applicationId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  applicantUserId TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  decisionByUserId TEXT,
  decisionReason TEXT,
  decisionAt TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS applications_guild_status_idx
  ON applications (guildId, status);
CREATE INDEX IF NOT EXISTS applications_guild_applicant_idx
  ON applications (guildId, applicantUserId, createdAt DESC);

CREATE TABLE IF NOT EXISTS discipline_records (
  recordId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  targetUserId TEXT NOT NULL,
  authorUserId TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT,
  metaJson TEXT
);

CREATE INDEX IF NOT EXISTS discipline_records_guild_target_idx
  ON discipline_records (guildId, targetUserId, createdAt DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  eventId TEXT PRIMARY KEY,
  guildId TEXT NOT NULL,
  deploymentId TEXT,
  actorUserId TEXT,
  type TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_guild_created_idx
  ON audit_events (guildId, createdAt DESC);
CREATE INDEX IF NOT EXISTS audit_events_guild_type_created_idx
  ON audit_events (guildId, type, createdAt DESC);

