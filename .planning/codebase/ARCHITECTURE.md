# Architecture

**Analysis Date:** 2026-07-20

## Pattern Overview

**Overall:** Monorepo MVP with a React control-room client, Express API, shared TypeScript contracts, local/demo and PostgreSQL persistence paths, optional Arc smart contracts, and a separate consent-aware Python training pipeline.

**Key Characteristics:**
- The root `package.json` coordinates the `shared`, `contracts`, `services/api`, and `frontend` workspaces; `services/indexer` is a standalone package outside that workspace list.
- `services/api/src/app.ts` is the HTTP composition root: it exposes both local/demo endpoints and parallel `/pg` PostgreSQL endpoints.
- Domain state and rules for the default product path are centralized in the in-process `DemoStore` at `services/api/src/store.ts`, persisted as a SQLite state document.
- `shared/src/index.ts` is the canonical cross-client TypeScript type contract; Vite aliases it directly for the browser.
- Solidity contracts and the event indexer are deployment adapters, rather than the execution path used by the local dashboard.

## Layers

**Browser presentation and client transport:**
- Purpose: Render the PACT dashboard, connect wallets, manage screen-local state, poll APIs, and issue REST/WebSocket requests.
- Location: `frontend/src/`
- Contains: `App.tsx` (the primary UI composition), `api.ts` (typed fetch client), `wagmi.ts` (wallet/Arc chain config), `locale.ts` (runtime locale provider), CSS, and static translations in `frontend/public/locales/`.
- Depends on: React, TanStack Query, Wagmi/Viem, and types from `@pact/shared`.
- Used by: Vite entry point `frontend/src/main.tsx` and browser users.

**HTTP/API and realtime boundary:**
- Purpose: Validate and secure requests, route them to domain operations, select arbitration/agent runtime providers, and deliver live stream updates.
- Location: `services/api/src/app.ts`, `services/api/src/server.ts`, `services/api/src/security.ts`, and `services/api/src/errors.ts`.
- Contains: Express routes, Helmet/CORS/rate-limit/body-size middleware, Bearer-token protection for mutations, creator-wallet signature verification, API error middleware, HTTP server, and WebSocket upgrade handling.
- Depends on: `DemoStore`, the arbitration/runtime adapters, optional repositories, Circle adapter, and `@pact/shared`.
- Used by: `frontend/src/api.ts`, scripts in `services/api/scripts/`, API tests, and training export.

**Demo domain model and orchestration:**
- Purpose: Own marketplace lifecycle, reputation tiers, streaming calculations, disputes, training traces, arena challenges, agent runs, deliverables, events, and demo seeding.
- Location: `services/api/src/store.ts`, with policy constants in `services/api/src/config.ts` and deterministic arena content/evaluation in `services/api/src/arena.ts`.
- Contains: `DemoStore`, mutable Maps/arrays, subscription events, runtime snapshots, task/stream transitions, dispute handling, and training eligibility state.
- Depends on: shared types, local state persistence, the selected `Arbitrator` result, and `AgentRuntime` calls.
- Used by: almost all non-`/pg` routes in `services/api/src/app.ts`; the WebSocket ticker in `services/api/src/server.ts`.

**Persistence adapters:**
- Purpose: Retain local demo state, optionally access normalized PostgreSQL records, and reserve one-time paymaster sponsorships.
- Location: SQLite state adapter `services/api/src/persistence.ts`; PostgreSQL connection/schema `services/api/src/db.ts` and `services/api/src/schema.sql`; repositories `services/api/src/repositories/`; paymaster SQLite ledger `services/api/src/integrations/paymaster.ts`.
- Contains: a WAL SQLite key/value state document, a `pg` pool and SQL repositories for agents/tasks/disputes/traces/runs/deliverables/clients, and a separate sponsorship ledger.
- Depends on: Node's `node:sqlite` and `pg`.
- Used by: `createPactServer()` for normal local persistence; `/pg` routes dynamically import repositories; Circle sponsorship scripts instantiate the paymaster adapter.

