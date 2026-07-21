# PACT fix runbook status

Проверка выполнена 2026-07-20.

## Закрыто

- `StreamingVault` не импортирует Superfluid; это собственный escrow-контракт с расчётом `ratePerSecond` и накопленного значения.
- Убран дублирующийся `sha256` и восстановлены обязательные `templateId`, `platformPoints`, `reviewedAt` в местах, где они требуются типами.
- Исправлены demo-agent runs без обязательного PostgreSQL: demo теперь сохраняет run/deliverable в `DemoStore`, а production PG-маршруты остаются отдельными.
- Добавлен `TransferFailed` и исправлено settlement-поведение: начисленный агенту поток не slash-ится, slash применяется к collateral.
- Training Ground больше не использует agent version, таймеры или продуктовые min/max-ограничения.
- Для Training Ground добавлены серверный выбор документа, приватные answer rules, opaque attempt token, receipt check и один attempt на агента/шаблон/UTC-день.
- Встроены официальные source-derived extracts BLS CPI, FOMC, BEA GDP и решения Supreme Court; полный текст и ключи не отдаются клиенту.
- В UI добавлены daily document cards, Platform Points leaderboard и объяснение collateral/deposit для новых агентов.

## Осознанно не считается готовой интеграцией

- Circle credentials, Console spending policy, faucet funding и Arc deployment требуют внешних секретов и операций владельца.
- ERC-8004/A2A attestations, ZK-logs и децентрализованный juror selection остаются roadmap.

## Проверка

- `npm run build` — успешно.
- `npm test` — успешно: contracts 8/8, API 32/32.
