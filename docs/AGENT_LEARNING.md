# PACT agent learning principle

PACT does not silently fine-tune a model or copy one agent's private history to
another agent. The live runtime improves through a small, consent-aware memory
of that same agent's accepted work.

## What becomes a learning example

The production execution path is:

1. The assigned agent runs `AgentRuntime` against an active Arc stream.
2. The runtime plans with its capability manifest and uses only allowlisted tools.
3. The runtime submits a deliverable, evidence receipts, and an execution trace.
4. The creator accepts the deliverable. The trace is then finalized as
   `SUCCESS` and `APPROVED`.
5. A later run retrieves the latest six successful, approved traces for the same
   `agent_address` and passes compact summaries to the model as quality signals.

The retrieval boundary is enforced in
`services/api/src/repositories/execution-trace.repository.ts`:

- `consent_to_training = TRUE`;
- `outcome = 'SUCCESS'`;
- `review_status = 'APPROVED'`;
- the trace belongs to the same agent wallet;
- at most six recent examples are returned.

Examples are guidance, not executable instructions. The model must still meet
the current task's criteria, use validated tool output, and follow the current
allowlist. Unsupported claims from an old deliverable are not copied as truth.

## What self-training means in the product

The Cabinet's **Start self-training** action enrolls the agent in daily PACT
Training Ground challenges. The autopilot solves bounded challenges, submits the
result with training consent, and awards Platform Points through the configured
adapter. This is a benchmark and feedback loop; it does not spend USDC.

Paid work is a separate path. The controller can send Arc Testnet USDC to the
agent's Circle smart-wallet address. That balance is used for paid-work claims,
collateral, settlement actions, and Arc gas. Funding the wallet does not itself
teach the model or grant Platform Points.

## What directions affect

The selected directions are the agent's public capability manifest. They affect:

- which marketplace work can match the agent;
- which task category and work-order requirements are accepted;
- which tools the runtime is allowed to call.

Directions are routing and safety constraints. They are not model training data
and do not change model weights.

## Separate offline model training

The `training/` workspace is a separate operator-controlled evaluation and
QLoRA/SFT pipeline. It should consume an explicitly exported, reviewed dataset
and produce a separately versioned model release. The live product's six-example
retrieval memory is intentionally much smaller, reversible, and does not require
rebuilding the model.

## Secret boundary

This document contains no credentials. Keep all secret values outside Git and
outside the browser bundle. In particular, never commit values for:

- `OPENAI_API_KEY`;
- `CIRCLE_API_KEY` or `CIRCLE_ENTITY_SECRET`;
- `PACT_AUTH_TOKEN`, `PACT_SESSION_SECRET`, or wallet private keys;
- PostgreSQL connection strings or operator settlement keys.

These belong in the server environment or a secret manager. The public Pages
runtime config may contain only public endpoints, Arc contract addresses, and
the public USDC address. `npm run build:pages` is safe to run without injecting
secrets into `frontend/dist`.

Before a push, inspect the staged patch and verify that local environment files
remain ignored:

```bash
git diff --cached --check
git status --short
```

The frontend build can be published separately:

```bash
npm run build:pages
npx wrangler pages deploy frontend/dist --project-name pact-protocol
```

The API must be deployed through its protected server profile with secrets
configured outside the repository.
