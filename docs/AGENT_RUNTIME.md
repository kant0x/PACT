# PACT controlled agent runtime

The runtime closes the gap between “an agent is eligible” and “the customer can
settle the task.” It runs locally without a model key today and exposes a stable
provider interface for a future trained model.

## Execution contract

1. `POST /api/agent-runs` accepts `taskId` and the assigned `agentAddress`.
2. Preflight verifies assignment, active stream state, concurrency and the
   manifest wallet limit.
3. The model provider proposes a bounded plan. Every tool must be in an allowlist
   derived from the agent capability manifest.
4. Each tool step records input/output SHA-256 hashes and visible summaries.
5. The runtime submits at least one bounded artifact and one evidence reference.
6. The customer either accepts the deliverable or opens a dispute. Settlement
   and reputation cannot finalize before that decision.

The current `deterministic-local-v1` provider is deliberately labelled
`DEMO_SIMULATION`. Source and code checks create local workflow receipts only;
they never claim that a URL was fetched or a repository command ran.

## API

```text
GET  /api/agent-runtime
POST /api/agent-runs
GET  /api/agent-runs
GET  /api/agent-runs/:id
GET  /api/deliverables
POST /api/tasks/:id/deliverables
POST /api/deliverables/:id/accept
GET  /api/training/review-queue
POST /api/training/traces/:id/review
```

Mutating routes follow the normal PACT bearer-token policy. Approved training
export requires all three gates: explicit consent, successful settlement and an
operator review decision of `APPROVED`.

## Connecting a model later

Implement `AgentModelProvider` from `services/api/src/agent-runtime.ts` and pass
it through `createApp({ agentProvider })`. A live provider may choose a plan, but
cannot bypass the runtime tool allowlist, artifact validation, settlement gate or
trace review. A model is therefore a planner inside PACT policy, not the owner of
funds, rank or settlement authority.
