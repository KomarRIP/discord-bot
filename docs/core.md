## 0. Обзор

### 0.1. Цель продукта

**Discord бот‑конструктор** для милсим подразделений Arma 3, ориентированный на **реалистичную структуру в стиле ССО РФ**.
После приглашения бота на пустой сервер пользователь проходит мастер‑настройку (wizard), а бот:

- создаёт роли (базовые, звания, должности, допуски/грифы);
- создаёт категории и каналы;
- настраивает права доступа (строгая модель);
- поднимает «приёмную/пропускной режим» (заявки, подтверждения);
- публикует правила и включает журналирование действий.

### 0.2. Рабочие допущения (фиксируем и можем изменить позже)

- **Технологический стек (план)**: TypeScript + Node.js, библиотека Discord API уровня `discord.js` (или аналог), хранилище SQLite (переход на Postgres в фазе 3).
- **Требование по масштабам**: \~18 активных + гости; это означает, что оптимизация — вторична, но **надёжность и идемпотентность** — первичны.
- **Шаблон MVP**: `SSO_RF` (структура, роли, каналы, допуски).
- **Права**: запрещаем по умолчанию; доступ выдаётся строго по ролям/допускам.

---

## 1. Глоссарий

- **Guild (Сервер)**: Discord‑сервер, на который установлен бот.
- **Unit (Подразделение)**: логическая «часть» внутри guild (в MVP — 1 unit на guild).
- **Template (Шаблон)**: конфиг развёртывания структуры (роли, каналы, права, процессы).
- **Deployment (Развёртывание)**: применение шаблона к серверу с идемпотентностью.
- **RoleGroup**: тип роли (база/звание/должность/допуск).
- **Rank (Звание)**: взаимоисключающие роли (у участника может быть ровно 0..1 звание).
- **Position (Должность)**: роли назначения (у участника 0..2 должности).
- **Clearance (Допуск/гриф)**: роли доступа (у участника 0..N допусков по правилам шаблона).
- **Setup Wizard**: пошаговый мастер, собирающий параметры развёртывания.
- **SetupSession**: состояние мастера настройки в разрезе guild.
- **PermissionPolicy**: набор правил доступа к каналам/категориям.
- **Intake (Приёмная/канцелярия)**: процесс заявок на вступление/перевод/допуск.
- **Discipline (Дисциплина)**: предупреждения/взыскания и их журналирование.
- **Idempotency**: повторное применение деплоя не создаёт дубликаты и приводит к «целевому состоянию».

---

## 2. Архитектура (высокий уровень)

### 2.1. Границы системы

Система состоит из:

- **Discord Bot Runtime**: обработка событий/команд, оркестрация use‑case’ов.
- **Domain Layer**: сущности, инварианты, политики (без Discord SDK).
- **Application Layer (Use-cases)**: сценарии (setup, deploy, intake, discipline, management).
- **Infrastructure Layer**: Discord API адаптеры, БД, логирование, планировщик, ограничитель rate limit.
- **Template System**: загрузка/валидация конфигов шаблонов.

### 2.2. Текстовая диаграмма

```
Discord Events/Commands
        |
        v
  Interface Layer (commands/interactions)
        |
        v
  Application Use-Cases (Setup, Deploy, Intake, Discipline, Admin)
        |
        +----> Domain (Entities, Policies, Invariants)
        |
        +----> Infrastructure
                 - DiscordGateway (roles/channels/perms)
                 - Storage (SQLite)
                 - RateLimiter / Retry
                 - AuditLog
        |
        v
  Template Engine (load/validate/resolve)
```

### 2.3. Правила зависимостей (обязательные)

- **Domain** не зависит от Discord SDK, БД, логгеров.
- **Application** может зависеть от Domain и интерфейсов портов (например, `DiscordGateway`, `UnitRepository`), но не от конкретных реализаций.
- **Infrastructure** реализует порты, зависит от SDK/БД/сети.
- **Interface** (команды/интеракции) зависит только от Application (и DTO).

### 2.4. Жизненный цикл инициализации

