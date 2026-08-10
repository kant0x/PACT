import type { PublicClient, WalletClient } from 'viem';
import {
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { ERC20_ABI } from './arc';
import {
  ARC_USDC_ADDRESS,
  requireAgentRegistryAddress,
  requireReputationRegistryAddress,
  requireVerificationRegistryAddress,
  requireHubRegistryAddress,
  requireMilestoneEscrowAddress,
  requireRewardVaultAddress,
  requireSubscriptionVaultAddress,
} from './runtime';

export const AGENT_REGISTRY_ABI = [
  { type: 'function', name: 'registerAgent', stateMutability: 'nonpayable', inputs: [{ name: 'profileHash', type: 'bytes32' }, { name: 'capabilitiesHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'updateAgentProfile', stateMutability: 'nonpayable', inputs: [{ name: 'profileHash', type: 'bytes32' }, { name: 'capabilitiesHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'setAgentActive', stateMutability: 'nonpayable', inputs: [{ name: 'active', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'isRegistered', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'getAgentProfile', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [{ name: 'profileHash', type: 'bytes32' }, { name: 'capabilitiesHash', type: 'bytes32' }, { name: 'registeredAt', type: 'uint64' }, { name: 'updatedAt', type: 'uint64' }, { name: 'active', type: 'bool' }] },
  { type: 'function', name: 'registerAgentWithCommitment', stateMutability: 'nonpayable', inputs: [{ name: 'profileHash', type: 'bytes32' }, { name: 'capabilitiesHash', type: 'bytes32' }, { name: 'documentHash', type: 'bytes32' }, { name: 'walletPolicyHash', type: 'bytes32' }, { name: 'runtimeHash', type: 'bytes32' }, { name: 'controller', type: 'address' }], outputs: [] },
  { type: 'function', name: 'commitAgentDocument', stateMutability: 'nonpayable', inputs: [{ name: 'documentHash', type: 'bytes32' }, { name: 'walletPolicyHash', type: 'bytes32' }, { name: 'runtimeHash', type: 'bytes32' }, { name: 'controller', type: 'address' }], outputs: [] },
  { type: 'function', name: 'recordActivity', stateMutability: 'nonpayable', inputs: [{ name: 'activityType', type: 'uint8' }, { name: 'detailsHash', type: 'bytes32' }], outputs: [] },
] as const;

export const REPUTATION_REGISTRY_ABI = [
  { type: 'function', name: 'importExternalAttestation', stateMutability: 'nonpayable', inputs: [
    { name: 'agent', type: 'address' },
    { name: 'proof', type: 'tuple', components: [
      { name: 'sourceDomain', type: 'uint32' },
      { name: 'externalScore', type: 'uint256' },
      { name: 'completedTasks', type: 'uint256' },
      { name: 'failedTasks', type: 'uint256' },
      { name: 'totalVolume', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ] },
  ], outputs: [] },
  { type: 'function', name: 'getPortableReputation', stateMutability: 'view', inputs: [{ name: 'agent', type: 'address' }], outputs: [
    { name: 'recognizedScore', type: 'uint256' }, { name: 'claimedScore', type: 'uint256' },
    { name: 'completedTasks', type: 'uint256' }, { name: 'failedTasks', type: 'uint256' },
    { name: 'totalVolume', type: 'uint256' }, { name: 'sourceDomain', type: 'uint32' },
    { name: 'nonce', type: 'uint256' }, { name: 'attestor', type: 'address' }, { name: 'importedAt', type: 'uint256' },
  ] },
] as const;

export const VERIFICATION_REGISTRY_ABI = [
  { type: 'function', name: 'verifyResult', stateMutability: 'nonpayable', inputs: [
    { name: 'vault', type: 'address' }, { name: 'taskId', type: 'uint256' },
    { name: 'reportHash', type: 'bytes32' }, { name: 'verdictHash', type: 'bytes32' },
    { name: 'evidenceHash', type: 'bytes32' }, { name: 'accepted', type: 'bool' },
  ], outputs: [] },
  { type: 'function', name: 'isAcceptedVerdict', stateMutability: 'view', inputs: [{ name: 'vault', type: 'address' }, { name: 'taskId', type: 'uint256' }, { name: 'verdictHash', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

export const HUB_REGISTRY_ABI = [
  { type: 'function', name: 'publishHubVersion', stateMutability: 'nonpayable', inputs: [{ name: 'hubId', type: 'bytes32' }, { name: 'rulesHash', type: 'bytes32' }, { name: 'limitsHash', type: 'bytes32' }, { name: 'taskSpecHash', type: 'bytes32' }, { name: 'active', type: 'bool' }], outputs: [{ name: 'version', type: 'uint256' }] },
  { type: 'function', name: 'setHubVersionActive', stateMutability: 'nonpayable', inputs: [{ name: 'hubId', type: 'bytes32' }, { name: 'version', type: 'uint256' }, { name: 'active', type: 'bool' }], outputs: [] },
] as const;

export const MILESTONE_ESCROW_ABI = [
  { type: 'function', name: 'createPlan', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'amounts', type: 'uint256[]' }], outputs: [{ name: 'planId', type: 'uint256' }] },
  { type: 'function', name: 'submitProof', stateMutability: 'nonpayable', inputs: [{ name: 'planId', type: 'uint256' }, { name: 'milestoneId', type: 'uint256' }, { name: 'proofHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'rejectProof', stateMutability: 'nonpayable', inputs: [{ name: 'planId', type: 'uint256' }, { name: 'milestoneId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'approveMilestone', stateMutability: 'nonpayable', inputs: [{ name: 'planId', type: 'uint256' }, { name: 'milestoneId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'claimMilestone', stateMutability: 'nonpayable', inputs: [{ name: 'planId', type: 'uint256' }, { name: 'milestoneId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancelPlan', stateMutability: 'nonpayable', inputs: [{ name: 'planId', type: 'uint256' }], outputs: [] },
] as const;

export const SUBSCRIPTION_VAULT_ABI = [
  { type: 'function', name: 'createSubscription', stateMutability: 'nonpayable', inputs: [{ name: 'agent', type: 'address' }, { name: 'periodAmount', type: 'uint256' }, { name: 'periodSeconds', type: 'uint64' }, { name: 'totalPeriods', type: 'uint32' }], outputs: [{ name: 'subscriptionId', type: 'uint256' }] },
  { type: 'function', name: 'claimPeriod', stateMutability: 'nonpayable', inputs: [{ name: 'subscriptionId', type: 'uint256' }, { name: 'proofHash', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'cancelSubscription', stateMutability: 'nonpayable', inputs: [{ name: 'subscriptionId', type: 'uint256' }], outputs: [] },
] as const;

export const REWARD_VAULT_ABI = [
  { type: 'function', name: 'claimReward', stateMutability: 'nonpayable', inputs: [{ name: 'rewardId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancelReward', stateMutability: 'nonpayable', inputs: [{ name: 'rewardId', type: 'uint256' }], outputs: [] },
] as const;

type ArcClients = { account: Address; publicClient: PublicClient; walletClient: WalletClient };

export function hashProtocolDocument(value: string | unknown): Hex {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  if (!payload) throw new Error('Protocol document cannot be empty.');
  return keccak256(stringToHex(payload));
}

async function writeAndWait(input: ArcClients & { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<Hash> {
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: input.address,
    abi: input.abi as never,
    functionName: input.functionName as never,
    args: input.args as never,
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${input.functionName} reverted on Arc Testnet.`);
  return hash;
}

async function approveIfNeeded(input: ArcClients, spender: Address, amount: bigint): Promise<void> {
  if (amount <= 0n) return;
  const allowance = await input.publicClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [input.account, spender],
  });
  if (allowance >= amount) return;
  await writeAndWait({ ...input, address: ARC_USDC_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] });
}

export async function registerAgentOnChain(input: ArcClients & { profile: string | unknown; capabilities: string | unknown }): Promise<Hash> {
  return writeAndWait({
    ...input,
    address: requireAgentRegistryAddress(),
    abi: AGENT_REGISTRY_ABI,
    functionName: 'registerAgent',
    args: [hashProtocolDocument(input.profile), hashProtocolDocument(input.capabilities)],
  });
}

export async function updateAgentProfileOnChain(input: ArcClients & { profile: string | unknown; capabilities: string | unknown }): Promise<Hash> {
  return writeAndWait({
    ...input,
    address: requireAgentRegistryAddress(),
    abi: AGENT_REGISTRY_ABI,
    functionName: 'updateAgentProfile',
    args: [hashProtocolDocument(input.profile), hashProtocolDocument(input.capabilities)],
  });
}

/** Anyone may relay a signed external attestation; the contract independently
 * checks that the signer is an owner-authorized verifier and that the nonce is fresh. */
export async function importExternalReputationAttestation(input: ArcClients & {
  agent: Address;
  proof: {
    sourceDomain: number;
    externalScore: bigint;
    completedTasks: bigint;
    failedTasks: bigint;
    totalVolume: bigint;
    nonce: bigint;
    deadline: bigint;
    signature: Hex;
  };
}): Promise<Hash> {
  return writeAndWait({
    ...input,
    address: requireReputationRegistryAddress(),
    abi: REPUTATION_REGISTRY_ABI,
    functionName: 'importExternalAttestation',
    args: [input.agent, input.proof],
  });
}

export async function verifyWorkOrderResult(input: ArcClients & {
  vault: Address;
  taskId: bigint;
  report: string | unknown;
  verdict: string | unknown;
  evidence: string | unknown;
  accepted: boolean;
}): Promise<Hash> {
  return writeAndWait({
    ...input,
    address: requireVerificationRegistryAddress(),
    abi: VERIFICATION_REGISTRY_ABI,
    functionName: 'verifyResult',
    args: [
      input.vault,
      input.taskId,
      hashProtocolDocument(input.report),
      hashProtocolDocument(input.verdict),
      hashProtocolDocument(input.evidence),
      input.accepted,
    ],
  });
}

export async function publishHubVersionOnChain(input: ArcClients & {
  hub: string | unknown;
  rules: string | unknown;
  limits: string | unknown;
  taskSpec: string | unknown;
  active: boolean;
}): Promise<Hash> {
  return writeAndWait({
    ...input,
    address: requireHubRegistryAddress(),
    abi: HUB_REGISTRY_ABI,
    functionName: 'publishHubVersion',
    args: [
      hashProtocolDocument(input.hub),
      hashProtocolDocument(input.rules),
      hashProtocolDocument(input.limits),
      hashProtocolDocument(input.taskSpec),
      input.active,
    ],
  });
}

export async function createMilestonePlan(input: ArcClients & { agent: Address; amountsUsdc: string[] }): Promise<Hash> {
  const address = requireMilestoneEscrowAddress();
  const amounts = input.amountsUsdc.map((amount) => parseUnits(amount, 6));
  const total = amounts.reduce((sum, amount) => sum + amount, 0n);
  if (!amounts.length || amounts.some((amount) => amount <= 0n)) throw new Error('Milestone amounts must be positive.');
  await approveIfNeeded(input, address, total);
  return writeAndWait({ ...input, address, abi: MILESTONE_ESCROW_ABI, functionName: 'createPlan', args: [input.agent, amounts] });
}

export async function submitMilestoneProof(input: ArcClients & { planId: bigint; milestoneId: bigint; proof: string | unknown }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireMilestoneEscrowAddress(), abi: MILESTONE_ESCROW_ABI, functionName: 'submitProof', args: [input.planId, input.milestoneId, hashProtocolDocument(input.proof)] });
}

export async function approveMilestone(input: ArcClients & { planId: bigint; milestoneId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireMilestoneEscrowAddress(), abi: MILESTONE_ESCROW_ABI, functionName: 'approveMilestone', args: [input.planId, input.milestoneId] });
}

export async function rejectMilestoneProof(input: ArcClients & { planId: bigint; milestoneId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireMilestoneEscrowAddress(), abi: MILESTONE_ESCROW_ABI, functionName: 'rejectProof', args: [input.planId, input.milestoneId] });
}

export async function claimMilestone(input: ArcClients & { planId: bigint; milestoneId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireMilestoneEscrowAddress(), abi: MILESTONE_ESCROW_ABI, functionName: 'claimMilestone', args: [input.planId, input.milestoneId] });
}

export async function cancelMilestonePlan(input: ArcClients & { planId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireMilestoneEscrowAddress(), abi: MILESTONE_ESCROW_ABI, functionName: 'cancelPlan', args: [input.planId] });
}

export async function createSubscription(input: ArcClients & { agent: Address; periodAmountUsdc: string; periodSeconds: number; totalPeriods: number }): Promise<Hash> {
  const address = requireSubscriptionVaultAddress();
  const amount = parseUnits(input.periodAmountUsdc, 6);
  if (amount <= 0n || !Number.isInteger(input.periodSeconds) || input.periodSeconds <= 0 || !Number.isInteger(input.totalPeriods) || input.totalPeriods <= 0) {
    throw new Error('Subscription terms are invalid.');
  }
  await approveIfNeeded(input, address, amount * BigInt(input.totalPeriods));
  return writeAndWait({ ...input, address, abi: SUBSCRIPTION_VAULT_ABI, functionName: 'createSubscription', args: [input.agent, amount, BigInt(input.periodSeconds), input.totalPeriods] });
}

export async function claimSubscriptionPeriod(input: ArcClients & { subscriptionId: bigint; proof: string | unknown }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireSubscriptionVaultAddress(), abi: SUBSCRIPTION_VAULT_ABI, functionName: 'claimPeriod', args: [input.subscriptionId, hashProtocolDocument(input.proof)] });
}

export async function cancelSubscription(input: ArcClients & { subscriptionId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireSubscriptionVaultAddress(), abi: SUBSCRIPTION_VAULT_ABI, functionName: 'cancelSubscription', args: [input.subscriptionId] });
}

export async function claimReward(input: ArcClients & { rewardId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireRewardVaultAddress(), abi: REWARD_VAULT_ABI, functionName: 'claimReward', args: [input.rewardId] });
}

export async function cancelReward(input: ArcClients & { rewardId: bigint }): Promise<Hash> {
  return writeAndWait({ ...input, address: requireRewardVaultAddress(), abi: REWARD_VAULT_ABI, functionName: 'cancelReward', args: [input.rewardId] });
}
