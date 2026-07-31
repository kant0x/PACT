import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEventLogs,
  parseUnits,
  publicActions,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export const STREAMING_VAULT_ABI = parseAbi([
  'event TaskCreated(uint256 indexed taskId, address indexed creator, address indexed agent, uint256 totalAmount, uint256 requiredCollateral, uint256 collateralDeadline)',
  'event TaskAssigned(uint256 indexed taskId, address indexed agent, uint256 requiredCollateral, uint256 collateralDeadline)',
  'event CollateralPosted(uint256 indexed taskId, address indexed agent, uint256 amount)',
  'event StreamPaused(uint256 indexed taskId, uint256 accruedAmount, uint256 timestamp)',
  'event TaskCompleted(uint256 indexed taskId, uint256 paidToAgent, uint256 collateralReturned)',
  'event TaskCancelled(uint256 indexed taskId, uint256 refundedToCreator)',
  'function tasks(uint256 taskId) view returns (address creator, address agent, uint256 totalAmount, uint256 requiredCollateral, uint256 collateralLocked, uint256 ratePerSecond, uint256 accruedAmount, uint256 withdrawnAmount, uint64 collateralDeadline, uint64 lastAccrualTimestamp, uint8 status, uint256 agentCollateral, uint256 totalUnderwritten, uint256 agentPayoutPaid)',
  'function preferredAgents(uint256 taskId) view returns (address)',
  'function claimOpenTask(uint256 taskId)',
  'function pauseForDispute(uint256 taskId)',
]);

const DISPUTE_MODULE_ABI = parseAbi([
  'function owner() view returns (address)',
  'function vault() view returns (address)',
  'function paused() view returns (bool)',
  'function settle(uint256 taskId, uint256 slashPct, bytes32 decisionHash)',
]);

const arcTestnet = {
  id: 5_042_002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.arc.network'] },
  },
} as const;

export interface VerifiedFunding {
  chainTaskId: string;
  transactionHash: Hash;
  blockNumber: string;
}

export interface ArcSettlementGateway {
  verifyOpenTaskFunding(input: {
    creatorAddress: string;
    totalAmount: string;
    ratePerSecond: string;
    preferredAgentAddress?: string | null;
    transactionHash: string;
  }): Promise<VerifiedFunding>;
  verifyAgentClaimed(input: {
    chainTaskId: string;
    agentAddress: string;
    transactionHash: string;
  }): Promise<Hash>;
  verifyCollateralPosted(input: {
    chainTaskId: string;
    agentAddress: string;
    transactionHash: string;
  }): Promise<Hash>;
  verifyTaskCompleted(input: {
    chainTaskId: string;
    creatorAddress: string;
    transactionHash: string;
  }): Promise<Hash>;
  verifyTaskCancelled(input: {
    chainTaskId: string;
    creatorAddress: string;
    transactionHash: string;
  }): Promise<Hash>;
  verifyTaskPaused(input: {
    chainTaskId: string;
    participantAddress: string;
    transactionHash: string;
  }): Promise<Hash>;
  settleDispute(chainTaskId: string, slashPct: number, decisionHash: string): Promise<Hash>;
  readiness(): Promise<{
    chainId: number;
    vaultAddress: Address;
    settlementSignerAddress: Address;
    disputeModuleAddress: Address;
    disputeModuleOwned: boolean;
    disputeModuleConfigured: boolean;
    disputeModulePaused: boolean;
  }>;
}

export class ArcSettlementError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArcSettlementError';
  }
}

