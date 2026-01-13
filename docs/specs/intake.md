## Intake (приёмная/пропускной режим): заявки, очередь, решения

Цель: обеспечить «входной контур» подразделения:

- гость подаёт заявку в понятном UX,
- персонал рассматривает по стандартному процессу,
- решение автоматически отражается в ролях и аудит‑журналах,
- процесс устойчив к перезапускам и дублированию.

Связанные документы:
- `docs/core.md` — доменная сущность `IntakeApplication` и статусы
- `docs/specs/template-sso-rf.md` — каналы `CH_INTAKE`, `CH_INTAKE_QUEUE`
- `docs/specs/member-role-management.md` — `PromoteToMember`
- `docs/specs/ports.md` — `IntakeRepository`, `AuditLogPort`

---

## 1. Типы заявок (MVP)

В MVP поддерживаем минимум:

- `join` — вступление в подразделение (из гостя в бойца)

Фаза 2 (план):
- `transfer` — перевод между unit’ами (если появится мульти‑unit)
- `clearance` — запрос допуска (`CLR_DSP/CLR_SECRET`)
- `position` — запрос должности

---

## 2. Поля заявки (join) — контракт

### 2.1. Минимальные поля (обязательные)

- `nickname` — позывной/ник в подразделении
- `age` — возраст (число)
- `timezone` — например `MSK`/`UTC+3`
- `availability` — когда доступен (строка/варианты)
- `armaExperience` — опыт (кратко)
- `milsimExperience` — опыт милсима (кратко)
- `micAndMods` — микрофон/готовность к модпаку (bool/строка)
- `whyUnit` — мотивация (кратко)

### 2.2. Метаданные (системные)

- `applicationId`
- `guildId`
- `applicantUserId`
- `status`
- `createdAt/updatedAt`
- `decisionByUserId/decisionAt/decisionReason` (после решения)

---

## 3. UX и сообщения в Discord (MVP)

### 3.1. «Пост‑инструкция» в `CH_INTAKE`

При деплое шаблон публикует закреплённое сообщение:

- краткие правила подачи заявки;
- кнопка **«Подать заявку»** (или slash‑команда `/intake apply`);
- предупреждение «одна активная заявка на пользователя».

Сообщение — `ensureMessage` с `messageKey` (чтобы не плодить дубликаты).

### 3.2. Создание заявки

Пользователь запускает модалку/форму, отправляет поля.

Ограничения:
- если у пользователя есть активная заявка `submitted/under_review` — вернуть понятное сообщение и ссылку на неё.

### 3.3. Очередь рассмотрения (`CH_INTAKE_QUEUE`)

При `submitted` бот публикует карточку заявки в `CH_INTAKE_QUEUE`:

- кто подал (mention),
- ключевые поля (сокращённо),
- статус,
- кнопки: `Взять в работу`, `Одобрить`, `Отклонить`, `Запросить уточнение` (последнее — фаза 2).

Карточка должна быть идемпотентной:
- `messageKey = application:<applicationId>`
- обновления статуса редактируют существующее сообщение.

---

## 4. Машина состояний (MVP)

Поддерживаем доменную модель из `docs/core.md`.

### 4.1. Переходы

- `draft -> submitted` (подача)
- `submitted -> under_review` (кто-то взял в работу)
- `under_review -> approved` (одобрение)
- `under_review -> rejected` (отклонение)
- `draft/submitted/under_review -> cancelled` (отмена пользователем)

### 4.2. Инварианты

- на одного `applicantUserId` максимум одна активная заявка (`submitted` или `under_review`) на тип `join`.
- переходы фиксируются атомарно в storage (optimistic concurrency или транзакция).

---

## 5. Авторизация действий по заявкам

### 5.1. Кто может что делать (MVP)

- `submit/cancel` — автор заявки
- `under_review/approve/reject` — роли:
  - `BASE_STAFF` и `BASE_COMMAND`
- ownerId может всё (override)

### 5.2. Правила ответственности

- тот, кто нажал `Взять в работу`, становится `assigneeUserId` (храним в payload или отдельном поле в фазе 2).
- в MVP допускается «без ассайна» (любой staff/command может approve/reject), но событие всегда логируется.

---

## 6. Эффекты решения (approved/rejected)

### 6.1. Approved (MVP)

- вызвать `PromoteToMember(applicantUserId)`
  - выдать `BASE_MEMBER`
  - снять `BASE_GUEST`
- создать audit‑событие `ApplicationApproved`
- обновить карточку заявки в `CH_INTAKE_QUEUE`
- ответить пользователю в `CH_INTAKE` (или в DM, если разрешено) с инструкциями «что дальше»

### 6.2. Rejected (MVP)

- роль не меняем
- audit‑событие `ApplicationRejected` с `decisionReason` (обязательное поле)
- обновить карточку
- уведомить пользователя (канал/DM)

---

## 7. Данные и хранение

### 7.1. `applications`

Схема таблицы описана в `docs/specs/storage-schema-and-migrations.md`.

### 7.2. Идемпотентность

- создание заявки: `applicationId` генерируется один раз; повторное нажатие на submit при сетевой ошибке должно либо:
  - вернуть уже созданную заявку, либо
  - создать новую, но при этом старую перевести в `cancelled` (в MVP лучше первая стратегия)
- публикация карточки в очереди: через `ensureMessage` по `messageKey`.

---

## 8. Аудит событий (минимальный словарь)

- `ApplicationSubmitted`
- `ApplicationMovedToUnderReview`
- `ApplicationApproved`
- `ApplicationRejected`
- `ApplicationCancelled`

Payload (sanitized):
- `applicationId`, `type`, `status`
- `actorUserId` (кто сделал переход)
- `applicantUserId`
- `decisionReason` (для reject)

---

## 9. SLA и эксплуатация (план)

MVP:
- SLA не enforced, только метка времени.

Фаза 2:
- напоминания staff при «зависших» заявках,
- отчёт по очереди: сколько заявок > 24/48 часов.

