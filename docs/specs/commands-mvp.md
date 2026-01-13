## Команды и интеракции (MVP): контракт справочника

Цель: зафиксировать «публичный API» бота (на уровне Discord), чтобы:

- UI слой был согласованным,
- use‑case’ы были покрыты,
- команды не разрастались хаотично.

Это **план справочника** (командный контракт), реализация может отличаться в деталях UI.

---

## 1. Глобальные правила

- Все команды работают только в guild (не в DM), кроме уведомлений (опционально).
- Админские команды отвечают **ephemeral** по умолчанию.
- Любое действие, меняющее структуру/роли/статусы, пишет audit‑событие.

---

## 2. Setup

### `/setup start`

Назначение: начать мастер настройки.

Доступ: ownerId / `SYS_BOT_ADMIN` / (опционально) admin guild.

Ответ:
- wizard UI (см. `docs/specs/discord-ui-and-errors.md`)

### `/setup status`

Назначение: показать текущий прогресс setup session.

Доступ: ownerId / `SYS_BOT_ADMIN`.

### `/setup cancel`

Назначение: отменить активную setup session.

Доступ: ownerId / `SYS_BOT_ADMIN`.

---

## 3. Deploy

### `/deploy preview`

Назначение: показать план изменений.

Доступ: ownerId / `SYS_BOT_ADMIN`.

Возвращает:
- `DeploymentPreview` (см. `docs/specs/preview-and-diff.md`)

### `/deploy apply`

Назначение: применить план (или пересобрать и применить).

Доступ: ownerId / `SYS_BOT_ADMIN`.

Поведение:
- повторная safety‑проверка
- запуск `TemplateDeploymentService`
- прогресс/итог в ephemeral + запись в `CH_AUDIT`

### `/deploy diagnose`

Назначение: диагностика рассинхронизаций.

Доступ: ownerId / `SYS_BOT_ADMIN`.

### `/deploy repair`

Назначение: безопасное восстановление (reconciliation).

Доступ: ownerId / `SYS_BOT_ADMIN`.

---

## 4. Intake

### `/intake apply`

Назначение: подать заявку (join).

Доступ: `BASE_GUEST` (и выше).

### `/intake cancel`

Назначение: отменить свою активную заявку.

Доступ: автор заявки.

### `/intake list`

Назначение: список заявок по статусам.

Доступ: `BASE_STAFF`, `BASE_COMMAND`.

### `/intake approve <applicationId> [reason]`
### `/intake reject <applicationId> <reason>`

Назначение: решение по заявке.

Доступ: `BASE_STAFF`, `BASE_COMMAND`.

Примечание: в MVP эти действия удобнее делать кнопками в `CH_INTAKE_QUEUE`, но slash‑команды полезны как резервный путь.

---

## 5. Roles (membership)

### `/roles set-rank @user <rank|none>`

Доступ: `BASE_COMMAND`.

### `/roles add-position @user <position>`
### `/roles remove-position @user <position>`

Доступ: `BASE_STAFF`, `BASE_COMMAND`.

### `/roles grant-clearance @user <clearance>`
### `/roles revoke-clearance @user <clearance>`

Доступ: `BASE_STAFF`, `BASE_COMMAND`.

---

## 6. Discipline

### `/discipline add @user <note|warning> <severity 1..5> <reason> [expiresAt]`

Доступ: `BASE_STAFF`, `BASE_COMMAND`.

### `/discipline list @user [limit]`

Доступ: `BASE_STAFF`, `BASE_COMMAND` (и опционально сам пользователь — фаза 2).

