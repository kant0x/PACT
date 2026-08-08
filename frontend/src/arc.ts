import type { PublicClient, WalletClient } from 'viem';
import { parseUnits } from 'viem';
import { ARC_USDC_ADDRESS, requireStreamingVaultAddress } from './runtime';

export const ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const STREAMING_VAULT_ABI = [
  {
    type: 'function',
    name: 'createOpenTask',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'totalAmount', type: 'uint256' },
      { name: 'ratePerSecond', type: 'uint256' },
      { name: 'preferredAgent', type: 'address' },
    ],
    outputs: [{ name: 'taskId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'claimOpenTask',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'postCollateral',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'pauseForDispute',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'completeTask',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'cancelOpenTask',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'withdrawStreamed',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'taskId', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'submitResultProof',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'taskId', type: 'uint256' },
      { name: 'proofHash', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

interface FundOpenOrderInput {
  account: `0x${string}`;
  amountUsdc: string;
  estimatedDurationSeconds: number;
  preferredAgentAddress?: `0x${string}` | null;
  publicClient: PublicClient;
  walletClient: WalletClient;
  onProgress?: (message: string) => void;
}

export async function fundOpenOrder(input: FundOpenOrderInput): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  const amount = parseUnits(input.amountUsdc, 6);
  if (amount <= 0n) throw new Error('Task budget must be greater than zero.');
  if (!Number.isInteger(input.estimatedDurationSeconds) || input.estimatedDurationSeconds <= 0) {
    throw new Error('Task duration must be a positive whole number of seconds.');
  }
  const duration = BigInt(input.estimatedDurationSeconds);
  const ratePerSecond = (amount + duration - 1n) / duration;

  input.onProgress?.('Checking USDC approval…');
  const allowance = await input.publicClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [input.account, vaultAddress],
  });

  if (allowance < amount) {
    input.onProgress?.('Approve testnet USDC in your wallet…');
    const approvalHash = await input.walletClient.writeContract({
      account: input.account,
      chain: input.publicClient.chain,
      address: ARC_USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [vaultAddress, amount],
    });
    const approvalReceipt = await input.publicClient.waitForTransactionReceipt({ hash: approvalHash });
    if (approvalReceipt.status !== 'success') throw new Error('USDC approval reverted on Arc Testnet.');
  }

  input.onProgress?.('Fund the work order in StreamingVault…');
  const fundingHash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'createOpenTask',
    args: [amount, ratePerSecond, input.preferredAgentAddress ?? '0x0000000000000000000000000000000000000000'],
  });
  const fundingReceipt = await input.publicClient.waitForTransactionReceipt({ hash: fundingHash });
  if (fundingReceipt.status !== 'success') throw new Error('Work-order funding reverted on Arc Testnet.');
  input.onProgress?.('Funding confirmed. Publishing the signed work order…');
  return fundingHash;
}

export async function fundAgentWallet(input: {
  account: `0x${string}`;
  agentAddress: `0x${string}`;
  amountUsdc: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  onProgress?: (message: string) => void;
}): Promise<`0x${string}`> {
  const amount = parseUnits(input.amountUsdc, 6);
  if (amount <= 0n) throw new Error('Agent funding amount must be greater than zero.');
  input.onProgress?.('Sending USDC to the Circle agent wallet…');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: ARC_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [input.agentAddress, amount],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('USDC transfer to the Circle agent wallet reverted on Arc Testnet.');
  input.onProgress?.('Agent wallet funding confirmed on Arc Testnet.');
  return hash;
}

export async function claimArcTask(input: {
  account: `0x${string}`;
  chainTaskId: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
}): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'claimOpenTask',
    args: [BigInt(input.chainTaskId)],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Agent claim reverted on Arc Testnet.');
  return hash;
}

interface LockCollateralInput {
  account: `0x${string}`;
  chainTaskId: string;
  collateralUsdc: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  onProgress?: (message: string) => void;
}

export async function lockAgentCollateral(input: LockCollateralInput): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  const amount = parseUnits(input.collateralUsdc, 6);

  if (amount > 0n) {
    input.onProgress?.('Checking collateral approval…');
    const allowance = await input.publicClient.readContract({
      address: ARC_USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [input.account, vaultAddress],
    });
    if (allowance < amount) {
      input.onProgress?.('Approve collateral USDC in your wallet…');
      const approvalHash = await input.walletClient.writeContract({
        account: input.account,
        chain: input.publicClient.chain,
        address: ARC_USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [vaultAddress, amount],
      });
      const approvalReceipt = await input.publicClient.waitForTransactionReceipt({ hash: approvalHash });
      if (approvalReceipt.status !== 'success') throw new Error('Collateral approval reverted on Arc Testnet.');
    }
  }

  input.onProgress?.('Lock collateral and activate the assignment…');
  const collateralHash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'postCollateral',
    args: [BigInt(input.chainTaskId)],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash: collateralHash });
  if (receipt.status !== 'success') throw new Error('Collateral transaction reverted on Arc Testnet.');
  return collateralHash;
}

export async function completeArcTask(input: {
  account: `0x${string}`;
  chainTaskId: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
}): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'completeTask',
    args: [BigInt(input.chainTaskId)],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Completion transaction reverted on Arc Testnet.');
  return hash;
}

export async function cancelArcTask(input: {
  account: `0x${string}`;
  chainTaskId: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
}): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'cancelOpenTask',
    args: [BigInt(input.chainTaskId)],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Cancellation transaction reverted on Arc Testnet.');
  return hash;
}

export async function withdrawArcStream(input: {
  account: `0x${string}`;
  chainTaskId: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
}): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'withdrawStreamed',
    args: [BigInt(input.chainTaskId)],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Stream withdrawal reverted on Arc Testnet.');
  return hash;
}

export async function submitResultProof(input: {
  account: `0x${string}`;
  chainTaskId: string;
  proofHash: `0x${string}`;
  publicClient: PublicClient;
  walletClient: WalletClient;
}): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.proofHash)) throw new Error('The deliverable proof hash is invalid.');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'submitResultProof',
    args: [BigInt(input.chainTaskId), input.proofHash],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Result proof submission reverted on Arc Testnet.');
  return hash;
}

export async function pauseArcTaskForDispute(input: {
  account: `0x${string}`;
  chainTaskId: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
}): Promise<`0x${string}`> {
  const vaultAddress = requireStreamingVaultAddress();
  if (!/^[1-9][0-9]*$/.test(input.chainTaskId)) throw new Error('The work order has no valid Arc task ID.');
  const hash = await input.walletClient.writeContract({
    account: input.account,
    chain: input.publicClient.chain,
    address: vaultAddress,
    abi: STREAMING_VAULT_ABI,
    functionName: 'pauseForDispute',
    args: [BigInt(input.chainTaskId)],
  });
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('Dispute pause reverted on Arc Testnet.');
  return hash;
}
