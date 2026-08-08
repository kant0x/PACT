# PACT protocol architecture

This is the current source of truth for the Arc contract layer. Historical
deployment notes and the previous runtime guides live under `docs/archive/`.

## What is on-chain

| Contract | Responsibility | Who signs the important action |
| --- | --- | --- |
| `StreamingVault` | Funded work orders, collateral, streaming payout and final settlement | Client funds/completes; agent claims, posts collateral and submits result proof |
| `ReputationRegistry` | Commercial Trust Score, task outcomes and portable attestations | Authorized settlement writers; anyone can read |
| `AgentRegistry` | Agent-owned profile and capability document hashes | The agent wallet registers and updates itself |
| `MilestoneEscrow` | Pre-funded stage payments and proof hash history | Agent submits proof and claims; creator approves/rejects |
| `SubscriptionVault` | Pre-funded recurring allowance | Agent claims each due period with a proof hash; creator cancels future periods |
| `RewardVault` | Cash rewards separate from points | Authorized issuer funds; the agent wallet claims USDC |
| `PlatformPoints` | Non-transferable Training Ground points | Authorized scorer awards; points have no USDC value |
| `DisputeModule` | Applies one finalized 0/50/100% dispute decision | Protected dispute admin/multisig |

## Proof model

The browser/API never uploads private evidence to a contract. It computes a
`bytes32` hash over the deliverable packet and sends only that hash. The agent
wallet submits it through `StreamingVault.submitResultProof`,
`MilestoneEscrow.submitProof`, or `SubscriptionVault.claimPeriod`. The private
packet remains in PostgreSQL and can be checked against the on-chain hash.

`StreamingVault.completeTask` now requires a non-zero result proof. This keeps
the normal streaming path consistent with milestones and recurring jobs.

## Agent and score authority

The Circle SCA address is the agent identity. Provisioning an agent in Arc mode
also submits `AgentRegistry.registerAgent` from that SCA when the registry
address is configured. A controller may request a Circle transaction, but the
contract still checks `msg.sender` against the assigned agent. The API reads
Trust Score and outcome totals from `ReputationRegistry` when
`PACT_REPUTATION_REGISTRY_ADDRESS` is configured; PostgreSQL remains a cache for
display metadata and operational state.

## Circle self-claims

The production API route
`POST /api/agents/pg/:agentAddress/circle/actions` supports these additional
actions:

- `REGISTER_AGENT` / `UPDATE_AGENT_PROFILE` with `profileHash` and `capabilitiesHash`;
- `SUBMIT_RESULT_PROOF` with `taskId` and `proofHash`;
- `SUBMIT_MILESTONE_PROOF` and `CLAIM_MILESTONE` with `resourceId` and `milestoneId`;
- `CLAIM_SUBSCRIPTION` with `resourceId` and `proofHash`;
- `CLAIM_REWARD` with `resourceId`.

Claims are sent to the agent's Circle wallet address. The controller authorizes
the API request, but the agent wallet is the transaction sender.

## Deployment and configuration

Run the testnet deployment after setting the root `env.txt`:

```powershell
npm run deploy:testnet -w @pact/contracts
```

Copy all addresses from `contracts/deployments.json` into the API variables:

```text
PACT_REPUTATION_REGISTRY_ADDRESS=...
PACT_STREAMING_VAULT_ADDRESS=...
PACT_AGENT_REGISTRY_ADDRESS=...
PACT_MILESTONE_ESCROW_ADDRESS=...
PACT_SUBSCRIPTION_VAULT_ADDRESS=...
PACT_REWARD_VAULT_ADDRESS=...
```

For the browser, set the matching `VITE_*` values during development or the
`PACT_PUBLIC_*` values before `npm run build:pages`. Contract addresses are
public configuration; private keys and Circle credentials never belong in the
frontend.

The deployment recorded in `docs/arc-testnet-deployments.json` predates these
four new contracts. Do not point production at the new React actions until a
fresh deployment has been verified and its addresses copied into runtime
configuration.
