# PACT GIWA registry

This Hardhat workspace provides focused development, deployment and verification
for `PACTGiwaRegistry` on GIWA Sepolia. The complete settlement suite is deployed
from the root `@pact/contracts` workspace.

| Setting | Value |
| --- | --- |
| Network | GIWA Sepolia |
| Chain ID | `91342` |
| RPC | `https://sepolia-rpc.giwa.io` |
| Explorer | `https://sepolia-explorer.giwa.io` |
| Gas currency | Test ETH |

```powershell
npm install
Copy-Item .env.example .env
npm run compile
npm test
npm run deploy:giwa
```

Set `GIWA_DEPLOYER_PRIVATE_KEY` only in the untracked `.env`. The public RPC is
rate-limited; set `GIWA_SEPOLIA_RPC_URL` to a dedicated provider for continuous
operation. Verify the deployed address with:

```powershell
npm run verify:giwa -- 0xCONTRACT_ADDRESS 0xDEPLOYER_ADDRESS
```
