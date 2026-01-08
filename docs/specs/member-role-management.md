## Управление ролями участника (rank/position/clearance) и авторизация команд

Этот документ формализует поведение команд управления ролями и политику «кто что может назначать».
Цель: исключить «дырки» в правах и обеспечить воспроизводимый аудит.

Связанные документы:
- `docs/core.md` — доменные инварианты (0..1 rank, 0..2 positions, append-only discipline)
- `docs/specs/permissions.md` — модель прав на каналы
- `docs/specs/template-sso-rf.md` — набор ролей и их смысл

---

## 1. Модель ролей на участнике (в терминах домена)

### 1.1. Состояние MemberProfile

- `base`: базовые роли (в MVP считаем, что участник в итоге имеет одну из:
  - `BASE_GUEST` (гость),
  - `BASE_MEMBER` (боец),
  - дополнительно может иметь `BASE_STAFF`/`BASE_COMMAND` как «служебные надстройки»)
- `rank`: 0..1 (взаимоисключающий набор)
- `positions`: 0..N (в MVP N=2 по `unit.positionsLimitPerMember`)
- `clearances`: 0..N

### 1.2. Инварианты (обязательные)

- **Rank exclusivity**: нельзя иметь два rank одновременно.
- **Position limit**: нельзя превысить лимит positions.
- **Base role consistency**:
  - `BASE_GUEST` и `BASE_MEMBER` не должны быть вместе.
  - выдача `BASE_MEMBER` должна снимать `BASE_GUEST` (если есть).
- **Auditability**:
  - любое изменение rank/position/clearance/base фиксируется как audit‑событие (intent + result).

---

## 2. Команды (контракты поведения)

Ниже перечислены команды уровня Application Layer. Их UI‑форма может быть slash‑командой, кнопкой или модалкой — это не влияет на контракт.

### 2.1. Rank

#### `SetRank(targetUserId, rankRoleKey | null)`

Эффект:
- если `rankRoleKey` задан:
  - снять текущий rank (если есть),
  - выдать новый rank
- если `rankRoleKey = null`:
  - снять текущий rank

Ошибки:
- `ValidationError`: `rankRoleKey` не существует в шаблоне или не `type=rank`
- `Forbidden`: актор не имеет полномочий (см. раздел 3)

#### `ListRanks()`

Возвращает список rank’ов из шаблона (для UI выбора).

### 2.2. Positions

#### `AddPosition(targetUserId, positionRoleKey)`

Эффект:
- если позиция уже есть — `skip` (идемпотентно)
- иначе добавить, если не превышен лимит

Ошибки:
- `ValidationError`: ключ не `type=position`
- `LimitExceeded`: достигнут лимит positions

#### `RemovePosition(targetUserId, positionRoleKey)`

Эффект:
- если позиции нет — `skip`
- иначе снять

### 2.3. Clearances

#### `GrantClearance(targetUserId, clearanceRoleKey)`

Эффект:
- если допуск уже есть — `skip`
- иначе выдать допуск

Дополнительные проверки (MVP минимум):
- clearanceRoleKey должен быть `type=clearance`

Фаза 2 (план):
- требования по минимальному rank/position (policy-driven)

#### `RevokeClearance(targetUserId, clearanceRoleKey)`

Эффект:
- если допуска нет — `skip`
- иначе снять

### 2.4. Base membership (интейк и ручное управление)

#### `PromoteToMember(targetUserId)`

Эффект:
- выдать `BASE_MEMBER`
- снять `BASE_GUEST` (если есть)

Применение:
- вызывается `IntakeService` при `approved`
- может быть отдельной командой для staff/command

#### `DemoteToGuest(targetUserId)` (осторожно)

Эффект:
- выдать `BASE_GUEST`
- снять `BASE_MEMBER`
- опционально снять rank/positions/clearances (в MVP — **не снимаем автоматически**, только предупреждаем)

---

## 3. Авторизация (кто может выполнять команды)

### 3.1. Источник истины

В MVP вводим простую политику:

- `BASE_COMMAND` может:
  - всё из списка (rank/position/clearance/base)
- `BASE_STAFF` может:
  - positions/clearances/base (кроме «опасных»), но **не** повышающие привилегии command
- владелец guild (ownerId) может всё (safety override)
- `SYS_BOT_ADMIN` (если используется) может всё, но только в рамках «бот‑операций» (deploy/repair/diagnose)

### 3.2. Запрещённые операции (MVP guardrails)

- `BASE_STAFF` не может выдавать `BASE_COMMAND`.
- никто, кроме ownerId, не может менять роли бота.

### 3.3. Policy как конфиг (план фазы 2)

Переносим правила в конфиг:

```json
{
  "roleManagement": {
    "setRank": ["BASE_COMMAND"],
    "addPosition": ["BASE_STAFF", "BASE_COMMAND"],
    "grantClearance": ["BASE_STAFF", "BASE_COMMAND"],
    "promoteToMember": ["BASE_STAFF", "BASE_COMMAND"]
  }
}
```

MVP: захардкоженный policy в Domain/Application допустим, но с чётким интерфейсом для будущего конфиг‑переноса.

---

## 4. Аудит событий (минимальный словарь)

Каждая операция пишет:

1) intent: что хотели сделать
2) result: что получилось (changed/skip) + финальное состояние

Рекомендуемые типы событий:

- `MemberRankSet`
- `MemberPositionAdded`
- `MemberPositionRemoved`
- `MemberClearanceGranted`
- `MemberClearanceRevoked`
- `MemberPromotedToMember`
- `MemberDemotedToGuest`

Payload (sanitized):
- `guildId`, `actorUserId`, `targetUserId`
- `roleKey` (если применимо)
- `changed: boolean`
- `reason` (строка/enum)
- `timestamp`

---

## 5. Согласованность с Discord (источник ролей)

Правило: доменная модель оперирует `RoleKey`, а инфраструктура — Discord roleId.

Требование к реализации:
- перед выдачей роли use‑case должен убедиться, что mapping для `RoleKey` существует (шаблон уже задеплоен), иначе:
  - либо возвращаем `Conflict` («шаблон не применён / роли не созданы»),
  - либо инициируем `deploy repair` (опционально, только для админов).

