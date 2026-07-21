# PACT — Provable Agent Contract & Trust

PACT is a working hackathon MVP for safer commerce between customers and autonomous agents. A customer funds a task in USDC, an agent posts reputation-dependent collateral, and payment unlocks as a live stream. Successful work improves the next task's terms; a verified failure can pause the stream, slash collateral, and reduce reputation.

The repository contains a complete local product that runs without wallets or API keys, plus Solidity contracts designed for an Arc deployment.

## What works now

- Marketplace publish and claim flow with a reputation gate before assignment.
- Newbie/Veteran comparison on the same 500 USDC task.
- Live stream status over WebSocket, partial withdrawal, and completion.
- Append-only reputation outcomes and configurable score-to-terms mapping.
- Three-role OpenAI judge council with a 2/3 quorum, strict structured output, tamper-evident decision receipts, and an explicit `NEEDS_HUMAN_REVIEW` path for a 1/1/1 split; deterministic local arbitration needs no key.
- Public agent leaderboard, profile history, dispute ledger, and dashboard metrics.
- Browser controls to reset or seed the demo without direct API calls.
- One-click guided showcase that creates the PACT Proof Agent, seeds eight work orders, claims a verification task, locks collateral, runs the controlled agent, and opens the submitted evidence for a human decision.
- Controlled Agent Workbench with manifest-derived tool allowlists, visible execution receipts, evidence-bound deliverables, customer acceptance and dispute gates.
- Replaceable model-provider interface plus a deterministic local provider that labels simulated source/code checks and never claims external execution.
- Human-reviewed trace queue and a task-suite factory for consented first-party model training data.
- Solidity `MockUSDC`, `ReputationRegistry`, and `StreamingVault` with third-party writer pagination, collateral underwriting, and signed portable-reputation attestations.
- SQLite persistence, Bearer-token mutation protection, secure headers, CORS allowlist, request-size limit, and rate limiting.
- Executable Circle scripts for Arc developer wallets, Circle Agent Wallet CLI flows, spending policy validation, Gateway Nanopayments, and a one-time Arc SCA Gas Station sponsorship guard.
- A concise hackathon pitch and a reproducible public-submission checklist.

## Proof, not promises

This repository is intentionally verifiable from source:

- The complete guided product flow is included in the public source and can be
  verified from the project documentation.
- Contract source, deployment guards, API security tests, arbitration tests,
  and browser-facing evidence receipts are included in the public tree.
- Submitted evidence and judge decisions receive SHA-256 receipts; the judge
  cannot directly change reputation or release funds.
- `.env`, wallet keys, provider tokens, deployment metadata, runtime databases,
  logs, and generated artifacts are excluded. Only empty or clearly synthetic
  configuration templates are public.
- The current boundary is stated plainly: this is a working, controlled MVP,
  not an audited custody system and not a claim of a live Arc deployment.

See [SECURITY.md](SECURITY.md), [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md), and
[docs/PRODUCTION_READINESS_AUDIT.md](docs/PRODUCTION_READINESS_AUDIT.md) for the
security assumptions and remaining production work.

## Documentation

The public README stays focused on the product and its trust model. Local
development, verification commands, demo data and deployment steps are kept in
the dedicated guides:

- [Site and local development guide](docs/SITE_GUIDE.md)
- [Hackathon submission checklist](docs/HACKATHON_SUBMISSION.md)
- [Arc testnet handoff](docs/ARC_TESTNET_DEPLOYMENT.md)

## Runtime hardening and real arbitration

The local product works without secrets. For a controlled deployment, set:

```powershell
PACT_DB_PATH=data/pact.sqlite
PACT_AUTH_TOKEN=replace-with-a-long-random-token
PACT_CORS_ORIGINS=https://your-frontend.example
PACT_ENABLE_DEMO_ENDPOINTS=false
ARBITRATOR_PROVIDER=council
OPENAI_API_KEY=...
ARBITRATOR_MODEL=gpt-5-mini
```

If `PACT_AUTH_TOKEN` is set, every mutating REST request must send `Authorization: Bearer <token>`. `VITE_API_TOKEN` is available only for a private controlled demo; a public production frontend should use server-side sessions or an identity provider instead of embedding a privileged token in browser code.

### Hosted verification

For a first server test, use the checked-in Docker profile in
[`deploy/README.md`](deploy/README.md). It runs the frontend and API behind one
origin, keeps the demo state in a persistent SQLite volume, and exposes the
platform Training Ground, Platform Points and leaderboard immediately. This is
intentionally a controlled demo profile; the PostgreSQL/Arc production path still
requires the external deployment and security steps listed below.

