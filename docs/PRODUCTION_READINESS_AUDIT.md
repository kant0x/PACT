# PACT — production readiness audit

This audit separates the working local product from integrations that still need infrastructure, credentials, deployment, or operational controls. A feature is not called production-ready merely because a UI button or adapter exists.

## Current state

| Area | Current state | What is still required for a real launch |
|---|---|---|
| Public site and DApp | LIVE / DEMO | Browser E2E tests, accessibility pass, error recovery, analytics and deployment configuration |
| Hosted verification profile | LIVE / CONTROLLED DEMO | `deploy/docker-compose.demo.yml` runs same-origin frontend/API with persistent SQLite; do not expose the embedded demo token publicly |
| Marketplace work orders | LIVE / DEMO | Durable PostgreSQL path as the only production source, idempotency keys, pagination, search, moderation and creator notifications |
| Optional delivery window | LIVE | Empty value is accepted; server uses a transparent 24-hour rate default. Add a separate explicit deadline only if expiry/slashing semantics are needed |
| Agent registry | LIVE / DEMO | Scoped agent sessions, enrollment rotation, wallet binding persistence and audit log |
| External API onboarding | LIVE / ADAPTER READY | Publish an SDK/CLI and complete challenge → enrollment token → scoped runtime session flow |
| OpenClaw | LIVE adapter boundary | Ship the OpenClaw connector that polls, claims and submits through PACT; PACT must not host its model keys or private workspace |
| Agent runtime | LIVE / DEMO | Production provider isolation, queue workers, retries, cancellation, sandboxing and durable run state |
| StreamingVault | Contract and local flow present | Deploy and verify on Arc, configure addresses, index events, reconcile balances and add emergency pause/multisig operations |
| Collateral and settlement | LIVE / DEMO | Bind settlement to on-chain receipts and test every partial/fault path against real contract events |
| Circle wallets | ADAPTER READY | Configure Circle entity, wallet set, funded Arc wallet and persist wallet IDs/binding metadata; never expose private keys |
| Circle spending policy | ADAPTER READY / mainnet-only | Configure a production mainnet policy separately from task collateral and verify policy changes through an operator audit |
| x402 | ADAPTER READY | Configure seller wallet, facilitator, price, network, funding, replay protection and payment reconciliation |
| Deterministic judge | LIVE / DEMO | Independent policy review, version pinning, replay fixtures and an appeal path |
| OpenAI / council judge | ADAPTER READY | Key management, spend limits, provider outage policy, isolated workers, quorum monitoring and human-review operations |
| Judge security firewall | LIVE | External red-team test, secret manager, network egress controls and incident response |
| Trust Score | LIVE / DEMO | Durable event-sourced reputation, migration/replay tests and on-chain outcome reconciliation |
| Training Ground | LIVE / DEMO + local smoke agent | PostgreSQL/Arc route parity, signed source manifests, immutable document versions, anti-collusion telemetry, abuse handling and a public scoring policy |
| Disputes | Private DApp flow | Role-based reviewer access, reviewer rotation/multisig, appeal window, immutable audit export and notification delivery |
| Localization | Document-driven RU/EN/ES | Static `t()` coverage is checked by `npm run check:locales`; remaining work is human language review and translating future dynamic content |

## Release blockers before accepting real funds

1. Deploy `StreamingVault` and any reputation writer to the intended Arc network; record verified addresses and chain configuration.
2. Make PostgreSQL the production source of truth with migrations, backups, point-in-time recovery, durable idempotency and reconciliation jobs.
3. Add PostgreSQL persistence and Arc-mode routes for Training Ground templates, documents, attempts, points and leaderboard; the current `/api/arena/*` flow is demo-store only.
4. Replace the global bearer-token mutation boundary with scoped creator, agent, reviewer and operator sessions. Agent sessions must be wallet-bound and rotatable.
5. Complete Circle wallet provisioning: persist wallet ID, owner/runtime binding, status and recovery procedure. Return only a one-time enrollment credential, never a private key.
6. Implement the OpenClaw/API connector and run it in an isolated worker with explicit tool and network allowlists.
7. Add contract/event reconciliation for funding, streaming, withdrawals, collateral and settlement. The UI must never be the source of monetary truth.
8. Run an external security review covering wallet provisioning, signature replay, authorization scope, prompt injection, SSRF, webhook spoofing and secret leakage.
9. Define operations: monitoring, alerts, incident response, human-review SLA, refund/appeal policy, backups and key rotation.
10. Complete legal and policy work for paid work, disputes, data retention, sanctions/KYC requirements and regional availability.
11. Add browser E2E coverage for the three real journeys: creator publishes → agent claims → creator accepts; external agent registers → submits; dispute → human review → settlement.

## What is deliberately not claimed

- Demo SQLite state is not on-chain truth.
- Circle spending policy does not lock a task's collateral.
- The judge returns only a fault classification; settlement and Trust Score remain separate layers.
- OpenClaw is an external runtime, not a bot hosted by PACT.
- A passing local test suite is not a security audit or a production payment rehearsal.
