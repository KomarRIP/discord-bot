## Порты и контракты (Application ↔ Infrastructure)

Этот документ фиксирует **интерфейсы портов**, которые использует Application Layer. Реализации находятся в Infrastructure и могут меняться без изменения use‑case’ов.

---

## 1. Общие принципы портов

- **Идемпотентность на уровне use‑case**: use‑case оперирует ключами (`RoleKey`, `ChannelKey`) и ожидает, что повторный вызов «приведёт к целевому состоянию».
- **Ошибки — типизированные**: `NotFound`, `Forbidden`, `Conflict`, `RateLimited`, `Transient`, `Validation`.
- **Запросы — контекстные**: каждый вызов принимает `guildId` и `requestContext` (requestId, actor, reason).
- **Данные наружу — минимум**: наружу возвращаем только то, что нужно для дальнейших шагов (Discord IDs, etag/fingerprint, фактические имена).

---

## 2. DiscordGateway (порт Discord API)

### 2.1. Назначение

`DiscordGateway` — единственная точка контакта use‑case’ов с Discord. Он:

- создаёт/обновляет роли, категории и каналы;
- выставляет permission overwrites;
- публикует/обновляет «системные» сообщения (правила, инструкции);
- предоставляет ограниченный «read model» (минимальные выборки состояния).

### 2.2. Минимальные операции для MVP

**Роли**
- `ensureRole(guildId, roleSpec) -> { roleId, changed: boolean }`
- `getRoleById(guildId, roleId) -> RoleSnapshot | null`

**Категории/каналы**
- `ensureCategory(guildId, categorySpec) -> { categoryId, changed }`
- `ensureTextChannel(guildId, channelSpec, parentCategoryId?) -> { channelId, changed }`
- `getChannelById(guildId, channelId) -> ChannelSnapshot | null`

**Права**
- `setPermissionOverwrites(targetId, overwrites, mode) -> { changed }`
  - `targetId`: id канала или категории
  - `mode`: `replace` (в MVP), позже возможен `merge`

**Системные сообщения**
- `ensureMessage(channelId, messageKey, content, embeds?) -> { messageId, changed }`
  - для публикации правил/инструкций с идемпотентностью

**Контекст безопасности**
- `getGuildOwnerId(guildId) -> userId`
- `getBotUserId() -> userId`

### 2.3. Важные контрактные гарантии

- `ensure*` **не создаёт дубликаты**, если передан тот же `discordId` из `discord_mappings`.
- `setPermissionOverwrites(..., replace)` гарантирует, что конечный набор overwrites соответствует переданному списку.
- Любая операция может вернуть `RateLimited/Transient` — use‑case обязан поддерживать retry через очередь (см. `RateLimitQueue` в инфраструктуре).

---

## 3. Storage порты (репозитории)

### 3.1. GuildRepository

- `getGuildState(guildId) -> GuildState | null`
- `upsertGuildState(guildId, patch) -> GuildState`
- `beginDeployment(guildId, deploymentMeta) -> deploymentId`
- `finishDeployment(guildId, deploymentId, status, error?)`

### 3.2. SetupSessionRepository

- `getActiveSession(guildId) -> SetupSession | null`
- `createSession(guildId, session) -> SetupSession`
- `updateSession(guildId, sessionId, patch) -> SetupSession`
- `expireSessions(now)`

### 3.3. MappingRepository (discord_mappings)

- `getMapping(guildId, kind, key) -> Mapping | null`
- `upsertMapping(guildId, kind, key, discordId, fingerprint) -> Mapping`
- `listMappings(guildId, kind) -> Mapping[]`

Контракт: `key` уникален по `(guildId, kind, key)`.

### 3.4. MemberRepository / IntakeRepository / DisciplineRepository (MVP минимум)

- `upsertMemberProfile(guildId, userId, patch)`
- `createApplication(guildId, application) -> applicationId`
- `updateApplicationStatus(guildId, applicationId, transition)`
- `appendDisciplineRecord(guildId, record) -> recordId`

---

## 4. AuditLogPort

### 4.1. Назначение

Дублируем события:
- в Discord (audit‑канал),
- в storage (для поиска/отчётности).

### 4.2. Операции

- `logEvent(guildId, event)`
  - события: `DeploymentPlanned`, `DeploymentStepApplied`, `RoleGranted`, `ApplicationApproved`, ...

Инвариант: критические действия должны логироваться **до** выполнения (intent) и **после** (result).

---

## 5. TemplateRegistryPort

- `listTemplates() -> TemplateMeta[]`
- `getTemplate(templateId) -> TemplateConfig`
- `validateTemplate(templateConfig) -> ValidationResult` (или валидатор как часть загрузчика)

Контракт: use‑case не работает с «сырым JSON» — только с валидированной структурой.

---

## 6. ClockPort / IdPort (утилитарные)

- `now() -> Instant`
- `newId() -> string` (ULID/UUID — реализация не важна для домена)

