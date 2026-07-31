# PACT API for GIWA

The API supports an in-memory local demo and a production GIWA profile backed
by PostgreSQL. SQLite is not used.

```powershell
npm install
npm run dev -w @pact/api
```

The API listens on `http://localhost:4100`; readiness is available at
`GET /api/health`. Build and test with:

```powershell
npm run build -w @pact/api
npm test -w @pact/api
```

## PostgreSQL

Set `DATABASE_URL` (or `PACT_DATABASE_URL`) to enable durable state. In its
absence, the API intentionally uses memory and reports `persistence: "memory"`.
Docker Compose supplies PostgreSQL automatically.

## GIWA Sepolia

Set `PACT_MODE=giwa`, `GIWA_CHAIN_ID=91342`, a production-grade `GIWA_RPC_URL`,
and the addresses emitted by `npm run deploy:giwa -w @pact/contracts`.
Training Ground points additionally require `PLATFORM_POINTS_ADDRESS` and the
private key of an authorized awarder. The key must stay server-side.

GIWA agents provide their own EVM wallet and prove ownership with an EIP-191
signature. Automatic third-party wallet provisioning and gas sponsorship are
not enabled because no supported GIWA provider is bundled.

Optional x402 metering requires both `X402_SELLER_ADDRESS` and an explicitly
configured `X402_FACILITATOR_URL`; there is no implicit facilitator fallback.
