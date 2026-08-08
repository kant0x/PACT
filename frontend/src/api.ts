import {
  AgentDeliverable,
  AgentCapabilityManifest,
  AgentAutomationSnapshot,
  AgentRun,
  ArenaLeaderboardEntry,
  ArenaTemplate,
  ArenaTrainingReport,
  DashboardSnapshot,
  Dispute,
  DisputeVerdict,
  MarketplaceTask,
  DEFAULT_TASK_DURATION_SECONDS,
  type WorkOrderSpec,
  normalizeWorkOrderSpec,
} from '@pact/shared';
import { runtimeConfig } from './runtime';

const configuredBase = (runtimeConfig.apiUrl ?? 'http://localhost:4100').replace(/\/$/, '');
const SESSION_KEY = `pact.wallet-session:${configuredBase}`;

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
  const sessionToken = (() => {
    if (typeof window === 'undefined') return null;
    const saved = window.sessionStorage.getItem(SESSION_KEY);
    if (!saved) return null;
    try {
      const session = JSON.parse(saved) as Partial<WalletSession>;
      if (typeof session.token === 'string' && session.token) return session.token;
    } catch {
      // Support a short-lived session saved by an older browser build.
      if (saved.startsWith('pact1.')) return saved;
    }
    window.sessionStorage.removeItem(SESSION_KEY);
    return null;
  })();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
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
  /** Confirmed Arc Testnet transaction that funded the open StreamingVault order. */
  fundingTransactionHash?: `0x${string}`;
}

interface WalletSession {
  token: string;
  address: string;
  expiresAt: number;
}

