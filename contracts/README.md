# PACT contracts on GIWA

This workspace contains the complete PACT protocol contract suite for GIWA
Sepolia: settlement token, streaming escrow, dispute settlement, commercial
reputation, Training Ground points, and the GIWA agent receipt registry.

Amounts use ERC-20 base units. The included `MockUSDC` has six decimals and is
strictly a testnet asset; it is not real USDC.

```bash
npm install
npm run build
npm test
```

## GIWA Sepolia deployment

GIWA Sepolia uses chain ID `91342` and ETH for gas. The public RPC is
rate-limited, so production-like deployments should set a dedicated provider
URL.

Create `contracts/.env` locally:

```dotenv
GIWA_RPC_URL=https://sepolia-rpc.giwa.io
GIWA_DEPLOYER_PRIVATE_KEY=0x...
GIWA_OPERATOR_ADDRESS=0x...
PLATFORM_POINTS_AWARDER_ADDRESS=0x...
COLLATERAL_TIMEOUT_SECONDS=86400

# Optional. When empty, deployment creates test-only MockUSDC.
GIWA_SETTLEMENT_TOKEN_ADDRESS=
```

Fund the deployer with GIWA Sepolia test ETH, then run:

```bash
npm run deploy:giwa -w @pact/contracts
```

The script verifies chain ID and contract code, configures all cross-contract
permissions, and writes `contracts/deployments.giwa-sepolia.json`. Copy its
addresses into the API environment. Never commit private keys.

GIWA mainnet is not available yet. Before a real-value launch, replace the test
token with an audited settlement asset, use multisig ownership, obtain an
independent contract audit, and configure a production RPC provider.
