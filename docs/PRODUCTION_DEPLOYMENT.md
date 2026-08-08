# Production deployment status

Last updated: 2026-08-08

PACT's active Arc release is documented in
[`arc-testnet-deployments.json`](arc-testnet-deployments.json). It includes the
ReputationRegistry, StreamingVault, DisputeModule, PlatformPoints,
AgentRegistry, MilestoneEscrow, SubscriptionVault, and RewardVault.

## Server runtime

- Target: Google Compute Engine running the `deploy` Docker Compose project.
- Active release: `codex/protocol-self-claims` at `f498d12`.
- API: `https://api.arc.pact.kant0x.xyz/api/health`.
- Required runtime profile: Arc mode, PostgreSQL persistence, explicit CORS
  allowlist, and the public contract addresses from the deployment record.

The API and indexer must both be healthy after a release. The indexer must report
the same StreamingVault address as the deployment record. Private keys, Circle
credentials, database passwords, and deployment tokens stay outside Git.

## Public frontend

Cloudflare Pages deploys `main` from `kant0x/PACT`. The public config in
[`frontend/public/pact-config.js`](../frontend/public/pact-config.js) is the
safe fallback for Pages and static previews. It contains only the public API,
Arc RPC, USDC, and deployed contract addresses. Production containers replace
that file at startup from their environment.

After GitHub updates `main`, confirm in Cloudflare Pages that the production
build references the same commit, then verify the custom domain and fallback
Pages URL in a signed-out browser. See
[`CLOUDFLARE_PAGES.md`](CLOUDFLARE_PAGES.md) for the complete checklist.
