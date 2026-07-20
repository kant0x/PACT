# Technology Stack

**Analysis Date:** 2026-07-20

## Languages

**Primary:**
- TypeScript 5.8 - Browser UI, shared domain types, API, PostgreSQL repositories, and the standalone blockchain indexer. Source lives in `frontend/src/`, `shared/src/index.ts`, `services/api/src/`, and `services/indexer/src/`.
- Solidity 0.8.30 - EVM contracts in `contracts/src/`, compiled by `contracts/scripts/compile.js`.

**Secondary:**
- JavaScript (ES modules) - Contract compiler/deployment and contract tests in `contracts/scripts/` and `contracts/test/contracts.test.js`.
- Python 3.11+ - Consent-aware QLoRA/SFT training package in `training/src/pact_training/`, declared in `training/pyproject.toml`.
- SQL (PostgreSQL dialect) - Production relational schema in `services/api/src/schema.sql`.

## Runtime

**Environment:**
- Node.js 22+ - required by the root workspace `package.json` and pinned by `.nvmrc`; API uses Node's built-in `node:sqlite` `DatabaseSync` in `services/api/src/persistence.ts` and `services/api/src/integrations/paymaster.ts`.
- Python 3.11+ - required by `training/pyproject.toml`.

**Package Manager:**
- npm 10+ - root scripts and npm workspaces in `package.json`.
- Lockfile: present at `package-lock.json`.
- The root workspace includes `shared`, `contracts`, `services/api`, and `frontend`; `services/indexer` and `training` are standalone packages and must be installed/run from their own directories or environments.

## Frameworks

**Core:**
- React 19.1 + React DOM 19.1 - single-page control-room UI in `frontend/src/App.tsx`, bootstrapped by `frontend/src/main.tsx`.
- Vite 7.0 + `@vitejs/plugin-react` 4.6 - frontend dev server and production bundler, configured in `frontend/vite.config.ts` (port 5173).
- Express 5.1 - REST API application assembled in `services/api/src/app.ts` and served in `services/api/src/server.ts`.
- `ws` 8.18 - API WebSocket server and browser live-stream status channel at `/api/streams/:taskId/live`; implementation is `services/api/src/server.ts` and client usage is `frontend/src/App.tsx`.
- Wagmi 3.7, Viem 2.55, and Ethers 6 - EVM wallet/signature/RPC support; UI chain setup is `frontend/src/wagmi.ts`, server verification is in `services/api/src/app.ts`, indexer is `services/indexer/src/index.ts`, and deployment is `contracts/scripts/deploy_testnet.js`.

**Testing:**
- Vitest 3.2 - API and Solidity contract tests. API configuration is `services/api/vitest.config.ts`; API tests are in `services/api/test/`, and contract tests are `contracts/test/contracts.test.js`.
- Supertest 7.1 and `ws` - HTTP and WebSocket API test clients in `services/api/test/api.test.ts`.
- Ganache 7.9 - local EVM test chain used by `contracts/test/contracts.test.js`.

**Build/Dev:**
- TypeScript compiler - API, shared package, frontend typechecking, and indexer output use `tsc`; base compiler options are in `tsconfig.base.json`.
- `tsx` 4.20 - API and indexer development/runtime scripts, declared in `services/api/package.json` and `services/indexer/package.json`.
- `solc` 0.8.30 - custom Solidity compilation with optimizer and `shanghai` EVM target in `contracts/scripts/compile.js`.
- Hatchling - Python package build backend in `training/pyproject.toml`.

## Key Dependencies

**Critical:**
- `@pact/shared` 0.1.0 - workspace package for API/UI domain types and protocol definitions; source is `shared/src/index.ts` and Vite/Vitest alias it directly in `frontend/vite.config.ts` and `services/api/vitest.config.ts`.
- `pg` 8.22 - PostgreSQL client for production-style API repositories in `services/api/src/db.ts` and event indexer state updates in `services/indexer/src/index.ts`.
- `openai` 6.47 - optional live agent provider and arbitrator council integrations in `services/api/src/agent-runtime.ts` and `services/api/src/arbitration.ts`; deterministic providers are used with no API key.
- `@circle-fin/developer-controlled-wallets` 10.3 and `@circle-fin/x402-batching` 3.2 - optional Arc developer wallets, Agent Wallet tooling, x402 gateway payments, and paymaster actions in `services/api/src/integrations/circle.ts` and `services/api/src/integrations/paymaster.ts`.

**Infrastructure:**
- `dotenv` - environment loading in `services/api/src/db.ts` and `services/indexer/src/index.ts`.
- `helmet`, `cors`, and `express-rate-limit` - API headers, origin policy, and rate limiting configured in `services/api/src/app.ts`.
- `@tanstack/react-query` 5.101 - frontend remote-data caching in `frontend/src/App.tsx`.
- `torch`, `transformers`, `peft`, `trl`, `accelerate`, `bitsandbytes`, and `datasets` - Python QLoRA/SFT training pipeline requirements in `training/pyproject.toml`.

## Configuration

**Environment:**
- `.env.example` is present, and `.env` is documented as the local configuration source in `README.md`; secret files are not inspected.
- API configuration is read directly from `process.env` in `services/api/src/app.ts`, `services/api/src/arbitration.ts`, `services/api/src/agent-runtime.ts`, `services/api/src/db.ts`, and `services/api/src/integrations/`.
- Browser configuration is Vite-exposed only through `VITE_API_URL`, `VITE_API_TOKEN`, `VITE_PACT_MODE`, and `VITE_AUTO_SEED_DEMO` in `frontend/src/api.ts` and `frontend/src/App.tsx`.
- Blockchain deployment/indexing configuration is consumed in `contracts/scripts/deploy_testnet.js` and `services/indexer/src/index.ts`.

**Build:**
- Root orchestration: `package.json`; workspace lockfile: `package-lock.json`.
- TypeScript: `tsconfig.base.json`, plus package configs under `frontend/`, `shared/`, `services/api/`, and `services/indexer/`.
- Frontend bundling: `frontend/vite.config.ts`.
- API tests: `services/api/vitest.config.ts`.
- Python packaging/training dependencies: `training/pyproject.toml`; default QLoRA run configuration: `training/configs/qwen35-2b-qlora.toml`.

## Platform Requirements

**Development:**
- Install Node.js 22+ and npm 10+, then run `npm install` and `npm run dev` from the repository root for API plus Vite UI, as documented in `README.md`.
- Install Python 3.11+ plus PyTorch-compatible GPU dependencies only when running `training/`; `training/README.md` documents the virtual-environment workflow and targets a 6 GB GTX 1660 Super for the default profile.
- Run PostgreSQL only when exercising `/pg` API routes or `services/indexer/`; the local demo persists to SQLite and runs without external accounts.
- Run an Arc-compatible RPC endpoint plus funded credentials only for contract deployment, Circle workflows, or live indexer operation.

**Production:**
- No deployment manifest, container definition, hosted-platform configuration, or CI configuration is detected in the repository root.
- The API is a Node process (`npm start -w @pact/api`); build output is `services/api/dist/`. The frontend is a static Vite build in `frontend/dist/`. PostgreSQL and Arc/Circle credentials are required for the optional production-style and on-chain paths.

---

*Stack analysis: 2026-07-20*
