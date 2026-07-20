# Codebase Concerns

**Analysis Date:** 2026-07-20

## Tech Debt

**Dual, diverging application backends (High):**
- Issue: The API exposes a mature in-memory/SQLite `DemoStore` route set beside partially implemented PostgreSQL routes (`/pg`). Their validation, authorization, state transitions, persistence, and returned data are not shared. The PostgreSQL agent-run route explicitly queues a record then invokes the legacy runtime, which reads the demo store rather than PostgreSQL.
- Files: `services/api/src/app.ts`, `services/api/src/store.ts`, `services/api/src/persistence.ts`, `services/api/src/repositories/task.repository.ts`, `services/api/src/agent-runtime.ts`
- Impact: A deployment can create records in PostgreSQL that cannot be processed by the invoked runtime; behavior and safeguards depend on endpoint spelling, and bug fixes must be applied twice.
- Fix approach: Select one authoritative persistence/service layer, move state transitions into transactional services used by all routes, retire the demo routes from production builds, and add migration/contract tests for the supported API.

**Oversized orchestration modules (Medium):**
- Issue: Request routing, authorization decisions, business state transitions, and integration coordination are concentrated in very large modules.
- Files: `services/api/src/app.ts`, `services/api/src/store.ts`, `frontend/src/App.tsx`, `services/api/src/integrations/paymaster.ts`
- Impact: Small changes have broad regression surface, code review is difficult, and route-specific security behavior is easy to miss.
- Fix approach: Split API handlers by resource, extract policy/state-machine services with narrow interfaces, and decompose the frontend by feature views and hooks before adding more flows.

**Unchecked production database contract (Medium):**
- Issue: PostgreSQL schema creation is a standalone SQL file with no migration runner, startup verification, or automated test environment. Repository methods make multi-query read-modify-write updates without transactions.
- Files: `services/api/src/schema.sql`, `services/api/src/db.ts`, `services/api/src/repositories/task.repository.ts`, `services/api/src/repositories/dispute.repository.ts`, `services/api/src/repositories/deliverable.repository.ts`
- Impact: Fresh deployments and schema upgrades are manual; concurrent requests can overwrite task state or leave deliverables, task status, and rewards inconsistent.
- Fix approach: Adopt versioned migrations, apply/validate them during deployment, and wrap each multi-record state transition in a PostgreSQL transaction with conditional updates or row locks.

## Known Bugs

**Indexer listens for events not emitted by the deployed contract (Critical):**
- Symptoms: `services/indexer/src/index.ts` subscribes to `StreamCreated`, `StreamPaused(uint256)`, and `CollateralSlashed(uint256,uint256)`, but `StreamingVault` emits `StreamStarted`, `StreamPaused(uint256,uint256,uint256)`, and `CollateralSlashed(uint256,uint256,uint256,uint256,uint256)`. State synchronization therefore cannot receive the contract events it expects.
- Files: `services/indexer/src/index.ts`, `contracts/src/StreamingVault.sol`
- Trigger: Run the indexer against a `StreamingVault` deployment and create/start, pause, or slash a task.
- Workaround: None in code; reconcile task state from chain manually until ABI/event names and arguments are made consistent.

**PostgreSQL agent runs are stranded or operate on unrelated demo state (High):**
- Symptoms: `POST /api/agent-runs/pg` persists a `QUEUED` record, then asynchronously calls `agentRuntime.run()`. Because `createApp()` always supplies `store`, `AgentRuntime.run()` takes the demo-store path, where a PostgreSQL task ID is normally absent.
- Files: `services/api/src/app.ts`, `services/api/src/agent-runtime.ts`, `services/api/src/repositories/agent-run.repository.ts`
- Trigger: Create a PostgreSQL task, then call `POST /api/agent-runs/pg` with that task ID.
- Workaround: Use the demo endpoint/data only; do not treat PostgreSQL `QUEUED` agent runs as executable production work.

## Security Considerations

**Authorization is an optional shared bearer token, not actor authorization (Critical):**
- Risk: Outside production, an unset `PACT_AUTH_TOKEN` makes `hasValidBearerToken()` return true. Even with the token configured, every holder has the same authority and route handlers do not confirm that the caller owns the creator/agent/reviewer identity. Authenticated callers can mutate arbitrary tasks, claims, capabilities, deliverables, streams, disputes, and human reviews.
- Files: `services/api/src/security.ts`, `services/api/src/app.ts`, `services/api/src/store.ts`
- Current mitigation: `services/api/src/app.ts` requires a token only when `NODE_ENV=production`, applies request rate limiting, and verifies a creator signature only on task creation.
- Recommendations: Fail closed whenever mutations are enabled; replace the global token with authenticated principals and per-resource signature/session authorization; require creator, assigned-agent, and reviewer roles for their respective state changes; add audit logs and authorization tests.

