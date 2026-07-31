# PACT judging and submission checklist

Deadline: Sunday, 2 August 2026, 23:59 in the organizer's stated timezone. Submit the application before polishing optional materials.

## Public links

| Item | URL | Verified 2026-07-27 | Owner action |
| --- | --- | --- | --- |
| Live demo | https://arc.pact.kant0x.xyz/#overview | Custom domain configured; verify HTTPS and every judge path after the final GitHub deployment |
| Cloudflare fallback | https://pact-protocol.pages.dev | Public fallback URL | Keep available if custom-domain certificate provisioning is delayed |
| API health | https://pact-api-635470212898.europe-west1.run.app/api/health | Public HTTP 200; currently `mode: demo`, `persistence: memory` | Keep claims aligned with demo status or deploy the hardened Arc/PostgreSQL profile |
| Source repository | https://github.com/kant0x/PACT | Public HTTP 200 | Commit and push the untracked frontend and final docs |
| Arc deployment evidence | `docs/arc-testnet-deployments.json` | Chain ID 5042002; non-empty bytecode at all three addresses | Keep public and include the explorer links in the submission |
| Demo video | TBD | Not uploaded | Record from `docs/DEMO_SCRIPT.md`, upload, and test incognito |
| Presentation | TBD public share link | `docs/submission/PACT-judge-deck.pptx` is the canonical local deck | Upload this file and set "anyone with the link can view" |
| Hackathon application | Organizer portal | Not verifiable from this repository | Submit first; save confirmation and timestamp |

## Final repository gate

- [ ] `npm ci`
- [ ] `npm run check:submission`
- [ ] `frontend/` is tracked by Git.
- [ ] No `.env`, private key, wallet seed, database, log, generated evidence, or cloud credential is tracked.
- [ ] Root `README.md` contains the demo, API, Arcscan, and judging-document links.
- [ ] `docs/SITE_AND_PRODUCT.md` matches the language used by the website, video, and deck.
- [ ] Public deployment was rebuilt from the same commit linked in the application.
- [ ] GitHub default branch shows a green or otherwise successful verification run.

## Judge-path smoke test

- [ ] Open every submitted link in a signed-out/incognito window.
- [ ] Load the overview, protocol, public task market, agent registry, client workspace, and Training Ground.
- [ ] Expand every product-status FAQ item and verify the official external links.
- [ ] Switch EN → RU → ES → EN and verify the first DApp screen is not mixed-language.
- [ ] Confirm browser console has no errors on the overview and DApp entry screens.
- [ ] Confirm API health responds without authentication.
- [ ] Confirm every Arcscan address page loads and matches `docs/arc-testnet-deployments.json`.
- [ ] Play the full video with sound and captions enabled.
- [ ] Open the presentation in the shared viewer without requesting access.

## Claims that are safe today

- Working public demo with marketplace, agent registry, evidence/dispute flows, and Training Ground.
- Automated API and Solidity contract coverage.
- Reputation, arbitration, settlement, and Training Ground points are separate product layers.
- Public Arc Testnet contract deployments exist and are independently inspectable.
- Arc Testnet configuration matches the current official endpoint `https://rpc.testnet.arc.network`, chain ID `5042002`, and USDC gas token.

## Claims to avoid until the deployment changes

- “Production-ready,” “audited,” or “safe for real funds.”
- “The hosted demo is durable” while health reports in-memory persistence.
- “Every hosted UI action settles on Arc” unless the final deployment and transaction evidence prove that path end-to-end.