- **Boot**
  - загрузить конфиги шаблонов;
  - проверить версию схем и миграции;
  - поднять storage;
  - зарегистрировать команды;
  - включить диспетчер ограничений Discord API (rate‑limit / backoff).
- **Runtime**
  - события/команды -> use‑case -> gateway/storage.
- **Shutdown**
  - корректно завершить очереди/ретраи, сбросить метрики.

---

## 3. Доменная модель

### 3.1. Сущности и ответственность

#### 3.1.1. Server (GuildAggregate)
- **Ответственность**: хранит состояние установки бота на сервере (какой шаблон применён, версия деплоя, привязки к созданным сущностям Discord).
- **Инварианты**:
  - на один guild — максимум один активный `SetupSession`;
  - деплой имеет версию и отпечаток (hash) конфигурации.

#### 3.1.2. Unit
- **Ответственность**: модель подразделения (название, размер, режимы приёма, правила дисциплины).
- **Инварианты**:
  - Unit принадлежит ровно одному guild;
  - Unit создаётся только после подтверждения мастера настройки.

#### 3.1.3. Template
- **Ответственность**: определяет целевое состояние структуры (роли/каналы/права/процессы).
- **Инварианты**:
  - шаблон имеет `templateId` и `schemaVersion`;
  - шаблон не содержит «живых» Discord ID, только ключи/алиасы.

#### 3.1.4. Role (RoleSpec)
- **Ответственность**: спецификация роли (ключ, имя, цвет, позиция, тип).
- **Инварианты**:
  - ключ роли уникален в пределах шаблона;
  - тип роли ∈ {base, rank, position, clearance, system}.

#### 3.1.5. Rank
- **Ответственность**: набор взаимно исключающих ролей.
- **Инварианты**:
  - участник может иметь **0..1** rank одновременно;
  - rank назначается только уполномоченными ролями (политика).

#### 3.1.6. Position
- **Ответственность**: роли назначения (должности).
- **Инварианты**:
  - участник имеет **0..2** position (порог задаётся конфигом unit).

#### 3.1.7. Clearance
- **Ответственность**: допуски к информации/каналам.
- **Инварианты**:
  - выдача допусков должна оставлять след в журнале;
  - допуск может требовать минимального rank/position (политика).

#### 3.1.8. Channel (ChannelSpec)
- **Ответственность**: спецификация канала/категории (ключ, тип, родитель, тема, permission policy key).
- **Инварианты**:
  - ключ канала уникален в пределах шаблона;
  - ссылки на родителя — только по ключу.

#### 3.1.9. Member (MemberProfile)
- **Ответственность**: профиль участника в контексте unit (привязанные роли, состояние приёма, дисциплина).
- **Инварианты**:
  - rank уникален (0..1);
  - positions ограничены (0..2);
  - дисциплинарные записи неизменяемы (append-only), допускается только отмена/аннулирование отдельной записью.

#### 3.1.10. Application (IntakeApplication)
- **Ответственность**: заявка (вступление/перевод/допуск) с этапами рассмотрения.
- **Инварианты**:
  - заявка имеет статусную машину (см. ниже);
  - решение должно фиксировать кто/когда/почему.

#### 3.1.11. DisciplineRecord
- **Ответственность**: запись о предупреждении/взыскании/замечании.
- **Инварианты**:
  - append-only;
  - имеет ссылку на автора и причину; может иметь срок действия.

#### 3.1.12. SetupSession
- **Ответственность**: состояние мастера установки (вопросы, ответы, прогресс, подтверждение).
- **Инварианты**:
  - сессия имеет TTL (например 24ч);
  - нельзя применить деплой без финального подтверждения.

### 3.2. Отношения (упрощённо)

- `GuildAggregate 1 — 1 Unit`
- `Unit 1 — 1 Template (активный)`
- `Template 1 — N RoleSpec`
- `Template 1 — N ChannelSpec`
- `Unit 1 — N MemberProfile`
- `MemberProfile 1 — N DisciplineRecord`
- `Unit 1 — N IntakeApplication`

### 3.3. Машины состояний

#### IntakeApplication.status

- `draft` (создание)
- `submitted` (отправлено)
- `under_review` (в рассмотрении)
- `approved` | `rejected`
- `cancelled`

