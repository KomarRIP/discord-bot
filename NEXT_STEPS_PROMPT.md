# Промпт для продолжения разработки

## Контекст проекта

Ты продолжаешь разработку Discord бота для милсим подразделений Arma 3 в стиле ССО РФ. Это TypeScript проект с архитектурой на слоях: Domain, Application (use-cases), Infrastructure, Interface.

**Текущий этап:** Фаза 1 (MVP) — ~75% завершено

## Что уже реализовано

### ✅ Завершено

1. **Инфраструктура:**
   - SQLite storage с репозиториями (applications, members, audit_events, discord_mappings, и т.д.)
   - DiscordGateway с методами для работы с ролями, каналами, сообщениями
   - RateLimitQueue для ограничения запросов к Discord API
   - Система миграций БД

2. **Setup Wizard и Deployment:**
   - Полный мастер настройки (`SetupWizardService`)
   - Идемпотентный деплой структуры (`TemplateDeploymentService`)
   - Шаблон SSO_RF с ролями, каналами, политиками прав

3. **Intake (Приёмная):**
   - Полная система заявок на вступление (`IntakeService`)
   - Команды `/intake apply`, `/intake list`, `/intake approve`, `/intake reject`
   - Автоматическая публикация заявок в канал `CH_INTAKE_QUEUE`
   - Обновление статусов заявок в реальном времени
   - UI renderer (`intakeRenderer.ts`)

4. **Audit Log:**
   - `AuditLogService` для публикации событий в канал `CH_AUDIT`
   - Интеграция с IntakeService для событий ApplicationSubmitted, ApplicationApproved, ApplicationRejected

5. **DiscordGateway расширения:**
   - `sendMessage()`, `updateMessage()`, `ensureMessageWithEmbed()` для работы с embeds и components

## Что нужно реализовать

### 🎯 Следующий приоритет: Member Role Management (Этап 2)

**Цель:** Реализовать управление ролями участников (rank, position, clearance) через команды `/roles`.

**Детальный план:**

#### 1. Storage Layer (Инфраструктура) — НАЧАТЬ ОТСЮДА

**Файл:** `src/infra/storage/sqlite/repositories/memberRepository.ts` (возможно, нужно создать или проверить существование)

**Структура таблицы `members` (из `migrations/0001_initial.sql`):**
```sql
CREATE TABLE IF NOT EXISTS members (
  guildId TEXT NOT NULL,
  userId TEXT NOT NULL,
  rankRoleKey TEXT,  -- NULL или одно звание
  positionRoleKeysJson TEXT NOT NULL,  -- JSON массив строк
  clearanceRoleKeysJson TEXT NOT NULL,  -- JSON массив строк
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  PRIMARY KEY (guildId, userId)
);
```

**Задачи:**
- `MemberRepository` **НЕ существует** — нужно создать новый файл `src/infra/storage/sqlite/repositories/memberRepository.ts`
- Следовать паттерну из `applicationRepository.ts` (использовать `SqliteDb`, prepared statements)
- Определить типы:
  ```typescript
  export type MemberProfile = {
    guildId: string;
    userId: string;
    rankRoleKey: string | null;
    positionRoleKeysJson: string;  // JSON.stringify(string[])
    clearanceRoleKeysJson: string;  // JSON.stringify(string[])
    createdAt: string;
    updatedAt: string;
  };
  ```
- Реализовать методы:
  ```typescript
  getMemberProfile(guildId: string, userId: string): MemberProfile | null
  // Возвращает профиль или null
  
  upsertMember(params: {
    guildId: string;
    userId: string;
    rankRoleKey?: string | null;
    positionRoleKeysJson?: string;  // JSON массив
    clearanceRoleKeysJson?: string;  // JSON массив
  }): MemberProfile
  // Создание/обновление записи (ON CONFLICT ... DO UPDATE)
  
  // Вспомогательные методы (можно объединить в upsertMember с логикой):
  updateMemberRank(guildId: string, userId: string, rankRoleKey: string | null): MemberProfile
  addMemberPosition(guildId: string, userId: string, positionRoleKey: string): MemberProfile
  removeMemberPosition(guildId: string, userId: string, positionRoleKey: string): MemberProfile
  addMemberClearance(guildId: string, userId: string, clearanceRoleKey: string): MemberProfile
  removeMemberClearance(guildId: string, userId: string, clearanceRoleKey: string): MemberProfile
  ```

**Важно:**
- Использовать JSON.stringify/parse для работы с массивами positions и clearances
- В методах add/remove парсить JSON, добавлять/удалять элемент, сохранять обратно
- Проверять инварианты (максимум 1 rank, максимум 2 positions) в Application Layer, но можно и здесь
- Использовать `updatedAt` с текущим временем при обновлениях
- Если записи нет — создать с пустыми массивами в JSON

#### 2. Domain Layer (Политики валидации)

**Опционально, но рекомендуется для будущего расширения:**
- `RankPolicy`: валидация что roleKey существует в шаблоне и имеет type=rank
- `PositionPolicy`: валидация что roleKey существует и имеет type=position, проверка лимита
- `ClearancePolicy`: валидация что roleKey существует и имеет type=clearance

**Или:** валидацию можно делать непосредственно в Application Layer, обращаясь к `TemplateRegistry`.

#### 3. Application Layer (Use-cases)

**Файл:** `src/app/services/memberRoleManagementService.ts` (создать новый)

