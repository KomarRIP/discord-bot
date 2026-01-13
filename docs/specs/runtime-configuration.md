## Runtime конфигурация: env/config, режимы, feature flags

Цель: стандартизировать запуск бота и отделить «операционные» настройки от доменных конфигов шаблонов.

Связанные документы:
- `docs/core.md` — архитектура и жизненный цикл
- `docs/specs/template-sso-rf.md` — шаблон
- `docs/specs/discord-ui-and-errors.md` — requestId/логирование

---

## 1. Типы конфигурации

### 1.1. Environment (env)

Секреты и окружение (НЕ коммитим):

- `DISCORD_TOKEN` — токен бота
- `DATABASE_URL` — путь к SQLite файлу или DSN (позже)
- `LOG_LEVEL` — `debug|info|warn|error`
- `NODE_ENV` — `development|production`

Опционально:
- `SENTRY_DSN`
- `METRICS_ENABLED=true|false`

### 1.2. Runtime config (json/yaml в репозитории/деплое)

Несекретные параметры развертывания:

- `templatesPath` — где лежат JSON‑шаблоны
- `defaultLocale` — `ru-RU`
- `botAdminRoleKey` — например `SYS_BOT_ADMIN` (если используем)
- `rateLimit`:
  - `maxGuildConcurrency` (например 1)
  - `maxGlobalConcurrency` (например 3)
  - `operationDeadlineSeconds` (например 600)
- `features` (feature flags):
  - `enablePrune` (по умолчанию false)
  - `enableDMNotifications` (false в MVP)

### 1.3. Domain configs (шаблоны и unit)

- `TemplateConfig` (в `templates/`)
- `UnitConfig` (ответы wizard, хранится в БД)

---

## 2. Приоритеты конфигурации

1) env
2) runtime config file
3) defaults

Правило: доменные конфиги (шаблоны/unit) не должны зависеть от env.

---

## 3. Конвенции по валидации

- env валидируется на старте (fail-fast)
- runtime config валидируется на старте
- шаблоны валидируются при загрузке (и при деплое повторно)

Ошибки валидации должны быть понятными и ссылаться на конкретный ключ/путь.

---

## 4. Observability (MVP)

Минимальный набор:
- структурные логи с `requestId`
- audit‑события в БД + `CH_AUDIT` (если настроено)

Фаза 2:
- метрики очереди (операций в очереди, rate limited count)
- время деплоя (p50/p95)

