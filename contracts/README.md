# PACT contracts

Standalone Solidity workspace for the Provable Agent Contract & Trust MVP.

The on-chain protocol is split by responsibility:

- `StreamingVault` holds normal funded work orders, collateral and streams.
- `ReputationRegistry` is the canonical commercial Trust Score and outcome history.
- `AgentRegistry` lets an agent wallet self-register profile/capability hashes.
- `MilestoneEscrow` releases approved milestone payments after an agent submits a proof hash.
- `SubscriptionVault` holds a pre-funded recurring allowance that an agent claims per period.
- `RewardVault` holds USDC rewards that only the agent wallet can claim; it is separate from non-cash `PlatformPoints`.
- `DisputeModule` applies a finalized dispute decision to `StreamingVault`.

Documents, prompts, deliverables and private evidence remain off-chain. Only their
hashes, payment state, scores and final receipts belong on-chain.

Amounts are ERC-20 base units. `MockUSDC` uses six decimals, like USDC. A task
creator approves and deposits the full payment in `createTask`; the assigned
agent separately approves and posts the calculated collateral.

```bash
npm install
npm run build
npm test
```

## Arc Testnet deployment

The deployment script creates the PACT-controlled `DisputeModule` (unless an
external module address is explicitly supplied), then `ReputationRegistry` and
`StreamingVault` with the live Arc Testnet USDC address and a collateral timeout.
It authorizes the vault as a registry writer and writes the resulting addresses
and transaction hashes to `deployments.json`.

Create the ignored `env.txt` file in the repository root (`E:\py_scrypt\PACT\env.txt`).
Fill it only on the deployment machine and never commit or paste its secrets:

```bash
ARC_RPC_URL=https://rpc.testnet.arc.network
EXPECTED_CHAIN_ID=5042002
DEPLOYER_PRIVATE_KEY=0x...
ARC_USDC_ADDRESS=0x3600000000000000000000000000000000000000
# Optional: use an already deployed compatible module. If empty, the script
# deploys PACT's controlled testnet DisputeModule automatically.
DISPUTE_MODULE_ADDRESS=
COLLATERAL_TIMEOUT_SECONDS=86400
# Optional owner that can apply finalized DisputeModule verdicts. This address
# cannot claim work or control the normal StreamingVault lifecycle.
DISPUTE_ADMIN_ADDRESS=0x...
# Optional: separate awarder for the non-transferable Training Ground points.
PLATFORM_POINTS_AWARDER_ADDRESS=0x...
```

Then run:

```bash
npm run deploy:testnet -w @pact/contracts
```

The script loads the root `env.txt` automatically and keeps `contracts/.env` as
a backwards-compatible fallback. To use another file, set
`PACT_ENV_FILE=/absolute/path/to/file` before running the command.

The script stops before deployment when the chain ID, required addresses or
USDC contract code do not match. Clients fund and approve settlement with their
own wallets; agents claim, post collateral and withdraw with their own wallets.
The PACT-controlled dispute module is separate: the off-chain Judge decides the
verdict, while its admin applies the final slash policy once and cannot control
normal task lifecycle calls. For real funds, move this role to a multisig.
After deployment, copy the recorded `ReputationRegistry` and
`StreamingVault` addresses into the API's Arc environment and verify the
transaction receipts before enabling real-money routes.

`StreamingVault` must be added to `ReputationRegistry` as an authorized writer
after deployment. Its constructor also receives the trusted dispute-module
address and the collateral-posting timeout in seconds.

The deployment also creates `PlatformPoints`, a non-transferable Arc Testnet
ledger for Training Ground rewards. It has no USDC value and is separate from
commercial Trust Score. The deployment wallet (or
`PLATFORM_POINTS_AWARDER_ADDRESS`) is allowlisted as the scorer. Copy the
recorded `contracts.PlatformPoints` address into the API environment as
`PLATFORM_POINTS_ADDRESS`, and use the scorer key as
`PLATFORM_POINTS_AWARDER_PRIVATE_KEY`.

If the Vault, Registry and DisputeModule are already deployed, deploy only the
points ledger without replacing those contracts:

```powershell
npm run deploy:points:testnet -w @pact/contracts
```

The Registry also supports third-party protocol writers, public paginated outcome
history, and EIP-712 external attestations from owner-approved attestors. Task IDs
are namespaced by writer, so two protocols may safely use the same numeric ID.

Agents must submit milestone, subscription and reward claims from their own wallet
address. A Circle Smart Contract Account is just such an address: the API can
submit the call through Circle, but the contract still checks that the sender is
the assigned agent.

Before the agent posts collateral, up to 16 independent underwriters may fund the
shortfall with `underwriteCollateral`. They receive principal plus a proportional
share of the 2% stream fee on success, receive a timeout refund, and share slashing
losses proportionally.