**PostgreSQL mutation endpoints bypass ownership and lifecycle checks (Critical):**
- Risk: `/api/tasks/pg/:id` accepts arbitrary partial task updates, `/api/tasks/pg/:id/claim` accepts any supplied agent address, `/api/deliverables/pg/:id/accept` accepts any caller, and PostgreSQL client creation accepts an arbitrary address without signature verification. These actions can forge task assignment, completion, rewards, or client identities.
- Files: `services/api/src/app.ts`, `services/api/src/repositories/task.repository.ts`, `services/api/src/repositories/agent.repository.ts`, `services/api/src/repositories/deliverable.repository.ts`
- Current mitigation: The application-wide mutation middleware can require the shared bearer token; agent registration verifies a signature only when the caller does not request wallet provisioning.
- Recommendations: Remove generic task patch/delete routes or enforce an explicit state-transition allowlist; bind verified signatures to every actor-controlled mutation; authorize deliverable acceptance against the task creator; verify client registration; reject invalid Ethereum addresses and malformed manifests server-side.

**Sensitive operational and training data is public when no token is configured (High):**
- Risk: `hasValidBearerToken()` considers all requests valid without `PACT_AUTH_TOKEN`, so dashboard and dispute redaction is disabled and the app returns dispute evidence, agent runs, deliverables, and workflow metadata to anonymous callers.
- Files: `services/api/src/security.ts`, `services/api/src/app.ts`, `services/api/src/store.ts`
- Current mitigation: Routes redact dispute details only when a token exists and the caller omits it; training trace endpoints separately use the same guard.
- Recommendations: Require authentication for non-public resources regardless of deployment mode, default `canReadSensitive` to false without an authenticated principal, and define field-level public response schemas.

**Raw LLM-generated deliverable content is retained and returned without a content-safety boundary (Medium):**
- Risk: Task text is injected into an LLM prompt and artifact previews/messages are persisted and served through API endpoints. Prompt injection can influence planning attempts, and untrusted HTML/Markdown rendered by a future UI path could create stored-content attacks.
- Files: `services/api/src/agent-runtime.ts`, `services/api/src/store.ts`, `services/api/src/repositories/execution-trace.repository.ts`, `frontend/src/App.tsx`
- Current mitigation: `services/api/src/agent-runtime.ts` constrains tool names and tells the arbitrator not to follow evidence instructions; the demo tools do not execute external commands.
- Recommendations: Separate untrusted task/evidence data from control instructions, validate model outputs against strict schemas and allowed tools, cap persisted fields, sanitize or render artifacts as plain text, and establish retention/access controls for traces.

## Performance Bottlenecks

**Unbounded PostgreSQL reads and N+1 reputation lookup (Medium):**
- Problem: Dashboard endpoints load complete task, agent, dispute, run, and deliverable tables; each agent then triggers a reputation lookup. Repository list methods lack pagination and relevant indexes are absent.
- Files: `services/api/src/app.ts`, `services/api/src/repositories/task.repository.ts`, `services/api/src/repositories/agent.repository.ts`, `services/api/src/schema.sql`, `services/api/src/services/agent.service.ts`
- Cause: Full-table `findAll()` calls and `Promise.all(agentsList.map(...))` are used for a dashboard response.
- Improvement path: Return aggregate queries and paginated lists, batch reputation data, add indexes for sort/filter access paths (including timestamps and foreign keys), and set bounded response limits.

**Whole-state SQLite serialization on every demo mutation (Medium):**
- Problem: The demo store persists a complete in-memory state document on each mutation.
- Files: `services/api/src/store.ts`, `services/api/src/persistence.ts`
- Cause: `SqliteStatePersistence.save()` calls `JSON.stringify(state)` and overwrites the singleton `pact_state` value.
- Improvement path: Keep this pattern only for small local demos; use normalized persistent storage and transactional updates for multi-user or production workloads.

**No resilient event ingestion or historical backfill (High):**
- Problem: The indexer only creates live watchers; it neither records block/log cursors nor backfills past events, retries with durable idempotency, handles chain reorganizations, or shuts down its database pool.
- Files: `services/indexer/src/index.ts`, `services/api/src/schema.sql`
- Cause: The service directly applies individual event callbacks to PostgreSQL without an event ledger/checkpoint model.
- Improvement path: Store processed `(chainId, transactionHash, logIndex)` records and block checkpoints, backfill with `getLogs`, confirm sufficient blocks before finalization, reconcile periodically against contract state, and implement reconnect/shutdown handling.

## Fragile Areas

**Off-chain and on-chain financial state are disconnected (Critical):**
- Files: `services/api/src/store.ts`, `services/api/src/app.ts`, `services/indexer/src/index.ts`, `contracts/src/StreamingVault.sol`
- Why fragile: API stream, withdrawal, completion, and dispute operations mutate local task fields only; they do not submit or verify a corresponding vault transaction. The separate indexer is presently ABI-incompatible and maps events to tasks by creator/agent pair rather than a pre-recorded immutable chain task ID.
- Safe modification: Treat the vault as settlement authority, create and persist a chain-task linkage atomically, derive status from verified events/reads, and reconcile every externally visible payout state before enabling real funds.
- Test coverage: `services/api/test/api.test.ts` and `contracts/test/contracts.test.js` test their layers independently; no integration test deploys the contract and verifies indexer/API convergence.