**Agent and arbitration adapters:**
- Purpose: Keep model-provider and dispute-decision mechanics behind narrow interfaces while preserving a deterministic no-secret local path.
- Location: `services/api/src/agent-runtime.ts` and `services/api/src/arbitration.ts`.
- Contains: `AgentModelProvider` and `Arbitrator` interfaces, deterministic providers, OpenAI providers, council quorum decision logic, plan/tool execution receipt generation, and deliverable submission.
- Depends on: `DemoStore`, OpenAI SDK when configured, shared types, and Node hashing.
- Used by: API routes `/api/agent-runs`, `/api/agent-runtime`, and `/api/disputes` in `services/api/src/app.ts`.

**External-chain and Circle adapters:**
- Purpose: Define deployable ERC-20 streaming/reputation semantics, developer wallet commands, x402 gateway flows, and a fail-closed first-operation gas-sponsorship guard.
- Location: contracts `contracts/src/`; compiler/deployer `contracts/scripts/`; Circle modules `services/api/src/integrations/circle.ts` and `services/api/src/integrations/paymaster.ts`; command wrappers `services/api/scripts/`.
- Contains: `MockUSDC`, `ReputationRegistry`, `StreamingVault`, test mock protocol, compiler artifact generation, Arc deployment script, Circle wallet/gateway clients, and sponsorship policy/ledger.
- Depends on: EVM/USDC, Circle SDKs, Viem/Ethers, and configured credentials/addresses.
- Used by: contract tests/deployment, API `/pg` agent wallet provisioning, and standalone Circle scripts; it is not implicitly invoked by the demo store.

**Blockchain event projection:**
- Purpose: Watch `StreamingVault` events and project status changes into PostgreSQL.
- Location: `services/indexer/src/index.ts`.
- Contains: Viem public client watchers for `StreamCreated`, `StreamPaused`, and `CollateralSlashed`, plus direct SQL status updates.
- Depends on: Arc RPC, vault address, and PostgreSQL.
- Used by: deployment/production operations as an independently started service.

**Training pipeline:**
- Purpose: Export approved first-party traces, sanitize and prepare grouped datasets, evaluate responses, generate task briefs, and run QLoRA supervised fine-tuning.
- Location: `training/src/pact_training/`, configuration `training/configs/qwen35-2b-qlora.toml`.
- Contains: CLI, API exporter, secret scanner/preparer, policy evaluator, factory, and training runner.
- Depends on: the authenticated API trace endpoint, Python/ML libraries, and CUDA for training.
- Used by: `pact-training` commands defined in `training/pyproject.toml`.

## Data Flow

**Local marketplace and streaming flow:**

1. `frontend/src/main.tsx` renders `frontend/src/App.tsx`; UI actions call methods in `frontend/src/api.ts` against `services/api/src/app.ts`.
2. Middleware in `services/api/src/app.ts` applies headers, CORS, rate limits, bounded JSON parsing, optional Bearer authentication, and creator signature verification before a mutation reaches `DemoStore`.
3. `DemoStore` in `services/api/src/store.ts` creates/claims tasks, derives reputation terms from `services/api/src/config.ts`, starts streams, tracks accrued/withdrawn values, and persists after state changes through `services/api/src/persistence.ts`.
4. `services/api/src/server.ts` calls `activeStore.tick()` every second and pushes matching stream events over `ws://<api>/api/streams/:taskId/live`; `frontend/src/api.ts` builds the socket URL for stream consumers.
5. Completion or resolved disputes update reputation, collateral/stream state, dashboard snapshots, and the append-only in-memory event history returned to the UI.

**Agent-work and evidence flow:**

