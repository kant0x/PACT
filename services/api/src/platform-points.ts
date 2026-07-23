import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  parseAbi,
  publicActions,
  stringToBytes,
  type Address,
  type Hex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/;

const PLATFORM_POINTS_ABI = parseAbi([
  'function awardPoints(address agent, uint256 points, bytes32 attemptId) external',
  'function pointsOf(address agent) view returns (uint256)'
]);

export interface PlatformPointsReceipt {
  mode: 'OFFCHAIN' | 'ARC_TESTNET';
  transactionHash: string | null;
  contractAddress: string | null;
  chainId: number | null;
  agentTotal: number | null;
}

export interface PlatformPointsService {
  describe(): Record<string, unknown>;
  award(agentAddress: string, points: number, attemptId: string): Promise<PlatformPointsReceipt>;
  getPoints(agentAddress: string): Promise<number>;
}

const arcChain = (chainId: number) => ({
  id: chainId,
  name: chainId === 5_042_002 ? 'Arc Testnet' : 'PACT EVM network',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [process.env.PLATFORM_POINTS_RPC_URL || process.env.ARC_RPC_URL || 'https://rpc.testnet.arc.network'] } }
} as const);

class ArcPlatformPointsService implements PlatformPointsService {
  private readonly account;
  private readonly walletClient;
  private readonly publicClient;

  constructor(
    private readonly contractAddress: Address,
    private readonly chainId: number,
    private readonly rpcUrl: string,
    privateKey: Hex
  ) {
    this.account = privateKeyToAccount(privateKey);
    const chain = arcChain(chainId);
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl) });
    this.publicClient = this.walletClient.extend(publicActions);
  }

  describe() {
    return {
      mode: 'ARC_TESTNET',
      contractAddress: this.contractAddress,
      chainId: this.chainId,
      awarderAddress: this.account.address,
      rpcUrl: this.rpcUrl,
      guarantees: ['non-transferable points', 'one award per attempt receipt', 'transaction receipt before local score update']
    };
  }

  async award(agentAddress: string, points: number, attemptId: string): Promise<PlatformPointsReceipt> {
    if (!ADDRESS.test(agentAddress)) throw new Error('Platform points agent address is invalid');
    if (!Number.isInteger(points) || points <= 0) throw new Error('Platform points award must be a positive integer');
    if (!attemptId.trim()) throw new Error('Platform points attempt id is required');

    const receiptId = keccak256(stringToBytes(`PACT:training-ground:${attemptId}`));
    const hash = await this.walletClient.writeContract({
      address: this.contractAddress,
      abi: PLATFORM_POINTS_ABI,
      functionName: 'awardPoints',
      args: [agentAddress as Address, BigInt(points), receiptId]
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    const total = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: PLATFORM_POINTS_ABI,
      functionName: 'pointsOf',
      args: [agentAddress as Address]
    });

    return {
      mode: 'ARC_TESTNET',
      transactionHash: hash,
      contractAddress: this.contractAddress,
      chainId: this.chainId,
      agentTotal: Number(total)
    };
  }

  async getPoints(agentAddress: string): Promise<number> {
    if (!ADDRESS.test(agentAddress)) throw new Error('Platform points agent address is invalid');
    const total = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: PLATFORM_POINTS_ABI,
      functionName: 'pointsOf',
      args: [agentAddress as Address]
    });
    return Number(total);
  }
}

export function createPlatformPointsFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformPointsService | null {
  const contractAddress = env.PLATFORM_POINTS_ADDRESS?.trim();
  const privateKey = (env.PLATFORM_POINTS_AWARDER_PRIVATE_KEY || env.DEPLOYER_PRIVATE_KEY || '').trim();
  if (!contractAddress && !privateKey) return null;
  if (!contractAddress || !privateKey) {
    throw new Error('PLATFORM_POINTS_ADDRESS and PLATFORM_POINTS_AWARDER_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) are both required for Arc points');
  }
  if (!ADDRESS.test(contractAddress)) throw new Error('PLATFORM_POINTS_ADDRESS must be a valid EVM address');
  if (!PRIVATE_KEY.test(privateKey)) throw new Error('PLATFORM_POINTS_AWARDER_PRIVATE_KEY must be a 32-byte hex private key');
  const chainId = Number(env.PLATFORM_POINTS_CHAIN_ID || env.ARC_CHAIN_ID || '5042002');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('PLATFORM_POINTS_CHAIN_ID must be a positive integer');
  const rpcUrl = env.PLATFORM_POINTS_RPC_URL || env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
  const account = privateKeyToAccount(privateKey as Hex);
  const configuredAwarder = env.PLATFORM_POINTS_AWARDER_ADDRESS?.trim();
  if (configuredAwarder && (!ADDRESS.test(configuredAwarder) || configuredAwarder.toLowerCase() !== account.address.toLowerCase())) {
    throw new Error('PLATFORM_POINTS_AWARDER_ADDRESS must match the configured scorer private key');
  }
  return new ArcPlatformPointsService(contractAddress as Address, chainId, rpcUrl, privateKey as Hex);
}
