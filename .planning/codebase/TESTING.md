# Testing Patterns

**Analysis Date:** 2026-07-20

## Test Framework

**Runner:**
- Vitest `^3.2.4` is used by `services/api/package.json` and `contracts/package.json`.
- API config: `services/api/vitest.config.ts` (Node environment and `@pact/shared` source alias).
- Contract tests invoke Vitest without a dedicated Vitest config through `contracts/package.json`.

**Assertion Library:**
- Vitest's built-in `expect`, imported from `vitest` in `services/api/test/api.test.ts` and `contracts/test/contracts.test.js`.
- API HTTP assertions use Supertest in `services/api/test/api.test.ts`, `services/api/test/hardening.test.ts`, and `services/api/test/arbitration.test.ts`.

**Run Commands:**
```bash
npm test                         # Run all workspace tests that define a test script
npm run test -w @pact/api        # Run the API Vitest suite once
npm run test:watch -w @pact/api  # Run API tests in Vitest watch mode
npm run test -w @pact/contracts  # Compile Solidity artifacts, then run contract tests
```

## Test File Organization

**Location:**
- API tests are separate from source in `services/api/test/*.test.ts`; source remains in `services/api/src/`.
- Contract tests live in `contracts/test/contracts.test.js`, alongside `contracts/src/*.sol` and build output from `contracts/scripts/compile.js`.
- No test files or test runner are detected for `frontend/src/`, `services/indexer/src/`, `shared/src/`, or `training/src/pact_training/`.

**Naming:**
- Use `<area>.test.ts` for API tests: `services/api/test/api.test.ts`, `services/api/test/arbitration.test.ts`, `services/api/test/hardening.test.ts`, and `services/api/test/paymaster.test.ts`.
- Use a descriptive `.test.js` contract integration suite: `contracts/test/contracts.test.js`.

**Structure:**
```
services/api/
├── src/                         # implementation
├── test/
│   ├── api.test.ts               # HTTP lifecycle and websocket flows
│   ├── arbitration.test.ts       # arbitration policy and review flows
│   ├── hardening.test.ts         # persistence/security/regression cases
│   └── paymaster.test.ts         # integration adapter policy cases
└── vitest.config.ts              # Node environment and source alias

contracts/
├── src/                          # Solidity contracts
└── test/contracts.test.js        # Ganache-backed lifecycle tests
```

## Test Structure

**Suite Organization:**
```typescript
// services/api/test/arbitration.test.ts
describe('arbitration council', () => {
  it('requires a majority and creates tamper-evident decision receipts', async () => {
    const store = new DemoStore();
    const task = activeTask(store);
    const council = new CouncilArbitrator({ judges: [/* deterministic test doubles */] });

    const decision = await council.decide({ task, reason: '...', evidence: '...' });

    expect(decision.verdict).toBe('PARTIAL_FAULT');
    expect(decision.receipt).toMatchObject({ quorumRequired: 2, votesReceived: 3 });
  });
});
```

**Patterns:**
- Organize one feature or policy boundary per `describe`; write behavior-level `it` names that state the security or lifecycle outcome.
- Construct fresh in-memory state per test with `new DemoStore()` and inject it into `createApp(store)` as in `services/api/test/api.test.ts`.
- Use Vitest lifecycle cleanup when a test opens resources: `services/api/test/api.test.ts` closes every `PactServer` in `afterEach`, while `services/api/test/hardening.test.ts` removes SQLite temporary files in `afterEach`.
- Assert HTTP outcomes fluently with Supertest (`.get(...).expect(200)`) and then inspect body invariants with `expect(...).toMatchObject`, as in `services/api/test/api.test.ts`.

## Mocking

**Framework:**
- No `vi.mock` or module-level mocking pattern is detected. Tests use dependency injection and handwritten fakes.

**Patterns:**
```typescript
// services/api/test/paymaster.test.ts
function fakeClient(existingOutbound = false) {
  const calls: unknown[] = [];
  const client: PaymasterCircleClient = {
    async getWallet() { return { data: { wallet: {/* test view */} } }; },
    async listTransactions() { return { data: { transactions: [] } }; },
    async createContractExecutionTransaction(input) {
      calls.push(input);
      return { data: { id: 'circle-transaction-1', state: 'INITIATED' } };
    }
  };
  return { client, calls };
}
```