export class ViemArcSettlementGateway implements ArcSettlementGateway {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(
    private readonly vaultAddress: Address,
    private readonly disputeModuleAddress: Address,
    rpcUrl: string,
    operatorPrivateKey: Hex,
  ) {
    this.account = privateKeyToAccount(operatorPrivateKey);
    const chain = {
      ...arcTestnet,
      rpcUrls: { default: { http: [rpcUrl] } },
    };
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain,
      transport: http(rpcUrl),
    }).extend(publicActions);
  }

  async verifyOpenTaskFunding(input: {
    creatorAddress: string;
    totalAmount: string;
    ratePerSecond: string;
    preferredAgentAddress?: string | null;
    transactionHash: string;
  }): Promise<VerifiedFunding> {
    if (!isAddress(input.creatorAddress)) {
      throw new ArcSettlementError('INVALID_CREATOR', 'Creator address is not a valid EVM address');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash)) {
      throw new ArcSettlementError('INVALID_FUNDING_TX', 'Funding transaction hash is invalid');
    }

    const creator = getAddress(input.creatorAddress);
    if (input.preferredAgentAddress && !isAddress(input.preferredAgentAddress)) {
      throw new ArcSettlementError('INVALID_PREFERRED_AGENT', 'Preferred agent address is not a valid EVM address');
    }
    const expectedPreferredAgent = input.preferredAgentAddress
      ? getAddress(input.preferredAgentAddress)
      : ZERO_ADDRESS;
    const transactionHash = input.transactionHash as Hash;
    const [receipt, transaction] = await Promise.all([
      this.publicClient.getTransactionReceipt({ hash: transactionHash }),
      this.publicClient.getTransaction({ hash: transactionHash }),
    ]);
    if (receipt.status !== 'success') {
      throw new ArcSettlementError('FUNDING_TX_REVERTED', 'Funding transaction reverted on Arc Testnet');
    }
    if (!transaction.to || getAddress(transaction.to) !== this.vaultAddress) {
      throw new ArcSettlementError('WRONG_FUNDING_CONTRACT', 'Funding transaction does not target the configured StreamingVault');
    }
    if (getAddress(transaction.from) !== creator) {
      throw new ArcSettlementError('FUNDING_CREATOR_MISMATCH', 'Funding transaction was not sent by the work-order creator');
    }

    const expectedAmount = parseUnits(input.totalAmount, 6);
    const expectedRate = parseUnits(input.ratePerSecond, 6);
    const events = parseEventLogs({
      abi: STREAMING_VAULT_ABI,
      eventName: 'TaskCreated',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.vaultAddress),
      strict: true,
    });
    const funded = events.find((event) => (
      getAddress(event.args.creator) === creator
      && getAddress(event.args.agent) === ZERO_ADDRESS
      && event.args.totalAmount === expectedAmount
      && event.args.collateralDeadline === 0n
    ));
    if (!funded) {
      throw new ArcSettlementError(
        'FUNDING_EVENT_MISMATCH',
        'Transaction does not contain the expected funded open work order',
      );
    }

    const [task, preferredAgent] = await Promise.all([
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: STREAMING_VAULT_ABI,
        functionName: 'tasks',
        args: [funded.args.taskId],
      }),
      this.publicClient.readContract({
        address: this.vaultAddress,
        abi: STREAMING_VAULT_ABI,
        functionName: 'preferredAgents',
        args: [funded.args.taskId],
      }),
    ]);
    if (
      getAddress(task[0]) !== creator
      || getAddress(task[1]) !== ZERO_ADDRESS
      || task[2] !== expectedAmount
      || task[5] !== expectedRate
      || task[10] !== 1
      || getAddress(preferredAgent) !== expectedPreferredAgent
    ) {
      throw new ArcSettlementError('FUNDING_STATE_MISMATCH', 'StreamingVault state does not match the funding receipt');
    }

    return {
      chainTaskId: funded.args.taskId.toString(),
      transactionHash,
      blockNumber: receipt.blockNumber.toString(),
    };
  }

  async verifyAgentClaimed(input: {
    chainTaskId: string;
    agentAddress: string;
    transactionHash: string;
  }): Promise<Hash> {
    const taskId = parseChainTaskId(input.chainTaskId);
    if (!isAddress(input.agentAddress)) {
      throw new ArcSettlementError('INVALID_AGENT', 'Agent address is not a valid EVM address');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash)) {
      throw new ArcSettlementError('INVALID_ASSIGNMENT_TX', 'Agent claim transaction hash is invalid');
    }

    const agent = getAddress(input.agentAddress);
    const hash = input.transactionHash as Hash;
    const [receipt, transaction] = await Promise.all([
      this.publicClient.getTransactionReceipt({ hash }),
      this.publicClient.getTransaction({ hash }),
    ]);
    if (receipt.status !== 'success') {
      throw new ArcSettlementError('ASSIGNMENT_TX_REVERTED', 'Agent claim reverted on Arc Testnet');
    }
    if (!transaction.to || getAddress(transaction.to) !== this.vaultAddress || getAddress(transaction.from) !== agent) {
      throw new ArcSettlementError('ASSIGNMENT_TX_MISMATCH', 'Claim was not signed by the selected agent wallet');
    }
    const events = parseEventLogs({
      abi: STREAMING_VAULT_ABI,
      eventName: 'TaskAssigned',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.vaultAddress),
      strict: true,
    });
    if (!events.some((event) => event.args.taskId === taskId && getAddress(event.args.agent) === agent)) {
      throw new ArcSettlementError('ASSIGNMENT_EVENT_MISMATCH', 'Transaction does not contain the expected agent claim receipt');
    }
    const task = await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: STREAMING_VAULT_ABI,
      functionName: 'tasks',
      args: [taskId],
    });
    if (getAddress(task[1]) !== agent || task[10] !== 1) {
      throw new ArcSettlementError('ASSIGNMENT_STATE_MISMATCH', 'StreamingVault assignment state does not match the receipt');
    }
    return hash;
  }

  async verifyCollateralPosted(input: {
    chainTaskId: string;
    agentAddress: string;
    transactionHash: string;
  }): Promise<Hash> {
    const taskId = parseChainTaskId(input.chainTaskId);
    if (!isAddress(input.agentAddress)) {
      throw new ArcSettlementError('INVALID_AGENT', 'Agent address is not a valid EVM address');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash)) {
      throw new ArcSettlementError('INVALID_COLLATERAL_TX', 'Collateral transaction hash is invalid');
    }

    const agent = getAddress(input.agentAddress);
    const hash = input.transactionHash as Hash;
    const [receipt, transaction] = await Promise.all([
      this.publicClient.getTransactionReceipt({ hash }),
      this.publicClient.getTransaction({ hash }),
    ]);
    if (receipt.status !== 'success') {
      throw new ArcSettlementError('COLLATERAL_TX_REVERTED', 'Collateral transaction reverted on Arc Testnet');
    }
    if (!transaction.to || getAddress(transaction.to) !== this.vaultAddress || getAddress(transaction.from) !== agent) {
      throw new ArcSettlementError('COLLATERAL_TX_MISMATCH', 'Collateral transaction was not sent by the assigned agent to StreamingVault');
    }

    const events = parseEventLogs({
      abi: STREAMING_VAULT_ABI,
      eventName: 'CollateralPosted',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.vaultAddress),
      strict: true,
    });
    if (!events.some((event) => event.args.taskId === taskId && getAddress(event.args.agent) === agent)) {
      throw new ArcSettlementError('COLLATERAL_EVENT_MISMATCH', 'Transaction does not contain the expected collateral receipt');
    }

    const task = await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: STREAMING_VAULT_ABI,
      functionName: 'tasks',
      args: [taskId],
    });
    if (getAddress(task[1]) !== agent || task[10] !== 3 || task[4] !== task[3]) {
      throw new ArcSettlementError('COLLATERAL_STATE_MISMATCH', 'StreamingVault collateral state does not match the receipt');
    }
    return hash;
  }

  async verifyTaskCompleted(input: {
    chainTaskId: string;
    creatorAddress: string;
    transactionHash: string;
  }): Promise<Hash> {
    const taskId = parseChainTaskId(input.chainTaskId);
    if (!isAddress(input.creatorAddress)) {
      throw new ArcSettlementError('INVALID_CREATOR', 'Creator address is not a valid EVM address');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash)) {
      throw new ArcSettlementError('INVALID_COMPLETION_TX', 'Completion transaction hash is invalid');
    }

    const creator = getAddress(input.creatorAddress);
    const hash = input.transactionHash as Hash;
    const [receipt, transaction] = await Promise.all([
      this.publicClient.getTransactionReceipt({ hash }),
      this.publicClient.getTransaction({ hash }),
    ]);
    if (receipt.status !== 'success') {
      throw new ArcSettlementError('COMPLETION_TX_REVERTED', 'Completion transaction reverted on Arc Testnet');
    }
    if (!transaction.to || getAddress(transaction.to) !== this.vaultAddress || getAddress(transaction.from) !== creator) {
      throw new ArcSettlementError('COMPLETION_TX_MISMATCH', 'Completion transaction was not sent by the task creator to StreamingVault');
    }
    const events = parseEventLogs({
      abi: STREAMING_VAULT_ABI,
      eventName: 'TaskCompleted',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.vaultAddress),
      strict: true,
    });
    if (!events.some((event) => event.args.taskId === taskId)) {
      throw new ArcSettlementError('COMPLETION_EVENT_MISMATCH', 'Transaction does not contain the expected completion receipt');
    }
    const task = await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: STREAMING_VAULT_ABI,
      functionName: 'tasks',
      args: [taskId],
    });
    if (getAddress(task[0]) !== creator || task[10] !== 5) {
      throw new ArcSettlementError('COMPLETION_STATE_MISMATCH', 'StreamingVault completion state does not match the receipt');
    }
    return hash;
  }

  async verifyTaskCancelled(input: {
    chainTaskId: string;
    creatorAddress: string;
    transactionHash: string;
  }): Promise<Hash> {
    const taskId = parseChainTaskId(input.chainTaskId);
    if (!isAddress(input.creatorAddress)) {
      throw new ArcSettlementError('INVALID_CREATOR', 'Creator address is not a valid EVM address');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash)) {
      throw new ArcSettlementError('INVALID_CANCELLATION_TX', 'Cancellation transaction hash is invalid');
    }

    const creator = getAddress(input.creatorAddress);
    const hash = input.transactionHash as Hash;
    const [receipt, transaction] = await Promise.all([
      this.publicClient.getTransactionReceipt({ hash }),
      this.publicClient.getTransaction({ hash }),
    ]);
    if (receipt.status !== 'success') {
      throw new ArcSettlementError('CANCELLATION_TX_REVERTED', 'Cancellation transaction reverted on Arc Testnet');
    }
    if (!transaction.to || getAddress(transaction.to) !== this.vaultAddress || getAddress(transaction.from) !== creator) {
      throw new ArcSettlementError('CANCELLATION_TX_MISMATCH', 'Cancellation transaction was not sent by the task creator to StreamingVault');
    }
    const events = parseEventLogs({
      abi: STREAMING_VAULT_ABI,
      eventName: 'TaskCancelled',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.vaultAddress),
      strict: true,
    });
    if (!events.some((event) => event.args.taskId === taskId)) {
      throw new ArcSettlementError('CANCELLATION_EVENT_MISMATCH', 'Transaction does not contain the expected cancellation receipt');
    }
    const task = await this.publicClient.readContract({
      address: this.vaultAddress,
      abi: STREAMING_VAULT_ABI,
      functionName: 'tasks',
      args: [taskId],
    });
    if (getAddress(task[0]) !== creator || task[10] !== 7) {
      throw new ArcSettlementError('CANCELLATION_STATE_MISMATCH', 'StreamingVault cancellation state does not match the receipt');
    }
    return hash;
  }

  async verifyTaskPaused(input: {
    chainTaskId: string;
    participantAddress: string;
    transactionHash: string;
  }): Promise<Hash> {
    const taskId = parseChainTaskId(input.chainTaskId);
    if (!isAddress(input.participantAddress)) throw new ArcSettlementError('INVALID_PARTICIPANT', 'Dispute participant address is invalid');
    if (!/^0x[a-fA-F0-9]{64}$/.test(input.transactionHash)) throw new ArcSettlementError('INVALID_PAUSE_TX', 'Dispute pause transaction hash is invalid');
    const participant = getAddress(input.participantAddress);
    const hash = input.transactionHash as Hash;
    const [receipt, transaction] = await Promise.all([
      this.publicClient.getTransactionReceipt({ hash }),
      this.publicClient.getTransaction({ hash }),
    ]);
    if (receipt.status !== 'success') throw new ArcSettlementError('PAUSE_TX_REVERTED', 'Dispute pause transaction reverted on Arc Testnet');
    if (!transaction.to || getAddress(transaction.to) !== this.vaultAddress || getAddress(transaction.from) !== participant) {
      throw new ArcSettlementError('PAUSE_TX_MISMATCH', 'Dispute pause was not signed by the requesting participant');
    }
    const events = parseEventLogs({
      abi: STREAMING_VAULT_ABI,
      eventName: 'StreamPaused',
      logs: receipt.logs.filter((log) => getAddress(log.address) === this.vaultAddress),
      strict: true,
    });
    if (!events.some((event) => event.args.taskId === taskId)) {
      throw new ArcSettlementError('PAUSE_EVENT_MISMATCH', 'Transaction does not contain the expected pause receipt');
    }
    const task = await this.publicClient.readContract({ address: this.vaultAddress, abi: STREAMING_VAULT_ABI, functionName: 'tasks', args: [taskId] });
    if (task[10] !== 4 || (getAddress(task[0]) !== participant && getAddress(task[1]) !== participant)) {
      throw new ArcSettlementError('PAUSE_STATE_MISMATCH', 'StreamingVault pause state does not match the receipt');
    }
    return hash;
  }

  async settleDispute(chainTaskId: string, slashPct: number, decisionHash: string): Promise<Hash> {
    const taskId = parseChainTaskId(chainTaskId);
    if (!Number.isInteger(slashPct) || slashPct < 0 || slashPct > 100) {
      throw new ArcSettlementError('INVALID_SLASH_PERCENTAGE', 'Slash percentage must be an integer from 0 to 100');
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(decisionHash) || /^0x0{64}$/i.test(decisionHash)) {
      throw new ArcSettlementError('INVALID_DECISION_HASH', 'Decision hash must be a non-zero bytes32 value');
    }
    await this.assertDisputeModuleReady();
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.disputeModuleAddress,
      abi: DISPUTE_MODULE_ABI,
      functionName: 'settle',
      args: [taskId, BigInt(slashPct), decisionHash as Hash],
    });
    const hash = await this.walletClient.writeContract(request);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new ArcSettlementError('DISPUTE_SETTLEMENT_TX_REVERTED', 'Dispute settlement reverted on Arc Testnet');
    }
    return hash;
  }

  async readiness() {
    const [chainId, disputeOwner, disputeVault, disputeModulePaused] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({
        address: this.disputeModuleAddress,
        abi: DISPUTE_MODULE_ABI,
        functionName: 'owner',
      }),
      this.publicClient.readContract({
        address: this.disputeModuleAddress,
        abi: DISPUTE_MODULE_ABI,
        functionName: 'vault',
      }),
      this.publicClient.readContract({
        address: this.disputeModuleAddress,
        abi: DISPUTE_MODULE_ABI,
        functionName: 'paused',
      }),
    ]);
    return {
      chainId,
      vaultAddress: this.vaultAddress,
      settlementSignerAddress: this.account.address,
      disputeModuleAddress: this.disputeModuleAddress,
      disputeModuleOwned: getAddress(disputeOwner) === this.account.address,
      disputeModuleConfigured: getAddress(disputeVault) === this.vaultAddress,
      disputeModulePaused,
    };
  }

  private async assertDisputeModuleReady() {
    const status = await this.readiness();
    if (status.chainId !== arcTestnet.id) {
      throw new ArcSettlementError('WRONG_CHAIN', `Expected Arc Testnet chain ${arcTestnet.id}, received ${status.chainId}`);
    }
    if (!status.disputeModuleOwned || !status.disputeModuleConfigured || status.disputeModulePaused) {
      throw new ArcSettlementError('DISPUTE_MODULE_NOT_READY', 'Configured dispute module is not owned, linked, and unpaused for this operator');
    }
  }

}

