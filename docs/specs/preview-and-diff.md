## Preview/Diff деплоя (что показываем пользователю)

Цель: перед применением деплоя пользователь должен увидеть **понятный план изменений**, а администратор — оценить риски (особенно права).

Этот документ задаёт формат `DeploymentPreview`.

---

## 1. Требования к preview

- **Детерминированность**: одинаковый вход → одинаковый вывод.
- **Краткое summary** + возможность раскрыть детали.
- **Причины**: почему `create/update/skip`.
- **Безопасность**: явно подсветить изменения, которые могут «закрыть доступ».
- **Идентичность**: показать `templateId`, `templateVersion`, `schemaVersion`.

---

## 2. Структура DeploymentPreview (концептуально)

### 2.1. Header

- `guildId`
- `templateId`, `templateVersion`, `schemaVersion`
- `deploymentConfigHash`
- `generatedAt`

### 2.2. Summary

- `roles`: created/updated/skipped
- `categories`: created/updated/skipped
- `channels`: created/updated/skipped
- `overwrites`: updated/skipped (обычно overwrites либо replace, либо skip)
- `messages`: created/updated/skipped
- `warnings`: список предупреждений (например safety risk)

### 2.3. Items (упорядоченный список шагов)

Каждый пункт:

- `scope`: `role|category|channel|overwrites|message`
- `key`: `RoleKey|ChannelKey|MessageKey`
- `action`: `create|update|skip`
- `reason`: короткая причина (`missing_mapping`, `missing_in_discord`, `fingerprint_changed`, `unchanged`)
- `managedName`: ожидаемое имя (важно для adoption)
- `before`: минимальный snapshot (если известен)
- `after`: целевой snapshot (из DesiredState)

---

## 3. Как формировать `before/after`

### 3.1. Роли

- `before`: имя/цвет/mentionable/hoist (если удалось прочитать по id)
- `after`: то же + `roleKey`

### 3.2. Каналы/категории

- `before`: имя/тип/parent (по возможности)
- `after`: имя/тип/parentKey/policyKey

### 3.3. Overwrites

Только «свернуто»:
- principals count
- основные deny/allow

Подробности — в раскрывающемся режиме (UI), но формат должен позволять вывести diff списком.

---

## 4. Safety warnings (минимум)

Preview обязан вычислять предупреждения:

- **RISK_LOCKOUT**: если после применения политик:
  - ownerId не получает `ViewChannel` к `CH_AUDIT` и/или к «публичному» минимуму,
  - и нет роли `SYS_BOT_ADMIN` (или другой админ‑роли) в allow.

В MVP: при `RISK_LOCKOUT` запрещаем `apply` без явного override (а override — только владельцу guild).

---

## 5. UX выдача в Discord (MVP ориентир)

Для `/deploy preview`:

- embed:
  - шаблон/версии
  - summary counts
  - warnings (если есть)
- кнопки:
  - `Apply`
  - `Cancel`
  - `Show details` (страницы/пагинация)

Примечание: это не реализация, а контракт того, что preview содержит достаточную информацию для UX.

