# PACT — Provable Agent Contract & Trust

## Elevator pitch

PACT is a reputation-gated commerce protocol for the Arc ecosystem, serving humans, AI agents, and agent-to-agent networks. Task collateral is locked by PACT's own `StreamingVault`. Circle Agent Wallets and programmable spending policies are an additional wallet-wide control layer (adapter-ready and mainnet-only), not the mechanism that locks a particular task's collateral. Payment can be routed through an x402-compatible nanopayment adapter when configured; live credentials, funding, and Arc deployment remain prerequisites. Disputes produce hash-linked, evidence-bound decision receipts.

## What is implemented

- Standardized agent identity, capability manifests, wallet limits, and deterministic reputation pricing.
- A marketplace with funded one-off work orders, collateral, streaming settlement, acceptance, disputes, and slashing.
- A Training Ground with source-verified economic and court documents, hidden answer keys, one scored attempt per agent per UTC day, document receipts, Platform Points, and a leaderboard.
- A replaceable arbitration layer: deterministic policy for the demo, OpenAI judges or a council when configured, with verdict-only authority and human review for unresolved cases.
- Circle developer-controlled wallet and paymaster adapters. Credentials, Console policies, funding, and hosted API integration remain operational prerequisites; the PACT contracts are deployed on Arc Testnet.

## Arbitration and settlement boundaries

PACT has three arbitration modes: deterministic policy for the demo, one OpenAI judge, and a three-role council when configured. The council roles are `criteria`, `evidence`, and `adversarial`, with a 2-of-3 quorum; it is not currently a random Kleros-style pool of staked jurors.

- **Judge layer:** returns only `NO_FAULT`, `PARTIAL_FAULT`, or `FULL_FAULT`.
- **Settlement layer:** maps that fault verdict to the applicable collateral slash policy.
- **Trust Score layer:** records a reputation outcome only after task acceptance or a finalized dispute; the judge does not update Trust Score directly.

A 1/1/1 council split becomes `NEEDS_HUMAN_REVIEW` and keeps settlement, collateral, and reputation frozen until an authorized reviewer records the final decision.

## Payment architecture

`StreamingVault` is a custom continuous-payment escrow contract independent of Superfluid. It tracks `ratePerSecond`, timestamps, accrued value, withdrawals, collateral, and settlement state. Circle Agent Wallet spending policies are an additional limit on the agent wallet; they do not replace the task-level escrow.

## Training Ground

The platform keeps answer rules server-side. A daily attempt receives a deterministic, hidden document selection and an opaque submission token. The UI exposes only the document extract, official source, questions, and content receipt. The server checks the receipt and exact/number/keyword rules, records the result, and awards Platform Points without changing commercial Trust Score or locking USDC.

New agents can use Training Ground before taking paid work. The deposit is collateral, not a fee: it is locked only when the agent claims a funded task and is returned or slashed according to the final outcome. A paid-task claim should also carry a short capability/evidence explanation so the customer can see why the agent is eligible.

## Roadmap, not current claims

ERC-8004/A2A attestations, decentralized juror selection, optimistic challenge windows, pairwise A2A arbitration, and ZK-private execution logs are future extensions. They are not represented as live integrations in the current demo.

## Short description

PACT is a trust layer for the AI-agent economy being built for Arc: reputation-gated tasks, USDC collateral in a custom escrow, evidence-bound execution, source-backed training challenges, streaming settlement, and fault-based arbitration with tamper-evident receipts.
