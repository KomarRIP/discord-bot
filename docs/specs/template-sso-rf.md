## Шаблон `SSO_RF` (MVP) — спецификация

Цель шаблона: дать «минимально рабочую» структуру подразделения в стиле ССО РФ для \~18 активных + гостей:

- публичная зона (правила/объявления/общение),
- приёмная (заявки),
- служебные зоны (штаб/оперативка),
- журналы (audit),
- базовая иерархия ролей: базовые, звания, должности, допуски.

Шаблон не обязан покрывать весь реализм; он обязан быть **строгим, предсказуемым и расширяемым**.

---

## 1. Роли (RoleSpec)

### 1.1. Базовые

- `BASE_GUEST` — Гость (видит публичное + приёмную)
- `BASE_MEMBER` — Боец (основной участник)
- `BASE_STAFF` — Персонал (канцелярия/кадры/администраторы unit)
- `BASE_COMMAND` — Командование (утверждения, доступ к штабным зонам)

### 1.2. Звания (взаимоисключающие)

MVP‑набор (может расширяться):

- `RANK_RYADOVOY` — Рядовой
- `RANK_EFREITOR` — Ефрейтор
- `RANK_ML_SERZHANT` — Мл. сержант
- `RANK_SERZHANT` — Сержант
- `RANK_STARSHINA` — Старшина
- `RANK_LEITENANT` — Лейтенант
- `RANK_ST_LEITENANT` — Ст. лейтенант
- `RANK_KAPITAN` — Капитан

Инвариант: у участника 0..1 rank.

### 1.3. Должности (0..2 на участника)

MVP‑набор:

- `POS_OTDEL_LEAD` — Командир отделения
- `POS_ZAM_OTDEL_LEAD` — Зам. командира отделения
- `POS_MEDIC` — Медик
- `POS_RTO` — Связист
- `POS_SAPPER` — Сапёр
- `POS_INSTRUCTOR` — Инструктор

### 1.4. Допуски/грифы

MVP‑набор:

- `CLR_DSP` — ДСП
- `CLR_SECRET` — Секретно

Инвариант: выдача/снятие допусков всегда логируется.

### 1.5. Системные роли

- `SYS_BOT_ADMIN` — роль, которой разрешены команды управления ботом (опционально; может задаваться как внешняя конфигурация unit)

---

## 2. Структура каналов (ChannelSpec)

### 2.1. Категории

- `CAT_PUBLIC` — Общее
- `CAT_INTAKE` — Приёмная
- `CAT_MEMBER` — Личный состав
- `CAT_STAFF` — Служебное
- `CAT_LOGS` — Журналы

### 2.2. Каналы (минимум)

**Общее**
- `CH_RULES` (text) — правила
- `CH_ANNOUNCE` (text) — объявления
- `CH_GENERAL` (text) — общий чат

**Приёмная**
- `CH_INTAKE` (text) — подача заявок/вопросы
- `CH_INTAKE_QUEUE` (text) — очередь заявок (видит персонал)

**Личный состав**
- `CH_BRIEFING` (text) — вводные/расписание
- `CH_ROSTER` (text) — состав/структура (позже)

**Служебное**
- `CH_HQ` (text) — штаб/оперативка
- `CH_STAFF` (text) — персонал (кадры/организационные)

**Журналы**
- `CH_AUDIT` (text) — аудит действий бота и ключевых решений

---

## 3. Политики доступа (policyKey)

Схема политик описана в `docs/specs/permissions.md`.

### 3.1. Публичные

- `POLICY_PUBLIC_READWRITE`
  - allow `@everyone`: ViewChannel, ReadMessageHistory, SendMessages
- `POLICY_PUBLIC_READONLY`
  - allow `@everyone`: ViewChannel, ReadMessageHistory
  - deny `@everyone`: SendMessages

### 3.2. Приёмная

- `POLICY_INTAKE_PUBLIC`
  - deny `@everyone`: ViewChannel
  - allow `ROLE:BASE_GUEST`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:BASE_STAFF`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:BASE_COMMAND`: ViewChannel, ReadMessageHistory, SendMessages

- `POLICY_INTAKE_QUEUE_STAFF_ONLY`
  - deny `@everyone`: ViewChannel
  - allow `ROLE:BASE_STAFF`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:BASE_COMMAND`: ViewChannel, ReadMessageHistory, SendMessages

### 3.3. Личный состав

- `POLICY_MEMBER`
  - deny `@everyone`: ViewChannel
  - allow `ROLE:BASE_MEMBER`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:BASE_STAFF`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:BASE_COMMAND`: ViewChannel, ReadMessageHistory, SendMessages

### 3.4. Служебное / штаб

- `POLICY_HQ_SECRET`
  - deny `@everyone`: ViewChannel
  - allow `ROLE:BASE_COMMAND`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:BASE_STAFF`: ViewChannel, ReadMessageHistory, SendMessages
  - allow `ROLE:CLR_SECRET`: ViewChannel, ReadMessageHistory

Комментарий: в MVP доступ «по грифу» даёт чтение, а писать могут staff/command. Это дисциплинирует и проще для модерации.

### 3.5. Журналы

- `POLICY_AUDIT_STAFF_ONLY`
  - deny `@everyone`: ViewChannel
  - allow `ROLE:BASE_STAFF`: ViewChannel, ReadMessageHistory
  - allow `ROLE:BASE_COMMAND`: ViewChannel, ReadMessageHistory

---

## 4. Интейк (процесс заявок) — MVP договорённость

### 4.1. UX в приёмной

В `CH_INTAKE` бот публикует закреплённое сообщение:
- кратко «как подать заявку»,
- кнопка/команда для создания заявки,
- ссылка на правила.

### 4.2. Жизненный цикл заявки

Соответствует доменной машине состояний из `docs/core.md`:
`draft -> submitted -> under_review -> approved|rejected` (+ `cancelled`).

### 4.3. Что происходит при approved

MVP‑правило:
- заявителю назначается `BASE_MEMBER` (и снимается `BASE_GUEST`, если было),
- создаётся audit‑запись,
- в `CH_INTAKE_QUEUE` публикуется итог.

---

## 5. Дисциплина — MVP договорённость

В MVP дисциплина реализуется как:

- команда staff/command создаёт `DisciplineRecord`;
- бот пишет запись в `CH_AUDIT`.

Эскалации (например, авто‑снятие доступа) — фаза 2.

