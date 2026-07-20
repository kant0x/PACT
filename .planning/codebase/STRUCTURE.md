# Codebase Structure

**Analysis Date:** 2026-07-20

## Directory Layout

```
arc1/
├── package.json                 # Root npm workspace scripts and development coordinator
├── tsconfig.base.json           # Shared TypeScript compiler baseline
├── contracts/                   # Solidity sources, compiler/deployment scripts, tests, artifacts
│   ├── src/                     # MockUSDC, ReputationRegistry, StreamingVault, protocol mock
│   ├── scripts/                 # solc compilation and Arc deployment scripts
│   ├── test/                    # Ganache/Vitest contract tests
│   └── artifacts/               # Generated ABI/bytecode JSON
├── services/
│   ├── api/                     # Express API, demo state, persistence, integrations, tests/scripts
│   │   ├── src/                 # Runtime source code
│   │   ├── test/                # API security/arbitration/paymaster tests
│   │   ├── scripts/             # Demo, Circle wallet, gateway, and paymaster commands
│   │   └── data/                # Runtime SQLite files (generated local state)
│   └── indexer/                 # Standalone Arc event watcher to PostgreSQL projector
├── shared/                      # Cross-client TypeScript type contracts
│   └── src/index.ts             # Shared public type module
├── frontend/                    # React/Vite dashboard
│   ├── src/                     # React entry, UI, API client, wallet and localization modules
│   ├── public/                  # Static icon and locale JSON files
│   └── dist/                    # Generated Vite bundle
├── training/                    # Python trace-to-QLoRA training package and data/configs/evals
│   ├── src/pact_training/       # CLI and pipeline modules
│   ├── configs/                 # Training profile TOML
│   ├── data/                    # Prepared datasets and task-factory output
│   ├── evals/                   # Policy-evaluation cases
│   └── examples/                # Sample trace input
├── docs/                        # Product, protocol, runtime, trust, and site documentation
├── outputs/                     # Generated presentation/image deliverables
└── .planning/codebase/          # Generated codebase mapping documents
```

## Directory Purposes

**`services/api/src/`:**
- Purpose: Implement the backend application and local-demo domain model.
- Contains: Express composition (`app.ts`), HTTP/WebSocket bootstrap (`server.ts`), domain state (`store.ts`), policy/configuration, persistence, repositories, integrations, scripts-facing logic, and API types/errors/security.
- Key files: `services/api/src/app.ts`, `services/api/src/server.ts`, `services/api/src/store.ts`, `services/api/src/agent-runtime.ts`, `services/api/src/arbitration.ts`.

**`services/api/src/repositories/`:**
- Purpose: Hold PostgreSQL persistence adapters used by `/pg` endpoints.
- Contains: One repository per aggregate: agent, client, task, dispute, execution trace, deliverable, and agent run.
- Key files: `services/api/src/repositories/task.repository.ts`, `services/api/src/repositories/dispute.repository.ts`, `services/api/src/repositories/execution-trace.repository.ts`.

**`services/api/src/integrations/`:**
- Purpose: Isolate third-party Circle SDK/x402/paymaster behavior from API routes and domain state.
- Contains: Arc developer wallet/gateway helpers and Circle paymaster policy/ledger/adapter.
- Key files: `services/api/src/integrations/circle.ts`, `services/api/src/integrations/paymaster.ts`.

**`services/api/scripts/`:**
- Purpose: Provide executable operational and demo workflows without embedding command-line concerns in `src/`.
- Contains: seed/scenario clients and Circle wallet, agent-wallet, gateway, and paymaster commands.
- Key files: `services/api/scripts/seed.ts`, `services/api/scripts/run-scenario.ts`, `services/api/scripts/circle-paymaster.ts`.

**`services/indexer/`:**
- Purpose: Run the independent Arc-chain event watcher.
- Contains: one Viem/`pg` process that projects vault events into PostgreSQL.
- Key files: `services/indexer/src/index.ts`, `services/indexer/package.json`.

**`shared/`:**
- Purpose: Publish stable TypeScript shapes shared by the browser and API.
- Contains: one source module plus generated `dist/` build output.
- Key files: `shared/src/index.ts`, `shared/tsconfig.json`.

