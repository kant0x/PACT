# Coding Conventions

**Analysis Date:** 2026-07-20

## Naming Patterns

**Files:**
- Use lowercase kebab-free filenames that name the module role: `services/api/src/agent-runtime.ts`, `services/api/src/agent-runtime.ts`, and `services/api/src/services/agent.service.ts`.
- Use `.test.ts` for TypeScript tests in `services/api/test/` and `.test.js` for contract tests in `contracts/test/contracts.test.js`.
- Use PascalCase Solidity contract filenames matching the contract: `contracts/src/StreamingVault.sol`, `contracts/src/ReputationRegistry.sol`, and `contracts/src/MockUSDC.sol`.
- Use Python snake_case module names under `training/src/pact_training/`, such as `training/src/pact_training/prepare.py` and `training/src/pact_training/common.py`.

**Functions:**
- Use camelCase for JavaScript/TypeScript functions, including small file-private helpers: `creatorTaskMessage`, `assertCreatorSignature`, and `createApp` in `services/api/src/app.ts`.
- Name asynchronous operations with action-oriented camelCase verbs, such as `sponsorFirstOperation` in `services/api/src/integrations/paymaster.ts` and `createApp` in `services/api/src/app.ts`.
- Use snake_case for Python functions and methods in `training/src/pact_training/`, consistent with modules such as `training/src/pact_training/prepare.py`.

**Variables:**
- Use camelCase for TypeScript/JavaScript locals and parameters (`authToken`, `agentRuntime`, `totalVolume`) in `services/api/src/app.ts`.
- Use UPPER_SNAKE_CASE for constants and configuration tables, such as `DEMO_ADDRESSES` in `shared/src/index.ts`, `REPUTATION_TIERS` in `services/api/src/config.ts`, and `ONE_USDC` in `contracts/test/contracts.test.js`.
- Use concise domain nouns for Express handlers (`request`, `response`, `next`) and keep prefixed underscore names for intentionally unused parameters (`_request`) in `services/api/src/app.ts`.

**Types:**
- Use PascalCase for interfaces, types, classes, and errors: `AppOptions` in `services/api/src/app.ts`, `AgentModelProvider` in `services/api/src/agent-runtime.ts`, and `ApiProblem` in `services/api/src/errors.ts`.
- Prefer string-literal unions for finite protocol values, as in `PayoutSpeed` and other shared protocol types in `shared/src/index.ts`.
- Import types using `import type`, including inline named type imports (`type Request`, `type Response`) in `services/api/src/app.ts` and interfaces imported by `frontend/src/api.ts`.

## Code Style

**Formatting:**
- No repository-level Prettier, Biome, or equivalent formatter configuration is detected.
- Preserve the local file's existing quote and trailing-comma style. TypeScript source in `services/api/src/app.ts` and `frontend/src/api.ts` predominantly uses single quotes and omits trailing commas in object literals; `contracts/test/contracts.test.js` uses double quotes and trailing commas.
- Indent TypeScript, JavaScript, Solidity, and Python blocks with two spaces in the inspected files, including `services/api/src/app.ts`, `contracts/test/contracts.test.js`, and `training/src/pact_training/prepare.py`.

**Linting:**
- No ESLint, Biome, Ruff, Flake8, Pylint, or similar lint configuration is detected.
- TypeScript strictness is enforced by `tsconfig.base.json` (`strict: true`, `forceConsistentCasingInFileNames: true`); API code builds through `services/api/tsconfig.json`.
- Keep TypeScript changes compatible with ESM/NodeNext imports: internal API imports end in `.js`, for example `./errors.js` in `services/api/src/app.ts`.

## Import Organization

**Order:**
1. External runtime packages, as in `express`, `helmet`, and `viem` at the top of `services/api/src/app.ts`.
2. Workspace packages, for example `@pact/shared` in `services/api/src/app.ts` and `frontend/src/api.ts`.
3. Relative application modules, using `.js` extensions in NodeNext API code, such as `./store.js` and `./security.js` in `services/api/src/app.ts`.
4. Stylesheet side effects only in frontend entrypoints, after implementation imports, as in `frontend/src/main.tsx`.

