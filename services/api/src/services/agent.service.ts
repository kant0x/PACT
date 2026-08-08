import { agentRepository } from '../repositories/agent.repository.js';
import type { AgentCapabilityManifest, ReputationSnapshot, StreamTerms } from '@pact/shared';
import { ApiProblem } from '../errors.js';
import { REPUTATION_TIERS, SCORE } from '../config.js';
import { createOnchainReputationReader, type OnchainReputationReader } from '../onchain-reputation.js';

export class AgentService {
  constructor(private readonly onchainReader: OnchainReputationReader | null = createOnchainReputationReader()) {}

  async getReputation(agentAddress: string): Promise<ReputationSnapshot> {
    const agent = await agentRepository.findByAddress(agentAddress.toLowerCase());
    if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent not found');

    let score = agent.score;
    let completedTasks = agent.completedTasks;
    let failedTasks = agent.failedTasks;
    let totalVolumeStreamed = agent.totalVolumeStreamed.toString();
    let lastUpdated = agent.lastUpdated;
    if (this.onchainReader) {
      try {
        const onchain = await this.onchainReader.read(agent.agentAddress);
        score = onchain.score;
        completedTasks = onchain.completedTasks;
        failedTasks = onchain.failedTasks;
        totalVolumeStreamed = onchain.totalVolumeStreamed;
        lastUpdated = onchain.lastUpdated || lastUpdated;
      } catch (error) {
        throw new ApiProblem(503, 'ONCHAIN_REPUTATION_UNAVAILABLE', 'The on-chain ReputationRegistry could not be read');
      }
    }
    const tier = REPUTATION_TIERS.find((candidate) => score >= candidate.minScore) ?? REPUTATION_TIERS.at(-1)!;
    const terms = { ...tier.terms };

    return {
      agentAddress: agent.agentAddress,
      displayName: agent.displayName,
      score: agent.score,
      completedTasks,
      failedTasks,
      totalVolumeStreamed,
      platformPoints: agent.platformPoints ?? 0,
      lastUpdated,
      terms,
      capabilityManifest: agent.capabilityManifest as AgentCapabilityManifest,
      wallet: {
        provider: agent.walletProvider,
        accountType: agent.walletAccountType,
        controllerAddress: agent.controllerAddress,
      }
    };
  }
}

export const agentService = new AgentService();
