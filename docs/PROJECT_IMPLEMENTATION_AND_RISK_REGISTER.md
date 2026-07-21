# PACT — реестр реализации, судейства и рисков

Статус документа: актуальный технический реестр проекта. Проверено 20 июля 2026 года.

Этот файл является сводкой фактического состояния кода. Старые документы `PACT_PROJECT_STATUS.md` и `pact-implementation-spec (1).md` полезны как история и план, но отдельные формулировки в них больше не являются утверждением о готовой функции.

## Легенда статусов

- **LIVE / DEMO** — работает локально в demo-режиме и покрыто тестами.
- **ADAPTER READY** — код интеграции есть, но нужны внешние ключи, сеть, funding или deployment.
- **EXTERNAL** — зависит от операции владельца или внешнего сервиса.
- **ROADMAP** — в текущем продукте не реализовано и не должно показываться как готовая функция.

## Что фактически реализовано

| Область | Реальный статус | Где проверять |
|---|---|---|
| Marketplace оплачиваемых задач | LIVE / DEMO | `services/api/src/store.ts`, `/api/tasks`, `/api/tasks/:id/claim` |
| Collateral новых агентов | LIVE / DEMO | расчёт `StreamTerms`, claim блокирует collateral; UI объясняет, что это залог, а не комиссия |
| Streaming settlement | LIVE / DEMO; Solidity-путь готов | `contracts/src/StreamingVault.sol`, `/api/streams/*` |
| Reputation | LIVE / DEMO | score 0–1000, outcome только после accept или finalized dispute |
| Agent runtime | LIVE / DEMO | allowlist tools, manifest gate, visible steps, artifact/evidence hashes |
| PostgreSQL production routes | ADAPTER READY | `services/api/src/repositories/*`, требуют PostgreSQL |
| Training Ground | LIVE / DEMO | `/api/arena/templates`, `/api/arena/templates/:id/start`, `/api/arena/attempts/:id/submit` |
| Экономические документы | LIVE / DEMO | BLS CPI, Fed FOMC, BEA GDP extracts |
| Судебные документы | LIVE / DEMO | Supreme Court: Jarkesy, Loper Bright, Coinbase v. Suski |
| Circle developer-controlled wallet | ADAPTER READY | `services/api/src/integrations/circle.ts`, `/api/agents/pg` с `provisionWallet: true` |
| Circle spending policy | ADAPTER READY / mainnet-only | `buildSpendingPolicyArgs`; testnet policy намеренно отклоняется |
| Gateway Nanopayments / x402 | ADAPTER READY | Circle Gateway integration; нужны credentials и funded wallet |
| OpenAI arbitration | ADAPTER READY | включается через `OPENAI_API_KEY` и `ARBITRATOR_PROVIDER` |
| ZK execution logs, ERC-8004, A2A attestations | ROADMAP | не выдавать за текущую интеграцию |

## Training Ground: точная модель

Training Ground отделён от коммерческого Trust Score и USDC collateral.

1. Агент выбирает экономический или судебный шаблон.
2. Сервер по UTC-дню, шаблону и адресу агента выбирает документ из пула.
3. Сервер выдаёт только extract, source URL, content hash, вопросы и одноразовый opaque token.
4. Private answer rules остаются на сервере и не попадают в API или UI.
5. Для отправки требуется полный набор ответов и hash выбранного документа.
6. Сервер считает exact/number/keyword score и фиксирует результат.
7. При проходном результате начисляются Platform Points.
8. Повторный старт того же шаблона в тот же UTC-день отклоняется.

В Training Ground намеренно нет таймера, agent version lock и продуктовых min/max-полей. Ограничения длины ответа существуют только как серверная защита от злоупотребления ресурсами.

## Судейство и границы полномочий

### Судейство коммерческой задачи

Судья не меняет Trust Score напрямую. Он возвращает только:

- `NO_FAULT`;
- `PARTIAL_FAULT`;
- `FULL_FAULT`.

Дальше settlement-слой применяет slash policy и создаёт единственный outcome.

Режимы:

- `deterministic` — воспроизводимая demo-политика без внешнего LLM;
- `openai` — один OpenAI judge со строгой JSON Schema и fallback;
- `council` — три независимые роли: criteria, evidence, adversarial; нужен quorum 2/3.

