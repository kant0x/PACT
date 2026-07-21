# PACT architecture decisions

This document resolves ambiguities in the original implementation specification and defines the reproducible MVP.

## Runtime modes

- `demo` is the default. It runs without secrets, persists state in SQLite, uses deterministic arbitration unless OpenAI is configured, and shortens stream timing so the whole product can be demonstrated in minutes.
- `arc` is the production/testnet adapter boundary. It requires the addresses and user-owned Circle credentials listed in `.env.example`. Missing credentials must fail closed; the application never silently pretends a demo transaction is onchain.

## Money and identifiers

- API amounts are decimal USDC strings, for example `"500.00"`.
- Solidity amounts use six-decimal USDC base units.
- Marketplace IDs are opaque strings. `chainTaskId` stores the corresponding Vault `uint256` as a decimal string.

## Reputation model

The MVP score is clamped to `0..1000` and starts at 80:

```text
score = clamp(80 + completed*65 - failed*210 + ln(1 + volumeUSDC)*15, 0, 1000)
```

`ln(1 + volume)` makes zero safe. A failure costs more than three successes, limiting small-task reputation farming. The first successful 500 USDC task crosses the first threshold, satisfying the required demo scenario.

The original document simultaneously limited new agents to 100 USDC and required them to claim a 500 USDC end-to-end task. The MVP makes the beginner limit 500 USDC so the mandatory scenario is executable.

## Streaming semantics

The Solidity Vault accrues continuously from timestamps and caps payout at the task total. `payoutSpeed` controls an unlock interval in the orchestration layer and UI; it is not represented as continuous background transactions. Demo mode shortens these intervals while preserving the relative difference between SLOW, MEDIUM, and FAST.

## Contract security boundaries

- Both customer funds and collateral are ERC-20 USDC transferred with `transferFrom`; `postCollateral` is not payable.
- Reputation task IDs are append-only, writer-scoped, and can be recorded only once per writer; public history is paginated up to 100 outcomes per call.
- The Registry owner manages writer and external-attestor allowlists.
- Portable reputation uses EIP-712 signatures, deadlines, monotonic per-domain nonces, low-s recovery, and a recognized-score cap of 400.
- Up to 16 underwriters may fill missing agent collateral; returns, a 2% stream fee, timeout refunds, and slash losses are allocated proportionally.
- The Vault uses explicit state transitions, checks-effects-interactions, safe token transfers, and reentrancy protection.
- A configured dispute executor may pause and slash; the HTTP service does not impersonate the customer.

## Arbitration

The arbitration interface supports deterministic, single OpenAI, and three-role council providers. The OpenAI adapter uses the Responses API with a strict JSON Schema, isolates evidence as data, validates the verdict, and can fall back safely when the provider is unavailable. A 1/1/1 council split becomes `NEEDS_HUMAN_REVIEW`; an authenticated, server-identified reviewer may finalize it once, producing a receipt linked to the council decision hash. A real-money deployment must additionally add a durable reviewer identity system and an appeal window.

## Persistence and authentication

The API persists its state document in SQLite using WAL mode. Mutations can be protected with a constant-time compared Bearer token; the service also applies secure headers, an origin allowlist, bounded JSON parsing, and rate limiting. These controls are a deployment baseline, not end-user identity: real funds still require per-user sessions, role/signature authorization, secret rotation, monitoring, and durable onchain event indexing.

## Circle integration boundary

The repository includes current SDK/CLI paths for Arc Testnet developer wallets, Circle Agent Wallet creation/listing, mainnet-only spending policies, Gateway Nanopayments on `arcTestnet`, and an Arc SCA Gas Station guard. The guard permits one allowlisted first outbound `createTask` or `postCollateral` call, caps declared USDC exposure, records an atomic SQLite reservation, and blocks uncertain Circle responses for reconciliation. Scripts fail closed when credentials or private keys are absent. Agent Wallet policy commands reject testnet chains because Circle currently supports policy changes only on mainnet.
