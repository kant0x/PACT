import {
  AgentDeliverable,
  AgentCapabilityManifest,
  ArenaAnswer,
  ArenaChallenge,
  ArenaEvaluationResult,
  ArenaLeaderboardEntry,
  ArenaTemplate,
  DashboardSnapshot,
  Dispute,
  DisputeVerdict,
  MarketplaceTask,
  DEFAULT_TASK_DURATION_SECONDS,
  type WorkOrderSpec,
  normalizeWorkOrderSpec,
} from '@pact/shared';

const configuredBase = (import.meta.env.VITE_API_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const apiToken = import.meta.env.VITE_API_TOKEN;
const isArcMode = import.meta.env.VITE_PACT_MODE === 'arc';

export const API_BASE = configuredBase;

export class PactApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, code = 'REQUEST_FAILED', status = 500) {
    super(message);
    this.name = 'PactApiError';
    this.code = code;
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      ...init?.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | { error?: string; code?: string }
    | T
    | null;

  if (!response.ok) {
    const error = payload as { error?: string; code?: string } | null;
    throw new PactApiError(
      error?.error ?? `Request failed with status ${response.status}`,
      error?.code,
      response.status,
    );
  }

  return payload as T;
}

export interface PublishTaskInput {
  title: string;
  description: string;
  successCriteria: string;
  creatorAddress: string;
  /** Optional direct invitation to a registered agent. */
  preferredAgentAddress?: string | null;
  totalAmount: string;
  estimatedDurationSeconds?: number;
  workOrder: WorkOrderSpec;
  /** Wallet signature proving the creator approved this exact work order. */
  signature?: string;
}

export function creatorTaskMessage(input: Pick<PublishTaskInput, 'creatorAddress' | 'title' | 'description' | 'successCriteria' | 'totalAmount' | 'estimatedDurationSeconds' | 'preferredAgentAddress' | 'workOrder'>): string {
  return [
    'PACT: publish funded task',
    `creator=${input.creatorAddress.toLowerCase()}`,
    `title=${input.title.trim()}`,
    `description=${input.description.trim()}`,
    `criteria=${input.successCriteria.trim()}`,
    `amount=${input.totalAmount}`,
    `duration=${input.estimatedDurationSeconds ?? DEFAULT_TASK_DURATION_SECONDS}`,
    `preferredAgent=${input.preferredAgentAddress?.toLowerCase() ?? ''}`,
    `workOrder=${JSON.stringify(normalizeWorkOrderSpec(input.workOrder))}`,
  ].join('\n');
}

export interface RegisterAgentInput {
  agentAddress: string;
  displayName: string;
  capabilityManifest?: AgentCapabilityManifest;
  signature?: string;
  /** Production-only: ask the PACT/Circle service to create a dedicated agent wallet. */
  provisionWallet?: boolean;
}

export function agentRegistrationMessage(input: Pick<RegisterAgentInput, 'displayName' | 'capabilityManifest'>): string {
  // updatedAt is server-assigned metadata, not part of the signed operating
  // envelope. Excluding it keeps the receipt verifiable after persistence.
  const manifest = input.capabilityManifest
    ? Object.fromEntries(Object.entries(input.capabilityManifest).filter(([key]) => key !== 'updatedAt'))
    : null;
  return [
    `Registering on PACT as ${input.displayName.trim()}`,
    `manifest=${JSON.stringify(manifest)}`,
  ].join('\n');
}

export interface CreateDisputeInput {
  taskId: string;
  reason: string;
  evidence: string;
}

export interface FinalizeHumanReviewInput {
  verdict: DisputeVerdict;
  reasoning: string;
}

export interface TrustModel {
  rankAuthority: string;
  rankInputs: string[];
  arbitrator: 'deterministic' | 'openai' | 'council';
  arbitratorAuthority: string;
  safeguards: string[];
}

export const api = {
  dashboard: (signal?: AbortSignal) =>
    request<DashboardSnapshot>(isArcMode ? '/api/dashboard/pg' : '/api/dashboard', { signal }),
  trustModel: (signal?: AbortSignal) =>
    request<TrustModel>('/api/trust-model', { signal }),
  acceptDeliverable: (deliverableId: string) =>
    request<{ deliverable: AgentDeliverable; task?: MarketplaceTask }>(`${isArcMode ? '/api/deliverables/pg' : '/api/deliverables'}/${encodeURIComponent(deliverableId)}/accept`, {
      method: 'POST',
    }),
  publishTask: (input: PublishTaskInput) =>
    request<MarketplaceTask>(isArcMode ? '/api/tasks/pg' : '/api/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  registerAgent: (input: RegisterAgentInput) =>
    request<unknown>(import.meta.env.VITE_PACT_MODE === 'arc' ? '/api/agents/pg' : '/api/agents', {
      method: 'POST',
      body: JSON.stringify(import.meta.env.VITE_PACT_MODE === 'arc'
        ? { address: input.agentAddress, displayName: input.displayName, capabilityManifest: input.capabilityManifest, signature: input.signature, provisionWallet: input.provisionWallet }
        : input),
    }),
  claimTask: (taskId: string, agentAddress: string) =>
    request<MarketplaceTask>(`${isArcMode ? '/api/tasks/pg' : '/api/tasks'}/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agentAddress }),
    }),
  arenaTemplates: (agentAddress?: string, signal?: AbortSignal) =>
    request<ArenaTemplate[]>(`/api/arena/templates${agentAddress ? `?agentAddress=${encodeURIComponent(agentAddress)}` : ''}`, { signal }),
  arenaLeaderboard: (signal?: AbortSignal) =>
    request<ArenaLeaderboardEntry[]>('/api/arena/leaderboard', { signal }),
  startArenaAttempt: (templateId: string, agentAddress: string) =>
    request<ArenaChallenge>(`/api/arena/templates/${encodeURIComponent(templateId)}/start`, {
      method: 'POST',
      body: JSON.stringify({ agentAddress }),
    }),
  submitArenaAttempt: (challenge: ArenaChallenge, answers: ArenaAnswer[], consentToTraining: boolean) =>
    request<ArenaEvaluationResult>(`/api/arena/attempts/${encodeURIComponent(challenge.attemptId)}/submit`, {
      method: 'POST',
      body: JSON.stringify({
        attemptToken: challenge.attemptToken,
        agentAddress: challenge.agentAddress,
        answers,
        evidence: [challenge.document.contentHash],
        consentToTraining,
      }),
    }),
  createDispute: (input: CreateDisputeInput) =>
    request<Dispute>(isArcMode ? `/api/tasks/pg/${encodeURIComponent(input.taskId)}/dispute` : '/api/disputes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  finalizeHumanReview: (id: string, input: FinalizeHumanReviewInput) =>
    request<Dispute>(`${isArcMode ? '/api/disputes/pg' : '/api/disputes'}/${encodeURIComponent(id)}/human-review`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  seedDemo: () => request<DashboardSnapshot>('/api/demo/seed', { method: 'POST' }),
};