function parseChainTaskId(value: string) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new ArcSettlementError('INVALID_CHAIN_TASK_ID', 'chainTaskId must be a positive integer');
  }
  return BigInt(value);
}

export function createArcSettlementGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ArcSettlementGateway | null {
  if (env.PACT_MODE !== 'arc') return null;
  const rpcUrl = env.PACT_ARC_RPC_URL ?? env.ARC_RPC_URL ?? 'https://rpc.testnet.arc.network';
  const vault = env.PACT_STREAMING_VAULT_ADDRESS ?? env.STREAMING_VAULT_ADDRESS ?? env.VAULT_ADDRESS;
  const disputeModule = env.PACT_DISPUTE_MODULE_ADDRESS ?? env.DISPUTE_MODULE_ADDRESS;
  const privateKey = env.PACT_DISPUTE_ADMIN_PRIVATE_KEY ?? env.PACT_OPERATOR_PRIVATE_KEY;
  if (!vault || !isAddress(vault)) {
    throw new Error('PACT_STREAMING_VAULT_ADDRESS must be a valid Arc Testnet contract address');
  }
  if (!privateKey || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error('PACT_DISPUTE_ADMIN_PRIVATE_KEY is required in Arc mode and must be a 32-byte hex key');
  }
  if (!disputeModule || !isAddress(disputeModule)) {
    throw new Error('PACT_DISPUTE_MODULE_ADDRESS must be a valid Arc Testnet contract address');
  }
  return new ViemArcSettlementGateway(getAddress(vault), getAddress(disputeModule), rpcUrl, privateKey as Hex);
}