**Manual financial arithmetic and type coercion (High):**
- Files: `services/api/src/store.ts`, `services/api/src/app.ts`, `services/api/src/repositories/task.repository.ts`, `services/api/src/config.ts`
- Why fragile: Monetary values move between decimal strings, JavaScript `Number`, PostgreSQL `NUMERIC`, and Solidity integer units. Route code formats values with `toFixed(6)` and performs state logic with `Number()`, which loses precision for larger values and is not unit-aware.
- Safe modification: Use fixed-point base-unit integers or a decimal library end-to-end, validate precision/ranges at API boundaries, and create shared conversion functions with boundary-value tests.
- Test coverage: Existing API tests exercise happy-path values but do not cover precision boundaries, large amounts, concurrent transitions, or API-to-contract reconciliation.

## Scaling Limits

**On-chain underwriter settlement is bounded but linear (Medium):**
- Current capacity: `MAX_UNDERWRITERS` is 16 and settlement loops over every underwriter.
- Limit: Gas consumption rises with each underwriter; the fixed cap constrains market participation and any future cap increase can make completion/slashing exceed block gas limits.
- Scaling path: Preserve a conservative cap or switch to pull-based claims/Merkle distribution, then benchmark gas under worst-case token behavior.
- Files: `contracts/src/StreamingVault.sol`

**In-process API state and background work cannot scale horizontally (High):**
- Current capacity: A `DemoStore` instance and its agent runtime live in one Node process; queued PostgreSQL runs do not have a durable worker implementation.
- Limit: Multiple API replicas would have divergent demo state and can duplicate or lose asynchronous work.
- Scaling path: Move state to the transactional database, use an idempotent durable job queue/worker, and coordinate execution with database uniqueness constraints.
- Files: `services/api/src/app.ts`, `services/api/src/store.ts`, `services/api/src/agent-runtime.ts`

## Dependencies at Risk

**Multiple independent versions of core runtime dependencies (Medium):**
- Risk: The root workspace and `services/indexer` are not managed as one workspace, and the API/indexer declare different versions of `pg`, `dotenv`, TypeScript, and blockchain libraries.
- Impact: Builds, lockfiles, behavior, and security updates can drift; the indexer is absent from the root `workspaces` and root `check` command.
- Migration plan: Add `services/indexer` to the root workspace, consolidate compatible dependency versions and lockfile ownership, then include indexer type-checking/tests in CI.
- Files: `package.json`, `services/api/package.json`, `services/indexer/package.json`

## Missing Critical Features

**Production identity, role model, and authorization audit trail (Critical):**
- Problem: The API has no end-user authentication/session mechanism, no durable roles for creator/agent/reviewer, and no mutation audit trail tied to an authenticated principal.
- Blocks: Safely exposing task lifecycle, acceptance, disputes, training review, or financial actions to multiple real users.
- Files: `services/api/src/security.ts`, `services/api/src/app.ts`, `services/api/src/schema.sql`

**Contract deployment/configuration and end-to-end settlement adapter (Critical):**
- Problem: API routes maintain simulated task/stream state rather than creating and settling `StreamingVault` transactions, and no deployment configuration binds API/indexer to deployed contract addresses.
- Blocks: Treating USDC escrow, collateral, streaming payouts, or dispute outcomes as real protocol operations.
- Files: `services/api/src/app.ts`, `services/api/src/store.ts`, `contracts/scripts/deploy_testnet.js`, `services/indexer/src/index.ts`

## Test Coverage Gaps

**No database integration or concurrency tests (High):**
- What's not tested: PostgreSQL repositories, schema initialization, transaction behavior, authorization of `/pg` mutations, and race conditions in task claiming/acceptance.
- Files: `services/api/src/schema.sql`, `services/api/src/repositories/task.repository.ts`, `services/api/src/app.ts`, `services/api/test/api.test.ts`
- Risk: The production-labelled routes can fail only after deployment or permit unauthorized/inconsistent state changes unnoticed.
- Priority: High

**No indexer, ABI-compatibility, or reorganization tests (Critical):**
- What's not tested: That parsed event signatures exactly match `StreamingVault`, that events map to the correct persisted task, historical log ingestion, idempotency, retries, and reorg recovery.
- Files: `services/indexer/src/index.ts`, `contracts/src/StreamingVault.sol`, `contracts/test/contracts.test.js`
- Risk: Database state can silently disagree with on-chain escrow and lead users or operators to act on incorrect payment/dispute status.
- Priority: High

**No adversarial authorization or content-handling tests (High):**
- What's not tested: Caller ownership for task updates/claims/acceptance/review, behavior when `PACT_AUTH_TOKEN` is absent, malformed signature/address inputs, LLM prompt injection, and safe rendering of persisted artifacts/evidence.
- Files: `services/api/src/security.ts`, `services/api/src/app.ts`, `services/api/src/agent-runtime.ts`, `services/api/test/hardening.test.ts`, `frontend/src/App.tsx`
- Risk: Privilege escalation, data disclosure, or unsafe model/content behavior can regress without detection.
- Priority: High

---

*Concerns audit: 2026-07-20*