**`frontend/src/`:**
- Purpose: Implement the dashboard UI, client transport, browser wallet configuration, and localization behavior.
- Contains: React root, large page/component composition, fetch client, chain config, locale provider, and several global CSS files.
- Key files: `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/api.ts`, `frontend/src/wagmi.ts`, `frontend/src/locale.ts`.

**`frontend/public/`:**
- Purpose: Serve files unchanged through Vite.
- Contains: PACT SVG icon and locale documents.
- Key files: `frontend/public/pact-icon.svg`, `frontend/public/locales/en.json`, `frontend/public/locales/ru.json`, `frontend/public/locales/es.json`.

**`contracts/src/`:**
- Purpose: Define Arc/EVM settlement and reputation protocol behavior.
- Contains: ERC-20 test token, registry, streaming vault, and third-party writer mock.
- Key files: `contracts/src/StreamingVault.sol`, `contracts/src/ReputationRegistry.sol`, `contracts/src/MockUSDC.sol`, `contracts/src/ThirdPartyProtocolMock.sol`.

**`contracts/scripts/`:**
- Purpose: Compile contracts without a framework-specific build system and deploy the main contracts to a configured RPC.
- Contains: `solc` orchestration and Ethers deployment script.
- Key files: `contracts/scripts/compile.js`, `contracts/scripts/deploy_testnet.js`.

**`training/src/pact_training/`:**
- Purpose: Package the first-party trace export, preparation, evaluation, factory, and QLoRA runner.
- Contains: standard Python modules invoked by the package console script.
- Key files: `training/src/pact_training/cli.py`, `training/src/pact_training/export.py`, `training/src/pact_training/prepare.py`, `training/src/pact_training/train.py`.

**`docs/`:**
- Purpose: Preserve product and safety decisions that operational code follows.
- Contains: architecture, trust model, agent protocol/runtime, site guide, risk register, and documentation index.
- Key files: `docs/ARCHITECTURE.md`, `docs/TRUST_MODEL.md`, `docs/AGENT_PROTOCOL.md`, `docs/AGENT_RUNTIME.md`, `docs/SITE_GUIDE.md`.

## Key File Locations

**Entry Points:**
- `package.json`: Root `dev`, `build`, `test`, and workspace orchestration scripts.
- `services/api/src/server.ts`: Node API and WebSocket process entry point.
- `services/api/src/app.ts`: Express app factory and full REST route table.
- `frontend/index.html`: Vite HTML shell.
- `frontend/src/main.tsx`: React/Wagmi/Query/locale mount point.
- `services/indexer/src/index.ts`: Arc vault event indexer process.
- `contracts/scripts/compile.js`: Solidity compiler entry point.
- `training/src/pact_training/cli.py`: Python training CLI entry point.

**Configuration:**
- `package.json`: Node engine, workspaces, and aggregate commands.
- `tsconfig.base.json`: TypeScript baseline applied by workspace configs.
- `frontend/vite.config.ts`: React plugin, shared type alias, and Vite dev port.
- `services/api/src/config.ts`: Reputation tiers, stream terms, and slash percentages.
- `services/api/src/schema.sql`: PostgreSQL tables/indexes for `/pg` persistence.
- `training/configs/qwen35-2b-qlora.toml`: QLoRA profile and dataset/training thresholds.

**Core Logic:**
- `services/api/src/store.ts`: Default marketplace, streams, disputes, agent runs, training traces, and demo state transitions.
- `services/api/src/agent-runtime.ts`: Agent plan/execution and deliverable lifecycle.
- `services/api/src/arbitration.ts`: Deterministic/OpenAI/council decision logic.
- `services/api/src/arena.ts`: Built-in document-training challenge content and deterministic scoring.
- `shared/src/index.ts`: Domain DTO/type definitions.
- `contracts/src/StreamingVault.sol`: Onchain streaming/collateral lifecycle.
- `contracts/src/ReputationRegistry.sol`: Onchain outcome/reputation registry.