export async function authenticateWallet(
  address: `0x${string}`,
  signMessage: (message: string) => Promise<`0x${string}`>,
): Promise<WalletSession> {
  const normalized = address.toLowerCase();
  if (typeof window !== 'undefined') {
    const saved = window.sessionStorage.getItem(SESSION_KEY);
    if (saved) {
      try {
        const session = JSON.parse(saved) as WalletSession;
        if (session.address === normalized && session.expiresAt > Math.floor(Date.now() / 1000) + 15) {
          try {
            await request<{ address: string; expiresAt: number }>('/api/auth/session');
            return session;
          } catch (error) {
            if (!(error instanceof PactApiError) || error.status !== 401) throw error;
            window.sessionStorage.removeItem(SESSION_KEY);
          }
        }
      } catch {
        window.sessionStorage.removeItem(SESSION_KEY);
      }
    }
  }

  const challenge = await request<{ challengeId: string; message: string; expiresAt: number }>('/api/auth/challenge', {
    method: 'POST',
    body: JSON.stringify({ address }),
  });
  const signature = await signMessage(challenge.message);
  const session = await request<WalletSession>('/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId: challenge.challengeId, address, signature }),
  });
  if (typeof window !== 'undefined') window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function clearWalletSession(expectedAddress?: string): void {
  if (typeof window === 'undefined') return;
  if (!expectedAddress) {
    window.sessionStorage.removeItem(SESSION_KEY);
    return;
  }
  const saved = window.sessionStorage.getItem(SESSION_KEY);
  if (!saved) return;
  try {
    const session = JSON.parse(saved) as WalletSession;
    if (session.address !== expectedAddress.toLowerCase()) window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    window.sessionStorage.removeItem(SESSION_KEY);
  }
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
  displayName: string;
  capabilityManifest?: AgentCapabilityManifest;
  /** PACT agents always receive a dedicated Circle Arc smart-contract account. */
  provisionWallet: true;
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

export function arenaAttemptMessage(templateId: string, agentAddress: string, dayKey = new Date().toISOString().slice(0, 10)): string {
  return [
    'PACT: start Training Ground attempt',
    `template=${templateId}`,
    `agent=${agentAddress.toLowerCase()}`,
    `day=${dayKey}`,
  ].join('\n');
}

export interface CreateDisputeInput {
  taskId: string;
  reason: string;
  evidence: string;
  pauseTransactionHash?: `0x${string}`;
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

export type CircleAgentAction =
  | 'CLAIM_TASK'
  | 'APPROVE_COLLATERAL'
  | 'POST_COLLATERAL'
  | 'WITHDRAW_STREAM'
  | 'PAUSE_DISPUTE'
  | 'SUBMIT_RESULT_PROOF'
  | 'REGISTER_AGENT'
  | 'UPDATE_AGENT_PROFILE'
  | 'SUBMIT_MILESTONE_PROOF'
  | 'CLAIM_MILESTONE'
  | 'CLAIM_SUBSCRIPTION'
  | 'CLAIM_REWARD';

export interface CircleProtocolActionInput {
  resourceId?: string;
  milestoneId?: string;
  proofHash?: `0x${string}`;
  profileHash?: `0x${string}`;
  capabilitiesHash?: `0x${string}`;
}

export interface CircleTransactionStatus {
  id: string;
  state: string;
  txHash: `0x${string}` | null;
  blockchain: string;
  createDate: string;
  updateDate: string;
  errorReason: string | null;
}

export const api = {
  dashboard: (signal?: AbortSignal) =>
    request<DashboardSnapshot>('/api/dashboard/pg', { signal }),
  trustModel: (signal?: AbortSignal) =>
    request<TrustModel>('/api/trust-model', { signal }),
  acceptDeliverable: (deliverableId: string, completionTransactionHash?: `0x${string}`) =>
    request<{ deliverable: AgentDeliverable; task?: MarketplaceTask }>(`/api/deliverables/pg/${encodeURIComponent(deliverableId)}/accept`, {
      method: 'POST',
      ...(completionTransactionHash ? { body: JSON.stringify({ completionTransactionHash }) } : {}),
    }),
  publishTask: (input: PublishTaskInput) =>
    request<MarketplaceTask>('/api/tasks/pg', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  registerAgent: (input: RegisterAgentInput, sessionToken?: string) =>
    request<unknown>('/api/agents/pg', {
      method: 'POST',
      body: JSON.stringify({ displayName: input.displayName, capabilityManifest: input.capabilityManifest, provisionWallet: true }),
      ...(sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : {}),
    }),
  claimTask: (taskId: string, agentAddress: string, assignmentTransactionHash?: `0x${string}`) =>
    request<MarketplaceTask>(`/api/tasks/pg/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      body: JSON.stringify({ agentAddress, assignmentTransactionHash }),
    }),
  submitCircleAgentAction: (agentAddress: string, taskId: string, action: CircleAgentAction, protocol?: CircleProtocolActionInput) =>
    request<{ id: string; state: string; action: CircleAgentAction; taskId: string | null; resourceId: string | null }>(`/api/agents/pg/${encodeURIComponent(agentAddress)}/circle/actions`, {
      method: 'POST',
      body: JSON.stringify({ taskId, action, ...protocol }),
    }),
  circleTransaction: (agentAddress: string, transactionId: string) =>
    request<CircleTransactionStatus>(`/api/agents/pg/${encodeURIComponent(agentAddress)}/circle/transactions/${encodeURIComponent(transactionId)}`),
  agentAutopilot: (agentAddress: string, action: 'start' | 'pause') =>
    request<AgentAutomationSnapshot>(`/api/agents/${encodeURIComponent(agentAddress)}/autopilot/${action}`, { method: 'POST' }),
  runAgent: (taskId: string, agentAddress: string) =>
    request<AgentRun>('/api/agent-runs/pg', {
      method: 'POST',
      body: JSON.stringify({ taskId, agentAddress }),
    }),
  startTask: (taskId: string, collateralTransactionHash: `0x${string}`) =>
    request<MarketplaceTask>(`/api/tasks/pg/${encodeURIComponent(taskId)}/start`, {
      method: 'POST',
      body: JSON.stringify({ collateralTransactionHash }),
    }),
  cancelTask: (taskId: string, cancellationTransactionHash: `0x${string}`) =>
    request<MarketplaceTask>(`/api/tasks/pg/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ cancellationTransactionHash }),
    }),
  trainingCatalog: (agentAddress?: string, signal?: AbortSignal) =>
    request<ArenaTemplate[]>(`/api/training/catalog${agentAddress ? `?agentAddress=${encodeURIComponent(agentAddress)}` : ''}`, { signal }),
  arenaReports: (agentAddress: string, signal?: AbortSignal) =>
    request<ArenaTrainingReport[]>(`/api/training/agents/${encodeURIComponent(agentAddress)}/reports`, { signal }),
  arenaLeaderboard: (signal?: AbortSignal) =>
    request<ArenaLeaderboardEntry[]>('/api/arena/leaderboard', { signal }),
  createDispute: (input: CreateDisputeInput) =>
    request<Dispute>(`/api/tasks/pg/${encodeURIComponent(input.taskId)}/dispute`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  finalizeHumanReview: (id: string, input: FinalizeHumanReviewInput) =>
    request<Dispute>(`/api/disputes/pg/${encodeURIComponent(id)}/human-review`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
};
