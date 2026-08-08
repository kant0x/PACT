# Cloudflare Pages deployment

PACT's public frontend is deployed from this monorepo to the Cloudflare Pages
project `pact-protocol`.

## GitHub connection

- Repository: `kant0x/PACT`
- Production branch: `main`
- Root directory: `/`
- Build command: `npm run build -w @pact/frontend`
- Build output directory: `frontend/dist`
- Node.js version: `22`

Cloudflare Pages should deploy preview builds for pull requests and production
builds only from `main`. The GitHub Actions workflow independently runs the
full repository verification suite.

## Public frontend variables

Configure these in **Workers & Pages → pact-protocol → Settings → Variables and
Secrets**. These values are public at build time; never place private keys,
operator tokens, Circle secrets, database credentials, or OpenAI keys in a
`VITE_*` variable.

```text
NODE_VERSION=22
VITE_API_URL=https://pact-api-635470212898.europe-west1.run.app
VITE_ARC_RPC_URL=https://rpc.testnet.arc.network
VITE_STREAMING_VAULT_ADDRESS=0x...
VITE_AGENT_REGISTRY_ADDRESS=0x...
VITE_MILESTONE_ESCROW_ADDRESS=0x...
VITE_SUBSCRIPTION_VAULT_ADDRESS=0x...
VITE_REWARD_VAULT_ADDRESS=0x...
VITE_USDC_ADDRESS=0x3600000000000000000000000000000000000000
```

These values are public at build time. The API must already be running in its
Arc/PostgreSQL profile, with the verified StreamingVault address above.

## Custom domain

The public domain is `arc.pact.kant0x.xyz`. DNS remains at Porkbun.

Porkbun record:

| Type | Host | Target | TTL |
| --- | --- | --- | --- |
| CNAME | `arc.pact` | `pact-protocol.pages.dev` | `600` |

The same hostname must be registered under **Workers & Pages → pact-protocol →
Custom domains**. Wait for the status to become **Active** before testing HTTPS.
Do not add `https://` or a trailing slash to the CNAME target.

## Local release verification

```bash
npm ci
npm run check:submission
```

After the GitHub push and Cloudflare deployment:

1. Confirm the GitHub Actions workflow succeeds.
2. Confirm the Cloudflare production deployment references the same commit.
3. Open `https://arc.pact.kant0x.xyz/#overview` in a signed-out browser.
4. Verify Overview, How it works, Tasks, Agent registry, and Cabinet.
5. Verify `https://pact-protocol.pages.dev` remains available as a fallback.
6. Confirm the browser console has no errors and API health is publicly readable.

## Manual fallback

If Git integration is unavailable, build and deploy the same output directory:

```bash
npm ci
npm run build -w @pact/frontend
npx wrangler pages deploy frontend/dist --project-name pact-protocol
```
