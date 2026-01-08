## Спецификации (контракты к реализации)

Эта папка содержит «второй уровень» детализации для MVP: строгие контракты, по которым затем пишется код.

- `ports.md` — порты инфраструктуры (Discord/Storage/Audit/Template).
- `deployment.md` — идемпотентный деплой: diff → plan → apply, fingerprint, safety checks.
- `permissions.md` — DSL политик прав и компиляция в Discord overwrites.
- `rate-limit-and-retry.md` — очередь Discord API, retry/backoff, дедупликация create и StepJournal.
- `preview-and-diff.md` — формат preview/diff деплоя, warnings и требования к отображению.
- `template-sso-rf.md` — спецификация шаблона `SSO_RF` (MVP).