**Сервис должен:**
- Зависеть от: `Storage`, `DiscordGateway`, `TemplateRegistry` (или Storage для доступа к шаблону), `AuditLogService`
- Реализовать методы:
  ```typescript
  setRank(ctx: CommandContextDto, targetUserId: string, rankRoleKey: string | null): Promise<ResultDto>
  addPosition(ctx: CommandContextDto, targetUserId: string, positionRoleKey: string): Promise<ResultDto>
  removePosition(ctx: CommandContextDto, targetUserId: string, positionRoleKey: string): Promise<ResultDto>
  grantClearance(ctx: CommandContextDto, targetUserId: string, clearanceRoleKey: string): Promise<ResultDto>
  revokeClearance(ctx: CommandContextDto, targetUserId: string, clearanceRoleKey: string): Promise<ResultDto>
  getMemberProfile(ctx: CommandContextDto, userId: string): Promise<ResultDto>
  ```

**Логика каждого метода:**
1. Валидация: роль существует в шаблоне и имеет правильный тип (rank/position/clearance)
2. Проверка инвариантов через `MemberRepository` (например, лимит positions)
3. Получение Discord roleId через `storage.mappings.getMapping(guildId, "role", roleKey)`
4. Операция с Discord ролью через `discordGateway.addRoleToMember()` / `removeRoleFromMember()`
5. Обновление в БД через `MemberRepository`
6. Audit событие через `auditLogService.publishEvent()`
7. Возврат `ResultDto` с результатом

**Обработка ошибок:**
- Роль не найдена в шаблоне → `VALIDATION_FAILED`
- Лимит превышен → `LIMIT_EXCEEDED`
- Роль не найдена в Discord mappings → `NOT_FOUND` (возможно, деплой не выполнен)

#### 4. Interface Layer (Discord команды)

**Файл:** `src/interface/discord/commandDefinitions.ts`

**Добавить команды:**
```typescript
// В массив команд
{
  name: "roles",
  description: "Управление ролями участников",
  options: [
    {
      name: "set-rank",
      description: "Установить звание участнику",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "user", type: ApplicationCommandOptionType.User, required: true },
        { name: "rank", type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
      ],
    },
    {
      name: "add-position",
      description: "Добавить должность участнику",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        { name: "user", type: ApplicationCommandOptionType.User, required: true },
        { name: "position", type: ApplicationCommandOptionType.String, required: true, autocomplete: true },
      ],
    },
    // ... остальные команды (remove-position, grant-clearance, revoke-clearance)
  ],
}
```

**Файл:** `src/interface/discord/interactionRouter.ts`

**Добавить обработку:**
- В функции обработки команд добавить case для `commandName === "roles"`
- Проверка авторизации: `BASE_COMMAND` для set-rank, `BASE_STAFF` или `BASE_COMMAND` для остального
- Вызов соответствующих методов `MemberRoleManagementService`
- Обработка autocomplete для выбора ролей из шаблона (фильтрация по типу)

#### 5. Audit Log интеграция

**Файл:** `src/infra/audit/auditLogService.ts`

**Добавить поддержку событий:**
- `MemberRankSet`
- `MemberPositionAdded`
- `MemberPositionRemoved`
- `MemberClearanceGranted`
- `MemberClearanceRevoked`

**В метод `buildAuditEmbed()` добавить case'ы для этих событий.**

## Важные паттерны и конвенции

1. **Структура проекта:**
   - `src/app/services/` — use-cases (Application Layer)
   - `src/infra/storage/sqlite/repositories/` — репозитории (Storage Layer)
   - `src/infra/discord/` — адаптеры Discord API (Infrastructure Layer)
   - `src/interface/discord/` — команды и интеракции (Interface Layer)

2. **Обработка ошибок:**
   - Использовать `AppError` для доменных ошибок
   - Возвращать `ResultDto<...>` из сервисов
   - Graceful degradation: ошибки публикации в Discord каналы не должны прерывать основной процесс

3. **Авторизация:**
   - Использовать `mustHaveRole()` / `mustHaveAnyRole()` в `interactionRouter.ts`
   - Проверки: `BASE_COMMAND` для set-rank, `BASE_STAFF`/`BASE_COMMAND` для остального

4. **Идемпотентность:**
   - Все операции с ролями должны быть идемпотентными
   - Проверять дубликаты перед добавлением

5. **Audit:**
   - Все изменения ролей должны логироваться в БД и публиковаться в `CH_AUDIT`
   - Использовать `AuditLogService.publishEvent()`

## Ресурсы для справки

1. **Документация:**
   - `docs/current-status-and-plan.md` — текущий статус и план
   - `docs/specs/member-role-management.md` — спецификация управления ролями
   - `docs/core.md` — общая архитектура
   - `docs/specs/commands-mvp.md` — контракт команд

2. **Примеры кода:**
   - `src/app/services/intakeService.ts` — пример реализации use-case
   - `src/infra/storage/sqlite/repositories/applicationRepository.ts` — пример репозитория
   - `src/infra/audit/auditLogService.ts` — пример audit log сервиса

3. **Схема БД:**
   - Проверить `migrations/0001_initial.sql` для структуры таблицы `members`

## Начало работы

**Порядок действий:**
1. Проверить/создать `MemberRepository` с нужными методами
2. Создать `MemberRoleManagementService` с базовой структурой
3. Реализовать один метод полностью (например, `setRank`) для проверки паттерна
4. Добавить команды в `commandDefinitions.ts`
5. Интегрировать в `interactionRouter.ts`
6. Добавить поддержку событий в `AuditLogService`
7. Повторить для остальных методов

**При возникновении вопросов:**
- Изучи существующий код (особенно `IntakeService` и `intakeService.ts`)
- Следуй паттернам, которые уже используются в проекте
- Проверяй документацию в `docs/specs/`

**Удачи! 🚀**