1. `POST /api/agent-runs` in `services/api/src/app.ts` invokes `AgentRuntime.run()` from `services/api/src/agent-runtime.ts`.
2. The runtime reads the task and agent capability manifest from `DemoStore`, creates a run record, asks the deterministic or OpenAI provider for an allowlisted plan, records steps/tool receipts, and submits a deliverable.
3. `DemoStore` stores agent runs, deliverables, and optional visible execution traces; `GET /api/training/traces` exposes only reviewed, consented successful traces to authenticated operators.
4. `training/src/pact_training/export.py` downloads the trace array; `prepare.py` filters, secret-scans, de-duplicates, groups splits by task, and writes JSONL/manifest inputs for `train.py`.

**Dispute flow:**

1. The browser calls `api.createDispute()` in `frontend/src/api.ts`, which posts evidence to `/api/disputes`.
2. `services/api/src/app.ts` selects an arbitrator configured by `services/api/src/arbitration.ts`: deterministic, a single OpenAI judge, or a three-role council.
3. `DemoStore.createDispute()` freezes the affected task and stores the decision/receipt. A no-quorum council result remains `NEEDS_HUMAN_REVIEW`.
4. An authenticated POST to `/api/disputes/:id/human-review` records the server-selected reviewer ID and applies final settlement/reputation consequences through `DemoStore.finalizeHumanReview()`.

**PostgreSQL/chain projection flow:**

1. `/pg` routes in `services/api/src/app.ts` dynamically load repository modules in `services/api/src/repositories/`, which issue SQL through `services/api/src/db.ts` against the schema in `services/api/src/schema.sql`.
2. Arc contract interactions are performed by wallets/tools outside the default demo state; `contracts/src/StreamingVault.sol` emits lifecycle events.
3. `services/indexer/src/index.ts` watches selected vault events and updates the corresponding PostgreSQL task status using `chain_task_id` or creator/agent matching.

**State Management:**
- Browser screen state is local React state in the monolithic `frontend/src/App.tsx`; TanStack Query is provided in `frontend/src/main.tsx` but API calls are primarily imperative via `frontend/src/api.ts`.
- Default backend state lives in `DemoStore` Maps/arrays and is serialized to one SQLite `pact_state` record by `SqliteStatePersistence`.
- PostgreSQL state is a separate normalized route family and is not automatically synchronized with the demo store.

## Key Abstractions

**Shared domain contracts:**
- Purpose: Define task, stream, reputation, dispute, agent execution, arena, and dashboard payload shapes.
- Examples: `shared/src/index.ts`.
- Pattern: Type-only shared library, imported as `@pact/shared` by the API/frontend and directly aliased by Vite.

**DemoStore:**
- Purpose: The domain service and local event source for the complete offline MVP.
- Examples: `services/api/src/store.ts`, `services/api/src/persistence.ts`.
- Pattern: Stateful aggregate root with explicit lifecycle methods, snapshots, persistence after mutation, and subscriber callbacks.

**Provider interfaces:**
- Purpose: Decouple policy-sensitive AI planning and arbitration from HTTP routes and local data storage.
- Examples: `services/api/src/agent-runtime.ts`, `services/api/src/arbitration.ts`.
- Pattern: Interface plus deterministic default and environment-selected OpenAI implementations; council composition enforces a quorum boundary.

**Repository classes:**
- Purpose: Isolate PostgreSQL query construction and DB-row mapping from `/pg` routes.
- Examples: `services/api/src/repositories/task.repository.ts`, `services/api/src/repositories/agent.repository.ts`, `services/api/src/services/agent.service.ts`.
- Pattern: Singleton repository classes over `query()` from `services/api/src/db.ts`; route code dynamically imports them only for the PostgreSQL path.

**Onchain protocols:**
- Purpose: Model USDC custody/streaming and portable reputation with explicit EVM lifecycle transitions.
- Examples: `contracts/src/StreamingVault.sol`, `contracts/src/ReputationRegistry.sol`, `contracts/src/MockUSDC.sol`.
- Pattern: Solidity contracts with role modifiers, events, ERC-20 transfers, and contract-local task/outcome identifiers.