Переходы:
- `draft -> submitted`
- `submitted -> under_review`
- `under_review -> approved/rejected`
- `draft/submitted/under_review -> cancelled`

#### SetupSession.status

- `active` -> `confirmed` -> `deploying` -> `completed`
- `active` -> `cancelled`
- `deploying` -> `failed` (с возможностью retry)

---

## 4. Модульная декомпозиция (предлагаемая структура пакетов)

### 4.1. Interface Layer (Discord)
- **Команды/интеракции**: `/setup`, `/deploy`, `/intake`, `/discipline`, `/unit`, `/roles`.
- **Парсинг ввода**: преобразование в DTO.
- **Ответ пользователю**: эмбед‑сообщения, кнопки, селекты.

### 4.2. Application Layer (Use-cases)
- `SetupWizardService`
- `TemplateDeploymentService`
- `PermissionCompiler`
- `IntakeService`
- `DisciplineService`
- `UnitManagementService`

Ключевой принцип: use‑case **не** знает, как именно создаётся роль/канал в Discord — он вызывает `DiscordGateway`.

### 4.3. Domain Layer
- сущности/значимые типы (value objects): `TemplateId`, `RoleKey`, `ChannelKey`, `SchemaVersion`;
- политики: `RankPolicy`, `ClearancePolicy`, `PermissionPolicy`;
- инварианты и проверки.

### 4.4. Infrastructure Layer
- `DiscordGateway` (создание/обновление/поиск ролей/каналов, выставление permissions)
- `Storage` (репозитории, миграции)
- `AuditLog` (в канал + в БД)
- `RateLimitQueue` (очередь операций Discord API + retry/backoff)
- `ConfigLoader` (чтение JSON, валидация, versioning)

### 4.5. Template System
- `TemplateRegistry` (доступные шаблоны)
- `TemplateValidator` (валидатор схемы)
- `TemplateResolver` (перевод alias -> конкретные объекты)

---

## 5. Данные и структуры (концептуально)

### 5.1. Стратегия хранения (эволюционная)

**Фаза 1 (MVP)**: SQLite (один файл) + миграции.
- плюсы: быстро, просто, один артефакт.
- минусы: ограничения по конкурентности; для MVP ок.

**Фаза 3**: Postgres, если потребуется мульти‑шард/несколько инстансов.

### 5.2. Что храним (минимально необходимо)

- `guilds`
  - `guildId`
  - `activeTemplateId`
  - `deploymentVersion`
  - `deploymentConfigHash`
  - `createdAt`, `updatedAt`
- `deployments` (история)
  - `guildId`, `deploymentId`
  - `templateId`, `schemaVersion`
  - `status`, `error`
  - `startedAt`, `finishedAt`
- `discord_mappings` (идемпотентность)
  - `guildId`
  - `kind` (role/channel/category/message)
  - `key` (RoleKey/ChannelKey/...)
  - `discordId`
  - `fingerprint` (для обновлений)
- `setup_sessions`
  - `guildId`, `sessionId`, `status`, `stepKey`
  - `answersJson`, `expiresAt`
- `members`
  - `guildId`, `userId`
  - `rankRoleKey` (nullable)
  - `positionRoleKeysJson`
  - `clearanceRoleKeysJson`
- `applications`
  - `guildId`, `applicationId`, `type`, `status`
  - `applicantUserId`
  - `payloadJson`
  - `decisionByUserId`, `decisionReason`, `decisionAt`
- `discipline_records`
  - `guildId`, `recordId`
  - `targetUserId`, `authorUserId`
  - `kind`, `severity`, `reason`
  - `createdAt`, `expiresAt` (nullable)

### 5.3. Идемпотентность: ключевая структура

**discord_mappings** — это «якорь» между ключами шаблона и реальными Discord ID.
Идемпотентный деплой работает так:

- для каждого `RoleSpec/ChannelSpec` вычисляем `fingerprint` (например, hash от имени/типа/настроек/permission policy key);
- если маппинг существует — обновляем объект, если `fingerprint` отличается;
- если не существует — создаём объект и сохраняем `discordId`.

