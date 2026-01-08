## Storage: схема данных и миграции (MVP → расширение)

Цель: определить минимальную, но расширяемую схему хранения для:

- состояния установки на guild,
- идемпотентного деплоя (history + mapping + шаги),
- intake/discipline,
- аудита.

Хранилище в MVP: **SQLite** (один файл), с миграциями.

---

## 1. Принципы хранения

- **Append-only там, где важна история**: `deployments`, `deployment_steps`, `discipline_records`, `audit_events`.
- **Уникальные ключи как инварианты**: маппинги не могут дублироваться по `(guildId, kind, key)`.
- **JSON только для «редко читаемых» payload**: например ответы setup wizard и payload заявки.
- **Детерминированные timestamps**: `createdAt/updatedAt` в UTC.

---

## 2. Таблицы (концептуальная спецификация)

Ниже — логическая схема. Точные типы (INTEGER/TEXT) — реализация инфраструктуры.

### 2.1. `guilds`

Назначение: текущее состояние установки.

Поля:
- `guildId` (PK)
- `activeTemplateId`
- `activeTemplateVersion`
- `activeSchemaVersion`
- `deploymentVersion` (монотонный int)
- `deploymentConfigHash` (hash валидированного desired state)
- `installedAt`
- `updatedAt`

Индексы:
- PK по `guildId`

### 2.2. `deployments`

Назначение: история запусков деплоя.

Поля:
- `deploymentId` (PK, ULID/UUID)
- `guildId` (FK -> guilds.guildId)
- `templateId`, `templateVersion`, `schemaVersion`
- `configHash`
- `status` (`started|completed|failed|cancelled`)
- `actorUserId` (кто запустил)
- `errorCode` (nullable)
- `errorJson` (nullable, sanitized)
- `startedAt`
- `finishedAt` (nullable)

Индексы:
- `(guildId, startedAt desc)`
- `(guildId, status)`

### 2.3. `deployment_steps` (ключевой компонент resume)

Назначение: журнал шагов деплоя (intent/result), поддержка resume и диагностики.

Поля:
- `stepId` (PK)
- `deploymentId` (FK -> deployments.deploymentId)
- `guildId`
- `seq` (порядковый номер шага в плане)
- `scope` (`role|category|channel|overwrites|message`)
- `kind` (например `RoleEnsure`, `OverwritesReplace`)
- `key` (RoleKey/ChannelKey/MessageKey)
- `fingerprint` (целевой)
- `idempotencyKey` (см. `rate-limit-and-retry.md`)
- `status` (`planned|applied|skipped|failed`)
- `action` (`create|update|skip`) — целевое действие на момент планирования
- `reason` (`missing_mapping|missing_in_discord|fingerprint_changed|unchanged|adopted|...`)
- `discordId` (nullable, если применимо)
- `resultJson` (nullable: sanitized snapshot)
- `errorCode` (nullable)
- `errorJson` (nullable: sanitized)
- `plannedAt`
- `finishedAt` (nullable)

Уникальность:
- `(deploymentId, seq)` уникален
- опционально: `(deploymentId, scope, key, fingerprint)` уникален (защита от дубля плана)

Индексы:
- `(guildId, deploymentId)`
- `(guildId, status)`
- `(deploymentId, status)`

### 2.4. `discord_mappings`

Назначение: якорь идемпотентности (key -> discordId + fingerprint).

Поля:
- `guildId`
- `kind` (`role|channel|category|message`)
- `key` (RoleKey/ChannelKey/MessageKey)
- `discordId`
- `fingerprint`
- `managedName` (nullable, для adoption и диагностики)
- `createdAt`
- `updatedAt`

Уникальность:
- `UNIQUE(guildId, kind, key)`
- `UNIQUE(guildId, kind, discordId)` (желательно; защищает от «два ключа на один объект»)

Индексы:
- `(guildId, kind)`

### 2.5. `setup_sessions`

Поля:
- `sessionId` (PK)
- `guildId`
- `status` (`active|confirmed|deploying|completed|cancelled|failed`)
- `stepKey`
- `answersJson`
- `expiresAt`
- `createdAt`
- `updatedAt`

Уникальность:
- `UNIQUE(guildId) WHERE status IN ('active','confirmed','deploying')`  
  (реализуем через логику приложения, SQLite partial unique — опционально)

### 2.6. `members`

Поля:
- `guildId`
- `userId`
- `rankRoleKey` (nullable)
- `positionRoleKeysJson`
- `clearanceRoleKeysJson`
- `createdAt`
- `updatedAt`

Уникальность:
- `UNIQUE(guildId, userId)`

### 2.7. `applications`

Поля:
- `applicationId` (PK)
- `guildId`
- `type` (`join|transfer|clearance`)
- `status` (`draft|submitted|under_review|approved|rejected|cancelled`)
- `applicantUserId`
- `payloadJson`
- `decisionByUserId` (nullable)
- `decisionReason` (nullable)
- `decisionAt` (nullable)
- `createdAt`
- `updatedAt`

Индексы:
- `(guildId, status)`
- `(guildId, applicantUserId, createdAt desc)`

### 2.8. `discipline_records`

Поля:
- `recordId` (PK)
- `guildId`
- `targetUserId`
- `authorUserId`
- `kind` (`warning|note|penalty|revocation`)
- `severity` (int)
- `reason`
- `createdAt`
- `expiresAt` (nullable)
- `metaJson` (nullable)

Индексы:
- `(guildId, targetUserId, createdAt desc)`

### 2.9. `audit_events` (MVP минимум, можно упрощать)

Поля:
- `eventId` (PK)
- `guildId`
- `deploymentId` (nullable)
- `actorUserId` (nullable)
- `type` (строка)
- `payloadJson` (sanitized)
- `createdAt`

Индексы:
- `(guildId, createdAt desc)`
- `(guildId, type, createdAt desc)`

---

## 3. Миграции

### 3.1. Правила

- Каждая миграция имеет монотонный номер: `0001_initial.sql`, `0002_add_deployment_steps.sql`, ...
- Миграции **только вперёд** (down — опционально, не требуется для MVP).
- При запуске бот:
  - проверяет `schema_migrations`,
  - применяет недостающие миграции транзакционно,
  - логирует результат в audit.

### 3.2. Таблица `schema_migrations`

Поля:
- `version` (PK)
- `appliedAt`
- `checksum`

---

## 4. Санитизация данных

Чтобы не хранить чувствительное:
- не записываем токены/секреты;
- Discord IDs допустимы (это не секрет), но **не** логируем содержимое приватных каналов;
- `errorJson` чистим от raw ответов SDK, оставляем code/message/requestId.