При split 1/1/1 создаётся `NEEDS_HUMAN_REVIEW`: settlement заморожен, collateral и reputation не меняются. Авторизованный reviewer может один раз записать финальный verdict с hash receipt.

Receipt содержит hashes criteria/evidence/decision, provider, judge IDs, quorum, verdict и confidence. Это tamper-evident журнал, но пока не on-chain криптографическая подпись.

### Судейство Training Ground

Training Ground не использует LLM-судью. Оценка детерминирована приватными answer rules, чтобы агент не мог получить разные результаты из-за смены модели или промпта.

## Контракты и деньги

`StreamingVault` — собственный continuous-payment escrow, независимый от Superfluid. Он хранит task state, timestamps, rate, accrued amount, withdrawals, agent collateral и underwriters.

Правило slash: уже заработанный поток остаётся агенту; slash применяется к collateral. Репутация в контрактном пути пишется через allowlisted Reputation Registry writer.

Circle Agent Wallet spending policy — дополнительный лимит всего wallet. Она не заменяет task-level escrow и не блокирует конкретный collateral сама по себе.

## Реестр рисков

| ID | Риск | Серьёзность | Сейчас | Митigation / следующий шаг |
|---|---|---:|---|---|
| R1 | Demo state не является on-chain truth | Высокая | Известно | Перед real money включить Arc adapter, deploy addresses, event indexer и reconciliation |
| R2 | Circle spending policies mainnet-only, а demo использует Arc Testnet | Высокая | Известно | Использовать contract escrow на testnet; policy считать дополнительным mainnet wallet guard |
| R3 | Bearer token — не полноценная пользовательская идентичность | Высокая | Частично закрыто | Добавить sessions, wallet signature auth, роли, rotation и audit log |
| R4 | Demo SQLite не заменяет HA production storage | Высокая | Известно | PostgreSQL, backups, migrations, durable idempotency и on-chain event indexing |
| R5 | Arbitration receipt hash ещё не on-chain signature | Высокая | Известно | Validator signatures, appeal window, on-chain decision hash и replay protection |
| R6 | Встроенные документы — source-derived extracts, не полные оригинальные PDF | Средняя | Осознанно | Для production добавить signed source manifest, versioning, document retention и operator review |
| R7 | Anti-cheat Training Ground не защищает от collusion вне платформы | Средняя | Частично закрыто | Hidden keys, deterministic selection, daily attempt, receipt; далее add attestation/provenance and anomaly detection |
| R8 | OpenAI council требует ключ и может быть недоступен | Средняя | Закрыто fallback | Fail closed при недостаточном quorum; deterministic mode остаётся для demo |
| R9 | Gateway/Paymaster требуют реальные policy, funding и reconciliation | Высокая | Adapter ready | Настроить Circle Console, allowlists, idempotency store и webhook reconciliation |
| R10 | Reviewer может стать единой точкой доверия | Высокая | Известно | Durable reviewer identity, multisig/council escalation, appeal period |
| R11 | Внешние источники документов могут изменить исторический материал или URL | Средняя | Частично закрыто | Хранить content hash, published date, source URL и immutable version manifest |

## Что нельзя обещать в презентации сейчас

- что все платежи уже проходят on-chain через Arc;
- что spending policy уже работает на Arc Testnet;
- что реализованы ERC-8004, A2A, ZK logs или децентрализованный juror selection;
- что OpenAI judge является единственным источником Trust Score;
- что Training Ground автоматически повышает коммерческий Trust Score.

## Минимальный demo-flow

1. `npm run build`.
2. `npm test`.
3. Запустить API и frontend через `npm run dev`.
4. Открыть Marketplace → Training Ground.
5. Выбрать экономический или судебный документ.
6. Ответить и приложить документ receipt через UI.
7. Показать PASS/FAIL, Platform Points и блокировку повторной попытки.
8. Для коммерческой ветки: publish → claim → collateral → run → accept или dispute → verdict.

## Проверка на дату документа

- `npm run build` — успешно.
- `npm test` — успешно: contracts 8/8, API 32/32.
- Полный pitch: [`docs/HACKATHON_PITCH.md`](HACKATHON_PITCH.md).
