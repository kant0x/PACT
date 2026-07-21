# PACT presentation fact-check

This is the source-of-truth checklist for the pitch deck and presenter notes.

## Safe claims for the current MVP

- PACT is an Arc-targeted reputation-gated commerce protocol for customers, AI agents, and agent-to-agent networks.
- The local MVP demonstrates funded work orders, agent registration, capability-gated claiming, collateral terms, streaming settlement, evidence-bound deliverables, acceptance, disputes, and reputation outcomes.
- `StreamingVault` is PACT's task-level escrow and collateral contract. Circle Spending Policy is only an additional mainnet-only, wallet-wide spending limit and does not lock a particular task's collateral.
- The judge returns only `NO_FAULT`, `PARTIAL_FAULT`, or `FULL_FAULT`. Settlement applies the slash policy. Trust Score changes only after acceptance or a finalized dispute.
- The council, when configured, has `criteria`, `evidence`, and `adversarial` roles with a 2-of-3 quorum. A 1/1/1 split becomes `NEEDS_HUMAN_REVIEW`.
- Training Ground uses source-backed economic and court-document extracts, hidden answer rules, one scored attempt per agent/template/UTC day, document receipts, and Platform Points. It does not change commercial Trust Score or lock USDC.
- External agents are API-first: the developer owns the runtime, signs a wallet-backed capability manifest, and calls the onboarding API. A fork receives a new wallet and a new Trust Score.
- A creator may reserve a work order for a registered agent (direct hire) or publish an open order for eligible agents to claim.

## Claims that must be qualified

- Say **Arc-targeted**, **Arc-ready**, or **next deployment step**; do not say that the current demo is already live on Arc.
- Say **adapter-ready** for Circle wallets, spending policies, Gateway/x402 nanopayments, and OpenAI arbitration unless the required credentials, funding, and deployment have been configured.
- Say **local/demo execution** for the deterministic provider and SQLite state.

## Claims not to make

- Do not describe Circle Spending Policy as task escrow or as the mechanism that locks collateral.
- Do not call the council a random Kleros-style pool of staked jurors.
- Do not say the judge changes Trust Score directly or is the sole source of reputation.
- Do not claim ERC-8004, A2A attestations, ZK-private logs, decentralized juror selection, or optimistic challenge windows are live integrations.
- Do not claim Training Ground automatically increases commercial Trust Score.

## Verification snapshot

The current repository check passes with 8 contract tests and 36 API tests. The final pitch deck uses the supplied PACT logo and explicitly labels the local MVP boundary and adapter-ready integrations.
