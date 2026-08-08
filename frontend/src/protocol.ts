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