**Testing:**
- `services/api/test/api.test.ts`: API flow tests.
- `services/api/test/arbitration.test.ts`: Arbitration behaviors.
- `services/api/test/hardening.test.ts`: Security/hardening behavior.
- `services/api/test/paymaster.test.ts`: Circle paymaster policy/ledger behavior.
- `contracts/test/contracts.test.js`: Local Ganache Solidity contract tests.
- `training/evals/pact_policy_eval.jsonl`: Offline policy evaluation cases, not a unit-test runner suite.

## Naming Conventions

**Files:**
- TypeScript modules use lowercase kebab/camel descriptive names where applicable: `agent-runtime.ts`, `agent.service.ts`, `task.repository.ts`.
- React UI is concentrated in PascalCase `frontend/src/App.tsx`; shared styles use lowercase kebab names such as `product-signals.css`.
- Solidity contracts use PascalCase filenames matching the contract: `StreamingVault.sol`, `ReputationRegistry.sol`.
- Python modules use lowercase snake_case: `prepare.py`, `score_responses` in `training/src/pact_training/evaluate.py`.

**Directories:**
- Group backend specialized adapters by role: `repositories/`, `services/`, `integrations/`, and `scripts/` under `services/api/`.
- Group source under `src/`, public browser assets under `public/`, generated build output under `dist/` or `artifacts/`, and executable validation under `test/`/`evals/`.

## Where to Add New Code

**New Feature:**
- Default local feature/domain behavior: add a focused method and shared types in `services/api/src/store.ts` and `shared/src/index.ts`; expose it through `services/api/src/app.ts`; call it from `frontend/src/api.ts` and render it in `frontend/src/App.tsx`.
- PostgreSQL variant: add or extend a repository in `services/api/src/repositories/`, evolve `services/api/src/schema.sql`, then add the explicit `/pg` route in `services/api/src/app.ts`.
- Tests: add API coverage in `services/api/test/<feature>.test.ts`; add Solidity behavior in `contracts/test/contracts.test.js` only for onchain protocol changes.

**New Component/Module:**
- Browser implementation: begin with a module in `frontend/src/` and import it into `frontend/src/App.tsx`; keep request details in `frontend/src/api.ts`, not component event handlers.
- Backend provider/adapter: define the interface beside related runtime logic (`services/api/src/agent-runtime.ts` or `services/api/src/arbitration.ts`) and put external vendor integrations in `services/api/src/integrations/`.
- Shared DTO: put public request/response/domain types in `shared/src/index.ts` before using them on both sides.

**Utilities:**
- Backend domain utilities: co-locate with the owning subsystem (`services/api/src/arena.ts`, `services/api/src/security.ts`, `services/api/src/config.ts`) rather than creating a generic catch-all folder.
- Python reusable helpers: add them to `training/src/pact_training/common.py` when they are training-pipeline specific.
- Contract reusable behavior: keep it private to the relevant Solidity source unless it represents a stable separately deployed interface.

## Special Directories

**`services/api/data/`:**
- Purpose: Local SQLite state such as `pact.sqlite` and WAL/SHM sidecars.
- Generated: Yes.
- Committed: Treat as runtime state; do not use it as source-of-truth application code.

**`frontend/dist/`, `shared/dist/`, `services/api/dist/`, and `services/indexer/dist/`:**
- Purpose: Generated JavaScript/type build output.
- Generated: Yes.
- Committed: Build artifacts may exist in the working tree; edit their `src/` inputs instead.

**`contracts/artifacts/`:**
- Purpose: ABI and bytecode JSON produced by `contracts/scripts/compile.js` for tests/deployment.
- Generated: Yes.
- Committed: Regenerated by the contract build; change `contracts/src/` then compile.

**`training/data/`:**
- Purpose: Prepared JSONL datasets, manifests, and task-factory output used by the training workflow.
- Generated: Partly; `prepared/` and `factory/` are outputs of CLI commands while inputs/examples are retained nearby.
- Committed: Inspect provenance and data policy before committing additions.

**`outputs/`:**
- Purpose: Generated pitch deck and visual deliverables.
- Generated: Yes.
- Committed: Treat as deliverable output, not runtime code.

**`.planning/codebase/`:**
- Purpose: GSD-generated map documents for future planning and implementation work.
- Generated: Yes.
- Committed: Yes when the planning workflow requires these maps.

---

*Structure analysis: 2026-07-20*
