## Interface Layer (Discord): UX‑паттерны, DTO и модель ошибок

Цель: стандартизировать поведение интеракций (slash‑команды, кнопки, селекты, модалки),
чтобы UI не тянул бизнес‑логику, а use‑case’ы оставались чистыми.

Связанные документы:
- `docs/core.md` — архитектурные слои и use‑case’ы
- `docs/specs/preview-and-diff.md` — формат `DeploymentPreview`
- `docs/specs/deployment.md` — классы ошибок и retry‑правила

---

## 1. Принципы UX (MVP)

- **Понятность**: каждое действие должно завершаться явным результатом (успех/ошибка/что делать дальше).
- **Безопасность**: опасные операции — только через подтверждение (кнопка/двойной шаг).
- **Ephemeral по умолчанию** для админских операций и ошибок (не засоряем каналы).
- **Публичные сообщения** — только там, где это процессом требуется (например, карточка заявки в очереди).
- **Детерминированные кнопки**: customId содержит тип операции и ключ (но без секретов).

---

## 2. Стандартные паттерны интеракций

### 2.1. Wizard pattern (Setup Wizard)

Свойства:
- шаги имеют `stepKey`
- каждое действие пользователя обновляет `SetupSession`
- кнопки:
  - `Back`
  - `Next`
  - `Cancel`
  - `Confirm` (на финальном шаге)

Контракт:
- UI слой **не** изменяет Discord‑структуру напрямую, только вызывает `SetupWizardService` и рендерит ответы.

### 2.2. Preview → Confirm → Apply (Deploy)

Поток:
- `/deploy preview` → embed + summary + warnings
- кнопка `Apply` → повторная проверка safety → запуск `TemplateDeploymentService`
- кнопка `Show details` → пагинация списка шагов

Контракт:
- preview всегда строится из валидированного desired state (см. `preview-and-diff.md`).

### 2.3. Queue card pattern (Intake)

Карточка в `CH_INTAKE_QUEUE`:
- кнопки переходов состояния (`Взять`, `Одобрить`, `Отклонить`)
- при нажатии:
  - проверка авторизации
  - попытка статусного перехода (с optimistic check)
  - редактирование карточки (а не новое сообщение)

---

## 3. DTO‑контракты (между Interface и Application)

### 3.1. CommandContextDto

Минимальный контекст, который UI обязан передавать:
- `guildId`
- `channelId`
- `actorUserId`
- `requestId` (генерируется на каждую команду/интеракцию)
- `locale` (опционально)

### 3.2. InteractionRefDto

Для привязки «ответов» и редактирования сообщений:
- `interactionId`
- `replyMode`: `ephemeral|public`
- `messageId` (если это update существующего сообщения)

### 3.3. Use‑case входы

Каждый use‑case принимает:
- контекст (`CommandContextDto`)
- входные параметры (DTO конкретной команды)

Возвращает:
- `ResultDto` (см. раздел 4)

---

## 4. Модель результата (ResultDto)

Единый формат для UI:

### 4.1. Success

- `type: "success"`
- `title`
- `message`
- `data` (опционально, для рендера)
- `nextActions` (опционально, список кнопок/ссылок)

### 4.2. Failure

- `type: "error"`
- `errorCode` (см. ниже)
- `userMessage` (человеческий текст)
- `details` (опционально, для логов/диагностики)
- `retryable: boolean`

---

## 5. Ошибки: словарь и маппинг в UX

### 5.1. Канонические errorCode (MVP)

- `VALIDATION_FAILED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `RATE_LIMITED`
- `TRANSIENT_FAILURE`
- `SAFETY_LOCKOUT_RISK`
- `NOT_INSTALLED` (шаблон/деплой не применён)

### 5.2. Рендеринг ошибок

- `FORBIDDEN`: «Недостаточно прав. Требуется роль …»
- `VALIDATION_FAILED`: «Некорректный ввод: …»
- `CONFLICT`: «Состояние изменилось. Обновите preview/повторите действие.»
- `RATE_LIMITED/TRANSIENT_FAILURE`: «Временная проблема. Повторите позже.» + `retryable=true`
- `SAFETY_LOCKOUT_RISK`: «Операция может заблокировать доступ владельцу. Применение запрещено.»

Принцип: пользователю не показываем raw stack trace и токены; `requestId` показываем для обращения.

---

## 6. CustomId для кнопок/селектов

Требования:
- не превышать ограничения Discord по длине
- не хранить секреты/PII (кроме публичных ID)
- быть парсируемым

Рекомендуемый формат:

`<namespace>:<action>:<version>:<payload>`

Примеры:
- `deploy:apply:v1:deploymentId=<id>`
- `intake:approve:v1:appId=<id>`
- `wizard:next:v1:sessionId=<id>`

Payload лучше кодировать как `key=value` с ограничением длины, либо компактным JSON → base64url (если понадобится).

---

## 7. Пагинация и ограничения Discord

MVP‑правила:
- список деталей preview выдаём страницами (например 10 пунктов на страницу)
- хранить позицию пагинации можно:
  - в customId (номер страницы) + пересборка preview, либо
  - в кратком кеше (фаза 2)

---

## 8. Логи и трассировка UI

UI слой обязан логировать:
- `requestId`, `actorUserId`, `guildId`
- `commandName` / `interactionType`
- результат (success/errorCode)

Это связывает пользовательские жалобы с audit‑логами и deployment_steps.

