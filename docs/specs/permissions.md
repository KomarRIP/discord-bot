## Permission DSL и компиляция в Discord Overwrites

Этот документ определяет, как шаблоны описывают права (`policies`) и как они превращаются в Discord permission overwrites.

Цель: **однозначный, расширяемый и проверяемый** язык политик, чтобы логика прав оставалась config-driven.

---

## 1. Базовые понятия

### 1.1. Principal (кому выдаём/запрещаем)

В MVP поддерживаем только:

- `@everyone`
- `ROLE:<RoleKey>` (роль из `template.roles`)

Позже (фаза 2+) допускаются:
- `USER:<userId>` (точечные исключения)
- `DYNAMIC:<groupKey>` (динамические группы вроде STAFF, если шаблон определяет)

### 1.2. Permission (что разрешаем/запрещаем)

Используем список **действий Discord**, например:

- `ViewChannel`
- `ReadMessageHistory`
- `SendMessages`
- `ManageChannels`
- `ManageRoles`

В конфиге храним как строки (в дальнейшем можно ввести строгий enum).

---

## 2. Формат policy (JSON)

### 2.1. Минимальная форма (как в core.md)

```json
{
  "deny": ["@everyone:ViewChannel"],
  "allow": ["ROLE:BASE_MEMBER:ViewChannel", "ROLE:BASE_MEMBER:SendMessages"]
}
```

Грамматика строки правила:

- `@everyone:<Permission>`
- `ROLE:<RoleKey>:<Permission>`

### 2.2. Рекомендуемая расширенная форма (структурная)

Для удобства валидации и расширения предпочтительнее структурная форма:

```json
{
  "rules": [
    { "principal": { "type": "everyone" }, "effect": "deny", "permissions": ["ViewChannel"] },
    { "principal": { "type": "role", "roleKey": "BASE_MEMBER" }, "effect": "allow", "permissions": ["ViewChannel", "SendMessages", "ReadMessageHistory"] }
  ]
}
```

MVP может поддержать обе формы, но **внутренняя модель** всегда приводится к структурной.

---

## 3. Нормализация и приоритеты

### 3.1. Нормализация

- Дубликаты правил схлопываются.
- Если для одного principal и permission есть и allow, и deny — считаем это **ошибкой конфигурации** (чтобы не разъезжалась логика между слоями).

### 3.2. Приоритеты (важно)

Discord сам применяет комбинацию ролей/overwrites. Чтобы поведение было предсказуемым:

- Политика должна быть **самодостаточной**: в одном policyKey задаём полный набор overwrites для канала/категории.
- Применение в MVP: режим `replace` — то есть конечные overwrites совпадают с политикой.

---

## 4. Компиляция в overwrites

### 4.1. Шаги компиляции

Для `policyKey` и `guildId`:

1) разрешить principals:
   - `@everyone` -> `guildId` everyone-role id (из Discord)
   - `ROLE:<RoleKey>` -> `discordId` через `discord_mappings` (или из результата ensureRole на текущем деплое)
2) преобразовать permissions в битовые allow/deny маски
3) сформировать список `PermissionOverwrite` и отсортировать (детерминированно)

### 4.2. Детерминированность

Для стабильного fingerprint:
- сортируем overwrites по `(principalType, principalId)` и внутри — по списку permissions.

---

## 5. Валидации (до деплоя)

Шаблон обязан пройти проверки:

- все `policyKey`, используемые в `channels[*].policyKey`, существуют;
- все `ROLE:<RoleKey>` ссылаются на роль, объявленную в `template.roles`;
- нет конфликтов allow/deny внутри одного principal;
- permissions — из допустимого набора (минимально: белый список, чтобы ловить опечатки).

---

## 6. Категории и наследование

В MVP **не используем неявное наследование** политик:

- категория получает собственную policyKey;
- каналы получают собственную policyKey (даже если совпадает по содержанию).

Причина: иначе тяжело объяснять пользователю итоговые права и строить preview/diff.

Фаза 2: можно добавить `inheritFromParent: true`, но только при строгой спецификации.

