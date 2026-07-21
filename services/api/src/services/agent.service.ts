import { agentRepository } from '../repositories/agent.repository.js';
import type { AgentCapabilityManifest, ReputationSnapshot, StreamTerms } from '@pact/shared';
import { ApiProblem } from '../errors.js';
import { REPUTATION_TIERS, SCORE } from '../config.js';

export class AgentService {
  async getReputation(agentAddress: string): Promise<ReputationSnapshot> {
    const agent = await agentRepository.findByAddress(agentAddress.toLowerCase());
    if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent not found');

    const score = agent.score;
    const tier = REPUTATION_TIERS.find((candidate) => score >= candidate.minScore) ?? REPUTATION_TIERS.at(-1)!;
    const terms = { ...tier.terms };

    return {
      agentAddress: agent.agentAddress,
      displayName: agent.displayName,
      score: agent.score,
      completedTasks: agent.completedTasks,
      failedTasks: agent.failedTasks,
      totalVolumeStreamed: agent.totalVolumeStreamed.toString(),
      platformPoints: agent.platformPoints ?? 0,
      lastUpdated: agent.lastUpdated,
      terms,
      capabilityManifest: agent.capabilityManifest as AgentCapabilityManifest
    };
  }
}

export const agentService = new AgentService();
