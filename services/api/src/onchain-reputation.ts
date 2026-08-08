import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
} from 'viem';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const REPUTATION_ABI = parseAbi([
  'function getAgentHistory(address agent) view returns (uint256 completedTasks, uint256 failedTasks, uint256 totalVolume, uint256 localScore, uint256 lastActivityTimestamp)',
  'function getAgentScore(address agent) view returns (uint256)',
]);

const arcChain = (chainId: number, rpcUrl: string) => ({
  id: chainId,
  name: chainId === 5_042_002 ? 'Arc Testnet' : 'PACT EVM network',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const);

export interface OnchainReputation {
  completedTasks: number;
  failedTasks: number;
  totalVolumeStreamed: string;
  score: number;
  lastUpdated: number;
}

export class OnchainReputationReader {
  private readonly publicClient;

  constructor(
    private readonly registryAddress: Address,
    chainId: number,
    rpcUrl: string,
  ) {
    this.publicClient = createPublicClient({ chain: arcChain(chainId, rpcUrl), transport: http(rpcUrl) });
  }

  async read(agentAddress: string): Promise<OnchainReputation> {
    if (!ADDRESS.test(agentAddress)) throw new Error('Agent address is not a valid EVM address');
    const history = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: REPUTATION_ABI,
      functionName: 'getAgentHistory',
      args: [agentAddress as Address],
    });
    return {
      completedTasks: Number(history[0]),
      failedTasks: Number(history[1]),
      totalVolumeStreamed: history[2].toString(),
      score: Number(history[3]),
      lastUpdated: Number(history[4]),
    };
  }
}

export function createOnchainReputationReader(env: NodeJS.ProcessEnv = process.env): OnchainReputationReader | null {
  const registry = (env.PACT_REPUTATION_REGISTRY_ADDRESS || env.REPUTATION_REGISTRY_ADDRESS || '').trim();
  if (!registry) return null;
  if (!ADDRESS.test(registry)) throw new Error('PACT_REPUTATION_REGISTRY_ADDRESS must be a valid EVM address');
  const chainId = Number(env.ARC_CHAIN_ID || '5042002');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('ARC_CHAIN_ID must be a positive integer');
  const rpcUrl = env.ARC_RPC_URL || 'https://rpc.testnet.arc.network';
  return new OnchainReputationReader(registry as Address, chainId, rpcUrl);
}
