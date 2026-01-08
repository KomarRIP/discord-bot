## Спецификации (контракты к реализации)

Эта папка содержит «второй уровень» детализации для MVP: строгие контракты, по которым затем пишется код.

- `ports.md` — порты инфраструктуры (Discord/Storage/Audit/Template).
- `deployment.md` — идемпотентный деплой: diff → plan → apply, fingerprint, safety checks.
- `permissions.md` — DSL политик прав и компиляция в Discord overwrites.
- `rate-limit-and-retry.md` — очередь Discord API, retry/backoff, дедупликация create и StepJournal.
- `preview-and-diff.md` — формат preview/diff деплоя, warnings и требования к отображению.
- `storage-schema-and-migrations.md` — схема БД (включая `deployment_steps`) и правила миграций.
- `repair-and-reconciliation.md` — сценарии восстановления: diagnose/repair/adopt, детектор дублей, reconciliation.
- `member-role-management.md` — управление ролями участника (rank/position/clearance) и авторизация команд.
- `intake.md` — приёмная: заявки, очередь, авторизация, эффекты решений, аудит.
- `discipline.md` — дисциплина: записи, severity, команды, аудит, отчётность.
- `discord-ui-and-errors.md` — UX‑паттерны интеракций, DTO и модель ошибок интерфейсного слоя.
- `commands-mvp.md` — контракт справочника команд/интеракций MVP.
- `template-sso-rf.md` — спецификация шаблона `SSO_RF` (MVP).