Важно: удаление объектов — отдельный режим (по умолчанию **не удаляем**, чтобы не ломать сервер).

---

## 6. Конфиги и схемы (JSON‑ориентированные)

### 6.1. Версионирование схем

Каждый шаблон содержит:
- `templateId`
- `schemaVersion` (семвер: `1.0.0`)
- `templateVersion` (семвер содержимого)

Правило: **изменение схемы** = `schemaVersion`, изменение содержимого = `templateVersion`.

### 6.2. Схема Template (упрощённый пример)

```json
{
  "templateId": "SSO_RF",
  "schemaVersion": "1.0.0",
  "templateVersion": "0.1.0",
  "meta": {
    "displayName": "ССО РФ (MVP)",
    "language": "ru-RU"
  },
  "roles": [
    { "key": "BASE_GUEST", "type": "base", "name": "Гость" },
    { "key": "BASE_MEMBER", "type": "base", "name": "Боец" },
    { "key": "RANK_SOLDIER", "type": "rank", "name": "Рядовой" },
    { "key": "POS_SQUAD_LEAD", "type": "position", "name": "Командир отделения" },
    { "key": "CLR_SECRET", "type": "clearance", "name": "Секретно" }
  ],
  "channels": [
    { "key": "CAT_PUBLIC", "type": "category", "name": "Общее" },
    { "key": "CH_RULES", "type": "text", "name": "правила", "parentKey": "CAT_PUBLIC", "policyKey": "POLICY_PUBLIC_READ" },
    { "key": "CH_INTAKE", "type": "text", "name": "приёмная", "parentKey": "CAT_PUBLIC", "policyKey": "POLICY_INTAKE" }
  ],
  "policies": {
    "POLICY_PUBLIC_READ": {
      "deny": ["@everyone:SendMessages"],
      "allow": ["@everyone:ViewChannel", "@everyone:ReadMessageHistory"]
    },
    "POLICY_INTAKE": {
      "deny": ["@everyone:ViewChannel"],
      "allow": ["BASE_GUEST:ViewChannel", "BASE_GUEST:SendMessages", "BASE_GUEST:ReadMessageHistory"]
    }
  }
}
```

### 6.3. Схема UnitConfig (ответы мастера настройки)

```json
{
  "guildId": "123",
  "unit": {
    "name": "Отряд",
    "size": 18,
    "positionsLimitPerMember": 2,
    "intakeMode": "gated",
    "discipline": { "warningsBeforeEscalation": 3 }
  },
  "security": {
    "require2FAForStaff": false,
    "logChannelKey": "CH_LOGS"
  },
  "templateId": "SSO_RF"
}
```

---

## 7. Логика прав (Permission Engine)

### 7.1. Принцип «deny by default»

Базовое правило: для приватных зон канала сначала выставляем:
- deny `@everyone:ViewChannel`,
затем добавляем allow для ролей/допусков.

### 7.2. Компиляция политики

`PermissionCompiler` преобразует `policyKey` + контекст шаблона в набор PermissionOverwrites Discord:

- источники правил:
  - built‑in ключ `@everyone`;
  - ключи ролей шаблона (`BASE_MEMBER`, `CLR_SECRET`);
  - опционально «динамические» группы (например, `STAFF`, если шаблон определяет состав).

Инвариант: любая `policyKey` должна быть определена в шаблоне; иначе деплой падает до начала операций.

### 7.3. Пример ожидаемой модели для SSO_RF (MVP)

- Публичные каналы: `@everyone` read, send ограничен (по решению unit).
- Приёмная: видна гостям, доступна для подачи заявки, персонал видит всё.
- Штаб/оперативка: только `BASE_MEMBER` + `CLR_SECRET` или выше.
- Журналы: только персонал/командование.

---

## 8. Setup Wizard (поток)

### 8.1. Шаги мастера (MVP)

- выбор шаблона (`SSO_RF`)
- имя подразделения
- примерный размер (18 по умолчанию)
- режим приёма (`gated`)
- базовая политика гостя (что видит/куда пишет)
- подтверждение плана (preview: какие роли/каналы будут созданы)
- запуск деплоя