The judge council decides only a dispute verdict. It cannot directly assign an agent rank. The deterministic reputation engine computes rank from finalized outcomes and settled volume. A full three-way split becomes `NEEDS_HUMAN_REVIEW`; settlement, collateral, and reputation remain frozen until an authorized operator records a final decision. Provider outages still fail closed. Inspect this boundary at `GET /api/trust-model` and in [docs/TRUST_MODEL.md](docs/TRUST_MODEL.md).

## Repository map

```text
contracts/       Solidity registry, vault, mock USDC, compiler, local-chain tests
services/api/    Marketplace, reputation, streaming, disputes, WebSocket, simulator
shared/          Types shared by API and browser
frontend/        React/Vite control-room dashboard
training/        First-party trace export, QLoRA/SFT and policy evaluation
docs/            Architecture decisions and specification resolutions
```

The current design brief, resolved contradictions, and security boundaries are documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/PROJECT_IMPLEMENTATION_AND_RISK_REGISTER.md](docs/PROJECT_IMPLEMENTATION_AND_RISK_REGISTER.md).

For the final GitHub/hackathon package, deliverables, safe claims, demo script
and secret-handling rules, see [docs/HACKATHON_SUBMISSION.md](docs/HACKATHON_SUBMISSION.md).
The current Arc Testnet contract addresses and public receipts are listed in
[docs/ARC_TESTNET_DEPLOYMENT.md](docs/ARC_TESTNET_DEPLOYMENT.md).

The complete AI-agent operating contract — capability manifests, wallet limits,
eligibility tiers, lifecycle, evidence requirements and judge authority — is in
[docs/AGENT_PROTOCOL.md](docs/AGENT_PROTOCOL.md) and is also available as the
**Agent Protocol** screen in the running application.
The executable provider/tool/deliverable boundary is documented in
[docs/AGENT_RUNTIME.md](docs/AGENT_RUNTIME.md) and shown in **Agent Workbench**.

For a complete Russian-language explanation of every website screen, control,
role, status and end-to-end user flow, see
[docs/SITE_GUIDE.md](docs/SITE_GUIDE.md). The full documentation index is
[docs/README.md](docs/README.md).

## Arc and Circle testnet handoff

Copy `.env.example` to `.env`, keep `PACT_MODE=demo` for local work, and never commit secrets. The current Arc/Circle acceptance steps require user-owned credentials and faucet funds; the local demo never labels simulated actions as onchain transactions.

For a real testnet handoff:

1. Create and register a Circle entity secret, then run `npm run circle:wallet -w @pact/api` to create an `ARC-TESTNET` developer-controlled EOA wallet.
2. Fund it with testnet USDC/native gas and deploy the Registry and Vault.
3. Set the Vault as an authorized Registry writer and configure the dispute executor.
4. For an Agent Wallet, install Circle CLI globally, log in with OTP, then run `npm run circle:agent -w @pact/api -- create-testnet` and `... -- list-arc`.
5. Configure `GATEWAY_PRIVATE_KEY`, then run `npm run circle:gateway -w @pact/api -- balances`, `... -- deposit 1`, or `... -- pay <x402-url>`.
6. For one sponsored first SCA call, configure the `CIRCLE_PAYMASTER_*` allowlists and confirmed Console policy, then use `npm run circle:paymaster -w @pact/api -- create-wallet|create-task|post-collateral`.

Circle Agent Wallet spending policies are currently mainnet-only. The `circle:agent -- policy` command validates the limit ordering and refuses testnet chains before invoking Circle CLI.

Current official references:

- [Circle: create a dev-controlled wallet](https://developers.circle.com/wallets/dev-controlled/create-your-first-wallet)
- [Circle: entity secret management](https://developers.circle.com/wallets/dev-controlled/entity-secret-management)
- [Circle: Arc Testnet USDC address](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- [Circle: Agent Nanopayments](https://developers.circle.com/agent-stack/agent-nanopayments)
- [Circle CLI command reference](https://developers.circle.com/agent-stack/circle-cli/command-reference)

Arc Testnet USDC is `0x3600000000000000000000000000000000000000`; testnet assets have no monetary value.

## Product boundary

This is a verified local MVP, not a production custody system. SQLite, token auth, rate limiting, secure headers, a structured LLM adapter, and an operator-only split-decision review path are implemented; real funds still require end-user identity, secrets management, monitoring, an audited Arc adapter, and an external contract security review. `PROGRESS.md` separates completed code from acceptance criteria that require external accounts or deployment. Implementation boundaries and remaining risks are in [docs/PROJECT_IMPLEMENTATION_AND_RISK_REGISTER.md](docs/PROJECT_IMPLEMENTATION_AND_RISK_REGISTER.md).
