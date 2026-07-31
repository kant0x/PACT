# Arc Testnet production runbook

This runbook deploys PACT as a usable public Arc Testnet product. Testnet USDC
has no monetary value, but the application still treats wallet keys, evidence,
and database contents as production-sensitive data.

## 1. Deploy the current contracts

The current `StreamingVault` supports funded open orders, self-signed agent
claims, agent collateral, automatic stream activation, creator completion, and
separate dispute settlement. An older vault address must not be reused with
this frontend.

Required secret/configuration:

```text
ARC_RPC_URL=https://rpc.testnet.arc.network
EXPECTED_CHAIN_ID=5042002
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
DEPLOYER_PRIVATE_KEY=<deployment wallet>
DISPUTE_ADMIN_ADDRESS=<optional dedicated dispute multisig>
```

Run:

```bash
npm run deploy:testnet -w @pact/contracts
```

Record the deployment block and the generated addresses from
`contracts/deployments.json`. Verify that:

- `ReputationRegistry.authorizedWriters(vault)` is true;
- `DisputeModule.owner()` is the configured dispute admin;
- `DisputeModule.vault()` is the new StreamingVault;
- every address has non-empty bytecode on chain `5042002`.

## 2. Configure the durable services

Copy `deploy/.env.production.example` to an ignored
`deploy/.env.production`. Fill all required values. The operator key must be
kept in a secret manager and must never use a `VITE_*` name.

Required application values:

```text
PACT_AUTH_TOKEN=<random operator token>
PACT_SESSION_SECRET=<different random 32+ byte secret>
PACT_AUTH_DOMAIN=<public hostname>
PACT_STREAMING_VAULT_ADDRESS=<new vault>
PACT_DISPUTE_MODULE_ADDRESS=<new dispute module>
PACT_DISPUTE_ADMIN_PRIVATE_KEY=<dispute admin key>
CIRCLE_API_KEY=<Circle developer-controlled wallets API key>
CIRCLE_ENTITY_SECRET=<Circle entity secret stored only in the secret manager>
CIRCLE_WALLET_SET_ID=<optional existing PACT wallet set>
PACT_VAULT_DEPLOYMENT_BLOCK=<deployment block>
POSTGRES_PASSWORD=<random database password>
OPENAI_API_KEY=<judge/runtime key>
```

The production profile starts:

- PostgreSQL with persistent storage;
- the Arc-backed API;
- the finality-aware event indexer;
- the isolated arena runner and agent worker;
- the public web application.

```bash
docker compose \
  --env-file deploy/.env.production \
  -f deploy/docker-compose.production.yml \
  up --build -d
```

## 3. Readiness gates

These checks must all pass before publishing the URL:

```bash
curl -f https://<host>/api/health
curl -f https://<host>/api/health/ready
```

`/api/health/ready` must return HTTP 200 with:

- chain ID `5042002`;
- owned, configured, unpaused dispute module;
- PostgreSQL persistence.

The indexer `/ready` endpoint must report a recent finalized block and no error.

## 4. End-to-end acceptance test

Use a creator wallet containing Arc Testnet USDC. Create either an external
agent wallet or a Circle SCA agent, then fund the agent address for collateral.

1. Register the agent with a signed profile; for Circle mode confirm that a
   dedicated SCA address appears under the connected controller.
2. Creator publishes a small funded order.
3. Confirm the funding transaction in Arcscan and in the PACT dashboard.
4. Agent signs `claimOpenTask`, approves USDC and signs `postCollateral`.
5. Confirm the same collateral transaction atomically starts the stream.
6. Submit a deliverable and evidence packet as the assigned agent.
7. Accept it as the creator and verify final payment and collateral return.
8. Repeat with a dispute: confirm pause, verdict-only judging, and either resume
   (`NO_FAULT`) or DisputeModule settlement (`PARTIAL_FAULT`/`FULL_FAULT`).
9. Restart API and indexer; verify orders, runtime keys, receipts, and checkpoint
   state survive.

## 5. Public release evidence

Before judging, publish and test in a signed-out browser:

- public product URL;
- public repository URL containing the exact deployed source;
- Arcscan links for every current contract;
- API health and readiness URLs;
- presentation deck;
- 75–90 second demonstration video.

Do not label the existing hosted demo as the Arc-backed product until its health
endpoint reports `mode: "arc"`, `persistence: "postgres"`, and readiness is 200.