## Entry Points

**Root development coordinator:**
- Location: `package.json`
- Triggers: `npm run dev`, `npm run build`, `npm test`, and workspace scripts.
- Responsibilities: Starts the API and Vite frontend concurrently and coordinates registered workspaces.

**API server:**
- Location: `services/api/src/server.ts`
- Triggers: `npm run dev -w @pact/api` or compiled `npm start -w @pact/api`.
- Responsibilities: Creates HTTP/Express server, initializes SQLite-backed `DemoStore`, upgrades stream WebSockets, runs the one-second ticker, and closes resources.

**API application:**
- Location: `services/api/src/app.ts`
- Triggers: `createPactServer()` and API tests.
- Responsibilities: Builds middleware, REST routes, dependency choices, and error response boundary.

**Browser client:**
- Location: `frontend/src/main.tsx`
- Triggers: Vite serving `frontend/index.html`.
- Responsibilities: Mounts React Strict Mode, Wagmi, TanStack Query, locale provider, and `App`.

**Indexer process:**
- Location: `services/indexer/src/index.ts`
- Triggers: `npm run dev` or `npm start` from `services/indexer/`.
- Responsibilities: Starts Arc event watchers and projects selected vault events into PostgreSQL.

**Contracts build/deploy:**
- Location: `contracts/scripts/compile.js` and `contracts/scripts/deploy_testnet.js`
- Triggers: `npm run build -w @pact/contracts` and direct deployment invocation.
- Responsibilities: Compile `contracts/src/*.sol` into `contracts/artifacts/` and deploy registry/vault to configured Arc RPC.

**Training CLI:**
- Location: `training/src/pact_training/cli.py`
- Triggers: installed `pact-training` command or `python -m pact_training.cli`.
- Responsibilities: Routes doctor/export/prepare/gate/train/score-eval/factory subcommands.

## Error Handling

**Strategy:** Route handlers throw `ApiProblem` for expected client failures; `services/api/src/app.ts` converts errors to typed JSON responses. Provider and Circle adapters validate configuration and fail closed where an unsafe side effect could occur.

**Patterns:**
- Use `ApiProblem` from `services/api/src/errors.ts` for HTTP status/code/message failures and delegate asynchronous `/pg` route errors with `next(error)` in `services/api/src/app.ts`.
- Validate input at the API/domain boundary and reject bad addresses, signatures, task states, money values, provider output, and unauthorized reviewer actions.
- Preserve a frozen `NEEDS_HUMAN_REVIEW` dispute rather than inferring settlement from a split council decision in `services/api/src/arbitration.ts` and `services/api/src/store.ts`.
- Use `PaymasterPolicyError` and a SQLite reservation in `services/api/src/integrations/paymaster.ts` so uncertain Circle submissions cannot be retried silently.

## Cross-Cutting Concerns

**Logging:** API start and runtime messages use `console` in `services/api/src/server.ts`; database pool errors and the indexer use `console.error` in `services/api/src/db.ts` and `services/indexer/src/index.ts`. No centralized structured logging layer is present.

**Validation:** `services/api/src/app.ts` performs request checks and EVM signature verification; `services/api/src/store.ts` asserts domain preconditions; `services/api/src/integrations/paymaster.ts` constrains addresses, amounts, chains, policy caps, and idempotency; Solidity validates onchain state independently.

**Authentication:** `services/api/src/security.ts` implements optional constant-time Bearer-token matching. `services/api/src/app.ts` protects non-read API requests when configured, requires creator EVM signatures for task publishing outside approved test/bypass conditions, and accepts human-review identity only from server configuration. Frontend `VITE_API_TOKEN` support in `frontend/src/api.ts` is intended for a controlled private demo.

---

*Architecture analysis: 2026-07-20*