**What to Mock:**
- Inject interfaces for networked or nondeterministic services, such as `PaymasterCircleClient` in `services/api/test/paymaster.test.ts` and `Arbitrator` implementations in `services/api/test/arbitration.test.ts`.
- Use `AppOptions` to inject an arbitrator, auth token, or agent provider into `createApp` from `services/api/src/app.ts`.

**What NOT to Mock:**
- Do not mock in-memory domain behavior under `DemoStore`; exercise realistic task/dispute lifecycles through it, as in `services/api/test/api.test.ts`.
- Do not mock deployed Solidity interactions in contract tests; `contracts/test/contracts.test.js` compiles artifacts and runs real ethers transactions against Ganache.

## Fixtures and Factories

**Test Data:**
```typescript
// services/api/test/arbitration.test.ts
const activeTask = (store: DemoStore) => {
  const task = store.createTask({
    title: 'Council-reviewed delivery',
    creatorAddress: DEMO_ADDRESSES.creator,
    totalAmount: '100',
    estimatedDurationSeconds: 60
  });
  store.claimTask(task.id, DEMO_ADDRESSES.newbie);
  return store.getTask(task.id);
};
```

**Location:**
- Factories and test constants are co-located at the top of the test file: `activeTask` and `judge` in `services/api/test/arbitration.test.ts`; `fakeClient` and wallet constants in `services/api/test/paymaster.test.ts`.
- Shared stable demo identities come from `DEMO_ADDRESSES` in `shared/src/index.ts`.
- Contract setup is factored into local helpers (`artifact`, `deploy`, `createTask`, `postCollateral`, `advance`) in `contracts/test/contracts.test.js` and initialized in `beforeEach`.

## Coverage

**Requirements:** None enforced. No coverage provider, coverage script, reporting configuration, or threshold configuration is detected in `package.json`, `services/api/package.json`, `contracts/package.json`, or `services/api/vitest.config.ts`.

**View Coverage:**
```bash
# Not configured. Add a Vitest coverage provider and script before relying on coverage output.
```

## Test Types

**Unit Tests:**
- Pure policy and adapter behavior is tested with fakes and direct class calls, including Circle Paymaster validation in `services/api/test/paymaster.test.ts` and council decisions in `services/api/test/arbitration.test.ts`.

**Integration Tests:**
- API integration tests call Express through Supertest in `services/api/test/api.test.ts` and `services/api/test/hardening.test.ts`.
- Smart-contract integration tests compile Solidity, deploy contracts with ethers, and execute against a per-test Ganache provider in `contracts/test/contracts.test.js`.
- SQLite persistence is exercised with temporary database files in `services/api/test/hardening.test.ts`.

**E2E Tests:**
- Not used. No Playwright, Cypress, browser test runner, or frontend test framework is detected.

## Common Patterns

**Async Testing:**
```typescript
// services/api/test/api.test.ts
const created = await request(app).post('/api/tasks').send({
  title: 'Verification task',
  creatorAddress: DEMO_ADDRESSES.creator,
  totalAmount: '500',
  estimatedDurationSeconds: 1
}).expect(201);

const claimed = await request(app)
  .post(`/api/tasks/${created.body.id}/claim`)
  .send({ agentAddress: DEMO_ADDRESSES.newbie })
  .expect(200);
expect(claimed.body).toMatchObject({ status: 'STREAMING' });
```

**Error Testing:**
```typescript
// services/api/test/paymaster.test.ts
await expect(adapter.sponsorFirstOperation(walletId, operation))
  .rejects.toThrow(/already reserved or submitted/);

// services/api/test/hardening.test.ts
await request(app).post('/api/demo/reset').expect(401);
await request(app)
  .post('/api/demo/reset')
  .set('Authorization', 'Bearer wrong')
  .expect(401);
```

---

*Testing analysis: 2026-07-20*
