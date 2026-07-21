# PACT hackathon submission package

This document is the release checklist for the public repository and the
hackathon form. It keeps the code submission separate from private deployment
credentials and from the presentation artifacts.

## Submit to the hackathon

1. **Public GitHub repository:** this repository at the final commit shown by
   `git log -1 --oneline`.
2. **Live MVP URL:** the hosted frontend and API. The checked-in Docker profile
   is a controlled demo; an Arc deployment and verified contract addresses must
   be added before calling it live on Arc.
3. **Three-minute video:** show the creator flow, an agent registration/API
   onboarding path, a funded task claim, evidence submission, acceptance, and a
   dispute that stops settlement until review.
4. **Pitch deck:** use `outputs/pact-presentation-final-v4.pptx` locally and upload
   it separately to the hackathon form or a view-only drive link. `outputs/` is
   intentionally ignored by Git so binary drafts are not mixed into the code
   repository.
5. **Project description:** use `docs/HACKATHON_PITCH.md` as the source of truth.
   Use `docs/PRESENTATION_FACT_CHECK.md` when recording the video or answering
   judge questions.

## What the public repository contains

- React/Vite frontend with Overview, DApp dashboard, tasks, agent registry,
  workbench, Training Ground and private disputes flow.
- API with demo persistence, work-order lifecycle, evidence receipts,
  reputation, streaming settlement, leaderboard and WebSocket updates.
- Solidity `ReputationRegistry` and `StreamingVault`, local compiler and
  contract tests.
- Deterministic arbitration for the demo plus adapter boundaries for OpenAI
  and the three-role council.
- Docker Compose profile for a controlled hosted demo.
- Agent API/runtime protocol, judge-security boundaries and production risk
  register.

## Claims that are safe for the submission

- `StreamingVault` is the task-level collateral and escrow mechanism.
- Circle Spending Policy is an additional wallet-wide, mainnet-only limit; it
  does not lock task collateral.
- Judge output is only `NO_FAULT`, `PARTIAL_FAULT` or `FULL_FAULT`.
- Settlement applies the slash policy; Trust Score updates only after accepted
  work or a finalized dispute.
- A 1/1/1 council split becomes `NEEDS_HUMAN_REVIEW`.
- Training Ground attempts are source-backed, daily, and award Platform Points;
  they do not change commercial Trust Score or lock USDC.
- OpenClaw and Circle are external/adapter-ready integrations until their
  credentials, runtime and deployment are configured.

Do not describe the current demo as already live on Arc, do not call the council
a random Kleros-style jury, and do not claim that a judge directly changes Trust
Score.

## Reproducible pre-upload check

From the repository root with Node.js 22+:

```powershell
npm ci
npm run check
git diff --check
git status --short
```

The expected result is a clean working tree and successful locale, build and
test checks. The API tests and contract tests must pass before publishing the
repository.

## Secrets policy

- Never commit `.env`, `contracts/.env`, `deploy/.env.demo`, private keys,
  Circle entity secrets, OpenAI keys, or bearer tokens.
- Only `.env.example` and `deploy/.env.demo.example` are public templates.
- `contracts/.env` is ignored and is used only by the operator who performs a
  deployment.
- The deterministic local demo needs no wallet, OpenAI or Circle secret.
- A public browser build must not embed a privileged mutation token; use scoped
  sessions or wallet-signature auth for a real launch.

## Hosted demo handoff

On the server, copy `deploy/.env.demo.example` to `deploy/.env.demo`, replace
the placeholders with server-only values, and run:

```bash
docker compose --env-file deploy/.env.demo \
  -f deploy/docker-compose.demo.yml up -d --build
```

Before an Arc contract deployment, configure the public USDC and dispute-module
addresses in `contracts/.env`. The deploy script fails closed when a required
address is missing and writes deployment metadata only to the ignored
`contracts/deployments.json` file.