**Path Aliases:**
- Use `@pact/shared` for shared protocol definitions. It resolves to `shared/src/index.ts` in `services/api/vitest.config.ts` and `frontend/tsconfig.json`.
- Do not introduce a new API-internal alias; existing API modules use relative imports such as `../src/app.js` from `services/api/test/api.test.ts`.

## Error Handling

**Patterns:**
- Represent expected API failures with `ApiProblem(status, code, message, details?)` from `services/api/src/errors.ts`; route handlers throw it for validation and authorization failures in `services/api/src/app.ts`.
- Guard internal invariants through the `assert(...)` helper in `services/api/src/errors.ts`, which throws `ApiProblem` when a condition is false.
- Wrap awaited route work in `try/catch` and pass unexpected failures to Express `next(error)`, as used by PostgreSQL routes in `services/api/src/app.ts`.
- In policy-sensitive integrations, fail closed: `services/api/src/integrations/paymaster.ts` uses `PaymasterPolicyError`, explicit allowlists, and persistent reservation status.

## Logging

**Framework:** console

**Patterns:**
- No dedicated logging abstraction is detected. The service entrypoint `services/api/src/server.ts` uses direct process/server output; avoid adding a logging framework without a repository-wide decision.
- Keep request handlers free of incidental debug logging. Existing core logic such as `services/api/src/app.ts` and `services/api/src/store.ts` reports behavior through HTTP responses, typed errors, and persisted state instead.

## Comments

**When to Comment:**
- Comment non-obvious domain or security decisions, not routine syntax. Examples include the creator-wallet approval rationale in `services/api/src/app.ts` and protocol-scoping explanation in `contracts/test/contracts.test.js`.
- Keep comments immediately adjacent to the policy or invariant they explain.

**JSDoc/TSDoc:**
- Not used as a standard documentation mechanism in inspected TypeScript, JavaScript, or Python source. Prefer descriptive types, names, and focused comments.

## Function Design

**Size:**
- Keep reusable calculations and transformations in focused helpers (`text`, `creatorTaskMessage`) in `services/api/src/app.ts` and `toUsdcAtomic` in `services/api/src/integrations/paymaster.ts`.
- Existing high-level composition files can be large (`services/api/src/app.ts`, `frontend/src/App.tsx`); add new behavior as a helper, service, integration, or component rather than further expanding a monolithic handler when a natural boundary exists.

**Parameters:**
- Use typed object parameters for multi-field input (`AppOptions` in `services/api/src/app.ts`, `PublishTaskInput` in `frontend/src/api.ts`) and defaults for optional dependencies (`createApp(store = demoStore, options = {})`).
- Use dependency injection for replaceable collaborators, as with `arbitrator`, `agentProvider`, and `authToken` in `AppOptions`.

**Return Values:**
- Return typed domain objects or `Promise<T>` from public TypeScript API functions, as in `frontend/src/api.ts` and `services/api/src/agent-runtime.ts`.
- Return Express responses directly from short route handlers and throw `ApiProblem` for expected failures rather than returning ad-hoc error sentinel values.

## Module Design

**Exports:**
- Export public interfaces, classes, and functions directly from their defining module (`export class ApiProblem`, `export function createApp`); keep private helpers unexported unless consumed elsewhere.
- Use `export default` only for the React root component in `frontend/src/App.tsx`; use named exports for API, shared, and infrastructure modules.

**Barrel Files:**
- `shared/src/index.ts` is the intentional shared-contract barrel and should remain the public source for frontend/API protocol types and constants.
- No barrel-file pattern is used inside `services/api/src/`, `frontend/src/`, or `training/src/pact_training/`; import the defining module directly.

---

*Convention analysis: 2026-07-20*
