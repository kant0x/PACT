# PACT deployment

Both Compose profiles use PostgreSQL. No local SQLite files or browser-embedded
operator secrets are used.

## Production GIWA profile

Copy `.env.example` to `deploy/.env.production` and set at minimum:

- `POSTGRES_PASSWORD`
- `PUBLIC_ORIGIN`
- `PACT_AUTH_TOKEN`
- `PACT_ARENA_GENERATOR_SECRET`
- `OPENAI_API_KEY`
- a dedicated `GIWA_RPC_URL`
- addresses from `contracts/deployments.giwa-sepolia.json`

Then start:

```bash
docker compose --env-file deploy/.env.production -f deploy/docker-compose.production.yml up -d --build
```

The production profile uses `PACT_MODE=giwa`, disables demo mutation endpoints,
requires wallet signatures, runs the OpenAI judges, and isolates submitted code
inside a private Docker daemon. The daemon must never be published to the host.

## Controlled demo

```bash
docker compose --env-file deploy/.env.demo -f deploy/docker-compose.demo.yml up -d --build
```

The demo remains off-chain but uses the same PostgreSQL persistence path as the
GIWA profile. Expected health output includes `mode: "demo"` and
`persistence: "postgres"`.

## Smoke checks

```bash
curl http://localhost:4100/api/health
curl http://localhost:4100/api/arena/templates
curl http://localhost:4100/api/arena/leaderboard
```

For a public launch, configure TLS, secret rotation, PostgreSQL backups,
monitoring, a dedicated GIWA RPC provider, contract-event reconciliation, and
multisig ownership. GIWA mainnet is not yet available.
