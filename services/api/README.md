# PACT API

Local demo-mode backend for the PACT dashboard. It persists state in SQLite and does not require Arc or Circle credentials.

From the repository root:

```powershell
npm install
npm run dev -w @pact/api
```

The API listens on `http://localhost:4100`. Check it with `GET /api/health`. Reset and launch the comparison demo with:

```powershell
npm run demo:run
```

The command uses `PACT_API_URL` when set, otherwise `http://localhost:4100`. Tests and production build:

```powershell
npm test -w @pact/api
npm run build -w @pact/api
npm start -w @pact/api
```

The live stream socket is `ws://localhost:4100/api/streams/:taskId/live`. Trust roles and arbitration safeguards are exposed at `GET /api/trust-model`.

## Split-decision human review

In council mode a valid 1/1/1 split is stored as `NEEDS_HUMAN_REVIEW`. It does not
change collateral, outcome, or reputation. With `PACT_AUTH_TOKEN` configured, an
authorized operator can finalize it once:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://localhost:4100/api/disputes/<id>/human-review `
  -Headers @{ Authorization = "Bearer $env:PACT_AUTH_TOKEN" } `
  -ContentType application/json `
  -Body '{"verdict":"PARTIAL_FAULT","reasoning":"Reviewed council split against signed evidence."}'
```

`PACT_HUMAN_REVIEWER_ID` identifies the reviewer in the receipt and is read only
from server configuration. The client cannot choose or override it. A second
finalization attempt returns `409 DISPUTE_ALREADY_FINALIZED`.

## Circle Gas Station / Paymaster

Circle Gas Station sponsors gas automatically for an ERC-4337 SCA wallet when its Console policy matches the transaction. PACT adds a fail-closed guard because Circle's maximum-spend policy does not apply to the first SCA transaction. The guard allows exactly one first outbound call per allowlisted wallet, only on `ARC-TESTNET`, only to the deployed `StreamingVault`, and only for `createTask` or `postCollateral` within the configured USDC cap.

Create an SCA wallet:

```powershell
npm run circle:paymaster -w @pact/api -- create-wallet
```

Then configure the Circle Console Gas Station policy and set all `CIRCLE_PAYMASTER_*` values from `.env.example`. `CIRCLE_PAYMASTER_ALLOWED_WALLET_IDS` accepts comma-separated Circle wallet UUIDs; `CIRCLE_PAYMASTER_ALLOWED_CONTRACTS` accepts comma-separated EVM addresses. Both `CIRCLE_PAYMASTER_ENABLED=true` and `CIRCLE_GAS_STATION_POLICY_CONFIRMED=true` are required. Missing credentials, policy confirmation, allowlists, or addresses stop execution before Circle is called.

Sponsor the wallet's first task operation:

```powershell
npm run circle:paymaster -w @pact/api -- create-task `
  --wallet-id <circle-wallet-uuid> `
  --agent <agent-address> `
  --amount-usdc 25 `
  --collateral-pct 25

npm run circle:paymaster -w @pact/api -- post-collateral `
  --wallet-id <circle-wallet-uuid> `
  --task-id 1 `
  --amount-usdc 5
```

The local SQLite ledger atomically reserves sponsorship before submission, so concurrent calls cannot consume it twice. A Circle error keeps the slot blocked as `FAILED_CLOSED`; use the printed/stored idempotency key to reconcile the request with Circle before any manual retry. `amount-usdc` on `post-collateral` is a local policy declaration and must be obtained from the onchain task immediately before execution; the contract remains the final authority for the actual collateral amount.