### 8.2. Требования к UX

- каждый шаг — **повторяемый** (назад/вперёд);
- по подтверждению показываем **diff/preview**: что будет создано/обновлено;
- в случае ошибки — безопасный retry (идемпотентность + очередь).

---

## 9. Команды (план справочника)

### 9.1. Setup / Deploy
- `/setup start` — начать мастер
- `/setup status` — текущий шаг/состояние
- `/setup cancel` — отменить сессию
- `/deploy preview` — показать план изменений (на основе активных конфигов)
- `/deploy apply` — применить (для админов/владельца)

### 9.2. Intake
- `/intake apply` — создать заявку (UI: кнопка + форма)
- `/intake list` — список заявок (для персонала)
- `/intake approve <id>` / `/intake reject <id> <reason>`

### 9.3. Discipline
- `/discipline warn @user <reason>`
- `/discipline list @user`
- `/discipline revoke <recordId> <reason>` (аннулирование отдельной записью)

### 9.4. Roles / Membership
- `/roles set-rank @user <rank>`
- `/roles add-position @user <position>`
- `/roles remove-position @user <position>`
- `/roles grant-clearance @user <clearance>`
- `/roles revoke-clearance @user <clearance>`

---

## 10. Дорожная карта (Roadmap)

### Фаза 0: Архитектура и домен (текущая)

- описать доменную модель, инварианты, зависимости модулей;
- определить конфиги и стратегию идемпотентного деплоя;
- зафиксировать жизненный цикл и принципы permission engine.

Готовность: этот документ.

### Фаза 1: MVP (SSO_RF + Setup Wizard + Idempotent Deploy)

- каркас приложения (слои, порты, инфраструктура);
- `TemplateRegistry` + валидация схемы;
- мастер `/setup` и сохранение `SetupSession`;
- `TemplateDeploymentService`:
  - роли + каналы + permission overwrites;
  - `discord_mappings` и fingerprint‑обновления;
  - очередь Discord API и retry/backoff;
- базовый intake:
  - канал «приёмная», создание заявки, approve/reject;
- журналы: audit‑канал, логирование ключевых действий.

### Фаза 2: Стабильность и эксплуатация

- расширенный preview/diff деплоя;
- инструменты восстановления:
  - повторная синхронизация маппингов;
  - ремонт отсутствующих объектов;
- расширенная защита от ошибочных прав (safety checks);
- метрики и трассировка (минимально);
- нагрузочные проверки на большом числе каналов/ролей.

### Фаза 3: Расширение

- дополнительные шаблоны (варианты подразделений/масштабов);
- мульти‑юнит на одном guild (опционально);
- миграция на Postgres (при необходимости);
- модуль учёта тренировок/мероприятий (опционально);
- интеграции (например, Arma roster внешним источником).

---

## 11. Внутренние конвенции

### 11.1. Именование

- **Ключи**: `UPPER_SNAKE` (`BASE_MEMBER`, `CH_RULES`, `POLICY_INTAKE`).
- **DTO**: `XxxDto`, команды: `XxxCommand`, use‑case: `XxxService`.
- **Порты**: `XxxGateway`, `XxxRepository`.

### 11.2. Логирование и аудит

- Любое изменение ролей/допусков/прав/решений по заявкам → **audit log** (канал + БД).
- Ошибки Discord API логируются с `requestId` и контекстом операции.

### 11.3. Обработка Discord rate limits

- Все операции создания/обновления Discord объектов проходят через **очередь**.
- Retry policy:
  - экспоненциальный backoff,
  - ограничение на общий таймаут,
  - строго идемпотентные операции (по ключу).

### 11.4. Безопасность

- Валидация прав: перед применением приватных политик проверяем, что у владельца/админа останется доступ (safety net).
- Команды, влияющие на структуру, доступны только:
  - владельцу сервера, либо
  - роли админов бота (по конфигу).

### 11.5. Тестируемость (контракт)

- Domain‑политики тестируются без Discord.
- Application use‑case тестируется через mock портов.
- Infrastructure тестируется минимально (интеграционные сценарии при возможности).

