import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  AgentCapabilityManifest,
  AgentDeliverable,
  AgentExecutionTrace,
  AgentPlan,
  AgentReputationScore,
  AgentRun,
  AgentRunStep,
  AgentToolCallTrace,
  AgentTraceMessage,
  ArenaChallenge,
  ArenaCheckResult,
  ArenaEvaluationResult,
  ArenaLeaderboardEntry,
  ArenaSubmission,
  ArenaTemplate,
  DashboardSnapshot,
  Dispute,
  DisputeVerdict,
  MarketplaceTask,
  ReputationEvent,
  ReputationSnapshot,
  StreamTerms,
  WorkOrderSpec
} from '@pact/shared';
import { DEFAULT_TASK_DURATION_SECONDS, DEMO_ADDRESSES, inferTaskCategory, manifestSupportsTaskCategory, manifestSupportsWorkOrder, WORK_ORDER_TEMPLATES } from '@pact/shared';
import { REPUTATION_TIERS, SCORE, VERDICT_SLASH_PCT } from './config.js';
import { ApiProblem, assert } from './errors.js';
import type { ArbitrationDecision } from './arbitration.js';
import type { StatePersistence } from './persistence.js';
import { validateCapabilityManifest } from './capability-validation.js';
import { defaultWorkOrderForTask, validateWorkOrderSpec } from './work-order-validation.js';
import {
  ARENA_GENERATOR_VERSION,
  ARENA_RUBRIC_VERSION,
  BUILT_IN_ARENA_TEMPLATES,
  createArenaInstance,
  nextUtcDaySeconds,
  normalizeArenaText,
  parseArenaNumber,
  publicArenaPayload,
  publicTemplate,
  scoreWithCorrectnessGate,
  sha256,
  utcDayKey,
  type ArenaPrivateInstance,
  type ArenaTemplateRecord
} from './arena.js';
import type { ArenaCodeRunner } from './arena-code-runner.js';
import type { ArenaQualityJudge } from './arena-quality-judge.js';
import type { PlatformPointsService } from './platform-points.js';

const isPromiseLike = <T>(value: unknown): value is PromiseLike<T> =>
  typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then?: unknown }).then === 'function';

export interface CreateTaskInput {
  title: string;
  description?: string;
  successCriteria?: string;
  creatorAddress: string;
  preferredAgentAddress?: string | null;
  totalAmount: string | number;
  estimatedDurationSeconds?: number;
  templateId?: string;
  workOrder?: Partial<WorkOrderSpec> | null;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  successCriteria?: string;
  totalAmount?: string | number;
  estimatedDurationSeconds?: number;
}

export interface RegisterAgentInput {
  agentAddress: string;
  displayName: string;
  capabilityManifest?: AgentCapabilityManifest;
}

export interface CreateAgentTraceInput {
  taskId: string;
  messages: AgentTraceMessage[];
  toolCalls?: AgentToolCallTrace[];
  deliverableSummary: string;
  evidence?: string[];
  consentToTraining?: boolean;
  provider?: string;
}

export interface SubmitDeliverableInput {
  summary: string;
  artifacts: AgentDeliverable['artifacts'];
  evidence?: string[];
}

export type StoreEvent =
  | { type: 'snapshot'; snapshot: DashboardSnapshot }
  | { type: 'stream'; taskId: string; status: ReturnType<DemoStore['streamStatus']> };

interface AgentRecord extends AgentReputationScore {
  displayName: string;
  capabilityManifest: AgentCapabilityManifest;
}

export interface PersistedDemoState {
  version: 1;
  tasks: MarketplaceTask[];
  agents: AgentRecord[];
  disputes: Dispute[];
  reputationEvents: ReputationEvent[];
  executionTraces?: AgentExecutionTrace[];
  agentRuns?: AgentRun[];
  deliverables?: AgentDeliverable[];
  arenaTemplates?: ArenaTemplateRecord[];
  arenaAttempts?: ArenaAttemptRecord[];
}

interface ArenaAttemptRecord {
  id: string;
  templateId: string;
  agentAddress: string;
  dayKey: string;
  tokenHash: string;
  status: 'STARTED' | 'SUBMITTED';
  startedAt: number;
  submittedAt: number | null;
  privateInstance: ArenaPrivateInstance;
  instanceCommitment: string;
  submission: ArenaSubmission | null;
  trainingConsent: boolean;
  result: ArenaEvaluationResult | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const money = (value: number) => Math.max(0, value).toFixed(6).replace(/\.?0+$/, '') || '0';
const parseMoney = (value: string | number, field = 'amount') => {
  const parsed = typeof value === 'number' ? value : Number(value);
  assert(Number.isFinite(parsed) && parsed > 0 && parsed <= 1_000_000_000, 400, 'INVALID_AMOUNT', `${field} must be a positive amount up to 1,000,000,000 USDC`);
  return parsed;
};

const boundedOptionalText = (value: unknown, field: string, max: number) => {
  if (value === undefined || value === null) return '';
  assert(typeof value === 'string' && value.length <= max, 400, `INVALID_${field.toUpperCase()}`, `${field} must be a string of at most ${max} characters`);
  return value.trim();
};

const defaultCapabilityManifest = (address: string): AgentCapabilityManifest => {
  const proofAgent = address.toLowerCase() === DEMO_ADDRESSES.proofAgent.toLowerCase();
  const veteran = address.toLowerCase() === DEMO_ADDRESSES.veteran.toLowerCase();
  const platformAgent = address.toLowerCase() === DEMO_ADDRESSES.platformAgent.toLowerCase();

  if (platformAgent) {
    return {
      version: '1.0',
      executionMode: 'EXTERNAL_RUNTIME',
      capabilities: [
        {
          id: 'platform.orchestration',
          label: 'Platform Orchestrator',
          description: 'Orchestrates complex tasks, acts as a decentralized coordinator, and provides automated dispute resolution suggestions.',
          inputTypes: ['task status', 'dispute claims', 'platform metrics'],
          outputTypes: ['task breakdown', 'resolution recommendation', 'audit log'],
          verification: 'EXTERNAL_ATTESTATION'
        }
      ],
      tools: ['task analyzer', 'dispute resolver'],
      evidenceMethods: ['audit log hash'],
      maxConcurrentTasks: 100,
      walletPolicy: {
        allowedChains: ['ARC-TESTNET'],
        allowedActions: ['CREATE_TASK', 'RESOLVE_DISPUTE', 'CLAIM_TASK'],
        perTaskLimitUsdc: '5000',
        requiresHumanApprovalAboveUsdc: null
      },
      updatedAt: nowSeconds()
    };
  }

  if (proofAgent) {
    return {
      version: '1.0',
      executionMode: 'EXTERNAL_RUNTIME',
      capabilities: [
        {
          id: 'research.verify',
          label: 'Evidence verification',
          description: 'Normalizes task evidence, checks it against acceptance criteria, and produces a reviewable proof manifest.',
          inputTypes: ['task brief', 'acceptance criteria', 'evidence bundle'],
          outputTypes: ['verification report', 'evidence manifest', 'SHA-256 receipts'],
          verification: 'DEMO_VERIFIED'
        },
        {
          id: 'security.review',
          label: 'Policy review',
          description: 'Reviews bounded wallet and agent policies for amount, chain, action, and approval risks.',
          inputTypes: ['policy JSON', 'threat model', 'limits'],
          outputTypes: ['risk register', 'policy diff', 'review checklist'],
          verification: 'DEMO_VERIFIED'
        },
        {
          id: 'presentation.compose',
          label: 'Product narrative',
          description: 'Turns verified product facts into concise demo scripts, storyboards, and presentation artifacts.',
          inputTypes: ['product brief', 'verified facts', 'brand constraints'],
          outputTypes: ['storyboard', 'script', 'caption plan'],
          verification: 'SELF_DECLARED'
        }
      ],
      tools: ['document parser', 'evidence hasher', 'policy checklist'],
      evidenceMethods: ['criteria matrix', 'SHA-256 artifact hash', 'policy receipt'],
      maxConcurrentTasks: 2,
      walletPolicy: {
        allowedChains: ['ARC-TESTNET'],
        allowedActions: ['CLAIM_TASK', 'WITHDRAW_STREAM'],
        perTaskLimitUsdc: '500',
        requiresHumanApprovalAboveUsdc: '250'
      },
      updatedAt: nowSeconds()
    };
  }
  return {
    version: '1.0',
    executionMode: 'EXTERNAL_RUNTIME',
    capabilities: veteran ? [
      {
        id: 'research.verify',
        label: 'Research & verification',
        description: 'Collects sources, cross-checks claims, and returns a traceable evidence pack.',
        inputTypes: ['task brief', 'URLs', 'acceptance criteria'],
        outputTypes: ['markdown report', 'source manifest', 'JSON'],
        verification: 'SELF_DECLARED'
      },
      {
        id: 'code.execute',
        label: 'Code execution',
        description: 'Builds and validates repository-scoped changes against explicit completion checks.',
        inputTypes: ['repository', 'technical specification', 'test command'],
        outputTypes: ['patch', 'test receipt', 'build artifact'],
        verification: 'SELF_DECLARED'
      },
      {
        id: 'api.orchestrate',
        label: 'API orchestration',
        description: 'Coordinates allowlisted APIs while preserving a machine-readable action trace.',
        inputTypes: ['OpenAPI schema', 'JSON', 'policy'],
        outputTypes: ['JSON', 'action log', 'receipt hash'],
        verification: 'SELF_DECLARED'
      },
      {
        id: 'transaction.prepare',
        label: 'Transaction preparation',
        description: 'Prepares bounded Arc actions; signing remains subject to the wallet policy.',
        inputTypes: ['contract ABI', 'intent', 'spending limit'],
        outputTypes: ['unsigned transaction', 'simulation result'],
        verification: 'SELF_DECLARED'
      }
    ] : [
      {
        id: 'research.basic',
        label: 'Structured research',
        description: 'Turns a bounded brief into a cited report and structured findings.',
        inputTypes: ['task brief', 'URLs'],
        outputTypes: ['markdown report', 'JSON'],
        verification: 'SELF_DECLARED'
      },
      {
        id: 'data.extract',
        label: 'Data extraction',
        description: 'Extracts normalized fields from supplied public documents.',
        inputTypes: ['HTML', 'PDF', 'plain text'],
        outputTypes: ['CSV', 'JSON'],
        verification: 'SELF_DECLARED'
      }
    ],
    tools: veteran ? ['HTTPS', 'JSON API', 'repository sandbox', 'Arc transaction simulation'] : ['HTTPS', 'document parser'],
    evidenceMethods: veteran ? ['source manifest', 'test receipt', 'SHA-256 artifact hash', 'transaction simulation'] : ['source manifest', 'SHA-256 artifact hash'],
    maxConcurrentTasks: veteran ? 4 : 1,
    walletPolicy: {
      allowedChains: ['ARC-TESTNET'],
      allowedActions: veteran ? ['CLAIM_TASK', 'WITHDRAW_STREAM', 'PREPARE_TRANSACTION'] : ['CLAIM_TASK', 'WITHDRAW_STREAM'],
      perTaskLimitUsdc: veteran ? '10000' : '500',
      requiresHumanApprovalAboveUsdc: veteran ? '1000' : '100'
    },
    updatedAt: nowSeconds()
  };
};

export class DemoStore {
  private tasks = new Map<string, MarketplaceTask>();
  private agents = new Map<string, AgentRecord>();
  private disputes = new Map<string, Dispute>();
  private reputationEvents: ReputationEvent[] = [];
  private executionTraces = new Map<string, AgentExecutionTrace>();
  private agentRuns = new Map<string, AgentRun>();
  private deliverables = new Map<string, AgentDeliverable>();
  private arenaTemplates = new Map<string, ArenaTemplateRecord>();
  private arenaAttempts = new Map<string, ArenaAttemptRecord>();
  private listeners = new Set<(event: StoreEvent) => void>();

  constructor(private readonly persistence?: StatePersistence<PersistedDemoState>) {
    const saved = persistence?.load();
    if (isPromiseLike<PersistedDemoState | null>(saved)) {
      this.reset();
      saved
        .then((persisted) => {
          if (persisted?.version === 1) this.hydrate(persisted);
        })
        .catch((error) => console.error('PACT persistence load failed', error));
    } else if (saved?.version === 1) this.hydrate(saved);
    else this.reset();
  }

  subscribe(listener: (event: StoreEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset() {
    this.tasks.clear();
    this.disputes.clear();
    this.reputationEvents = [];
    this.executionTraces.clear();
    this.agentRuns.clear();
    this.deliverables.clear();
    this.arenaTemplates = new Map(BUILT_IN_ARENA_TEMPLATES.map((template) => [template.id, structuredClone(template)]));
    this.arenaAttempts.clear();
    this.agents.clear();
    this.ensureAgent(DEMO_ADDRESSES.newbie, 'Agent Newbie');
    this.ensureAgent(DEMO_ADDRESSES.veteran, 'Agent Veteran');
    this.ensureAgent(DEMO_ADDRESSES.proofAgent, 'PACT Proof Agent');
    this.ensureAgent(DEMO_ADDRESSES.platformAgent, 'Platform Coordinator Agent');
    this.emitSnapshot();
    return this.dashboard();
  }

  private ensureAgent(address: string, displayName?: string): AgentRecord {
    const key = address.toLowerCase();
    let agent = this.agents.get(key);
    if (!agent) {
      agent = {
        agentAddress: address,
        displayName: displayName ?? `Agent ${address.slice(0, 6)}`,
        score: SCORE.base,
        completedTasks: 0,
        failedTasks: 0,
        totalVolumeStreamed: '0',
        platformPoints: 0,
        lastUpdated: nowSeconds(),
        capabilityManifest: defaultCapabilityManifest(address)
      };
      this.agents.set(key, agent);
    }
    return agent;
  }

  private getRegisteredAgent(address: string) {
    const normalized = address.trim().toLowerCase();
    assert(/^0x[a-fA-F0-9]{40}$/.test(normalized), 400, 'INVALID_AGENT_ADDRESS', 'agentAddress must be a 20-byte hex address');
    const agent = this.agents.get(normalized);
    assert(agent, 404, 'AGENT_NOT_FOUND', `Agent ${address} is not registered`);
    return agent;
  }

  registerAgent(input: RegisterAgentInput) {
    const address = input?.agentAddress?.trim() ?? '';
    const displayName = input?.displayName?.trim() ?? '';
    assert(/^0x[a-fA-F0-9]{40}$/.test(address), 400, 'INVALID_AGENT_ADDRESS', 'agentAddress must be a 20-byte hex address');
    assert(displayName.length >= 2 && displayName.length <= 80, 400, 'INVALID_AGENT_NAME', 'displayName must contain 2..80 characters');
    assert(!this.agents.has(address.toLowerCase()), 409, 'AGENT_ALREADY_EXISTS', `Agent ${address} is already registered`);
    this.ensureAgent(address, displayName);
    if (input.capabilityManifest) return this.updateCapabilities(address, input.capabilityManifest);
    this.emitSnapshot();
    return this.reputation(address);
  }

  private calculateScore(agent: AgentRecord) {
    const volume = Number(agent.totalVolumeStreamed);
    return Math.max(0, Math.min(1000, Math.round(
      SCORE.base +
      agent.completedTasks * SCORE.completionWeight -
      agent.failedTasks * SCORE.failurePenalty +
      Math.log(1 + volume) * SCORE.volumeWeight
    )));
  }

  termsFor(score: number): StreamTerms {
    const tier = REPUTATION_TIERS.find((candidate) => score >= candidate.minScore) ?? REPUTATION_TIERS.at(-1)!;
    return { ...tier.terms };
  }

  reputation(address: string): ReputationSnapshot & { history: { completed: number; failed: number; volume: string; events: ReputationEvent[] } } {
    const agent = this.getRegisteredAgent(address);
    const terms = this.termsFor(agent.score);
    return {
      ...agent,
      terms,
      history: {
        completed: agent.completedTasks,
        failed: agent.failedTasks,
        volume: agent.totalVolumeStreamed,
        events: this.reputationEvents.filter((event) => event.agentAddress.toLowerCase() === address.toLowerCase())
      }
    };
  }

  capabilities(address: string) {
    return structuredClone(this.getRegisteredAgent(address).capabilityManifest);
  }

  updateCapabilities(address: string, input: AgentCapabilityManifest) {
    const manifest = validateCapabilityManifest(input);
    const agent = this.getRegisteredAgent(address);
    agent.capabilityManifest = manifest;
    this.emitSnapshot();
    return structuredClone(manifest);
  }

  addExecutionTrace(agentAddress: string, input: CreateAgentTraceInput) {
    assert(input && typeof input === 'object', 400, 'INVALID_TRACE', 'An execution trace is required');
    const task = this.getTaskMutable(input.taskId);
    assert(task.agentAddress?.toLowerCase() === agentAddress.toLowerCase(), 403, 'TRACE_AGENT_MISMATCH', 'Only the assigned agent may submit this trace');
    assert(['STREAMING', 'PAUSED'].includes(task.status), 409, 'TRACE_TASK_NOT_ACTIVE', 'Execution traces may be submitted only for active tasks');
    assert(![...this.executionTraces.values()].some((trace) => trace.taskId === task.id), 409, 'TRACE_ALREADY_SUBMITTED', 'A trace already exists for this task');
    assert(Array.isArray(input.messages) && input.messages.length >= 2 && input.messages.length <= 128,
      400, 'INVALID_TRACE_MESSAGES', 'messages must contain 2..128 visible trajectory events');
    const messageCharacters = input.messages.reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : 0), 0);
    assert(messageCharacters > 0 && messageCharacters <= 100_000 && input.messages.every((message) =>
      message && ['user', 'assistant', 'tool'].includes(message.role) && typeof message.content === 'string' && message.content.trim().length > 0),
    400, 'INVALID_TRACE_MESSAGE', 'Trace messages require visible user, assistant, or tool content and must fit within 100000 characters');
    assert(typeof input.deliverableSummary === 'string' && input.deliverableSummary.trim().length >= 12 && input.deliverableSummary.length <= 5_000,
      400, 'INVALID_DELIVERABLE_SUMMARY', 'deliverableSummary must contain 12..5000 characters');
    const toolCalls = input.toolCalls ?? [];
    assert(Array.isArray(toolCalls) && toolCalls.length <= 128 && toolCalls.every((call) =>
      call && typeof call.name === 'string' && call.name.length > 0 &&
      /^sha256:[a-f0-9]{64}$/i.test(call.inputHash) && /^sha256:[a-f0-9]{64}$/i.test(call.outputHash) &&
      ['SUCCESS', 'ERROR'].includes(call.status) && Number.isInteger(call.durationMs) && call.durationMs >= 0 && call.durationMs <= 86_400_000),
    400, 'INVALID_TOOL_TRACE', 'Tool traces require a name, SHA-256 input/output hashes, status, and bounded duration');
    const evidence = input.evidence ?? [];
    assert(Array.isArray(evidence) && evidence.length <= 32 && evidence.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 2_000),
      400, 'INVALID_TRACE_EVIDENCE', 'evidence must contain up to 32 bounded references');
    const trace: AgentExecutionTrace = {
      id: randomUUID(),
      taskId: task.id,
      agentAddress,
      messages: structuredClone(input.messages),
      toolCalls: structuredClone(toolCalls),
      deliverableSummary: input.deliverableSummary.trim(),
      evidence: [...evidence],
      consentToTraining: input.consentToTraining === true,
      provider: input.provider?.trim() || 'external-agent',
      reviewStatus: 'PENDING',
      reviewedAt: null,
      reviewerId: null,
      outcome: 'PENDING',
      createdAt: nowSeconds(),
      finalizedAt: null
    };
    this.executionTraces.set(trace.id, trace);
    this.emitSnapshot();
    return structuredClone(trace);
  }

  trainingTraces() {
    return [...this.executionTraces.values()]
      .filter((trace) => trace.consentToTraining && trace.outcome === 'SUCCESS' && trace.reviewStatus === 'APPROVED')
      .map((trace) => structuredClone(trace));
  }

  trainingReviewQueue() {
    return [...this.executionTraces.values()]
      .filter((trace) => trace.consentToTraining && trace.outcome !== 'PENDING')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((trace) => structuredClone(trace));
  }

  reviewTrainingTrace(id: string, status: 'APPROVED' | 'REJECTED', reviewerId: string) {
    const trace = this.executionTraces.get(id);
    assert(trace, 404, 'TRACE_NOT_FOUND', `Trace ${id} was not found`);
    assert(trace.consentToTraining, 409, 'TRACE_NO_CONSENT', 'This trace has no training consent');
    assert(trace.outcome !== 'PENDING', 409, 'TRACE_NOT_FINALIZED', 'Only a finalized trace may be reviewed');
    assert(trace.reviewStatus === 'PENDING', 409, 'TRACE_ALREADY_REVIEWED', 'This trace already has a review decision');
    assert(['APPROVED', 'REJECTED'].includes(status), 400, 'INVALID_TRACE_REVIEW', 'status must be APPROVED or REJECTED');
    trace.reviewStatus = status;
    trace.reviewedAt = nowSeconds();
    trace.reviewerId = reviewerId;
    this.emitSnapshot();
    return structuredClone(trace);
  }

  trainingStatus() {
    const traces = [...this.executionTraces.values()];
    const eligibleSuccessfulTraces = traces.filter((trace) => trace.consentToTraining && trace.outcome === 'SUCCESS' && trace.reviewStatus === 'APPROVED').length;
    return {
      baseModel: 'Qwen/Qwen3.5-2B',
      method: 'QLORA_SFT_ASSISTANT_ONLY' as const,
      minimumReleaseTraces: 200,
      recommendedTraces: 2_000,
      totalSubmittedTraces: traces.length,
      eligibleSuccessfulTraces,
      pendingTraces: traces.filter((trace) => trace.outcome === 'PENDING').length,
      failedTraces: traces.filter((trace) => trace.outcome === 'FAILURE').length,
      pendingReviewTraces: traces.filter((trace) => trace.consentToTraining && trace.outcome !== 'PENDING' && trace.reviewStatus === 'PENDING').length,
      readyForSmokeTraining: eligibleSuccessfulTraces >= 20,
      readyForReleaseTraining: eligibleSuccessfulTraces >= 200
    };
  }

  listArenaTemplates(agentAddress?: string): ArenaTemplate[] {
    const address = agentAddress?.trim().toLowerCase();
    if (address) assert(this.agents.has(address), 404, 'ARENA_AGENT_NOT_FOUND', 'The selected agent is not registered');
    const today = utcDayKey();
    return [...this.arenaTemplates.values()]
      .filter((template) => template.isActive)
      .map((template) => {
        const todayAttempt = address
          ? [...this.arenaAttempts.values()].find((attempt) =>
            attempt.agentAddress.toLowerCase() === address && attempt.templateId === template.id && attempt.dayKey === today)
          : undefined;
        const completedToday = todayAttempt?.status === 'SUBMITTED';
        const inProgressToday = todayAttempt?.status === 'STARTED';
        return publicTemplate(template, completedToday, inProgressToday);
      });
  }

  startArenaAttempt(templateId: string, agentAddress: string): ArenaChallenge {
    const template = this.arenaTemplates.get(templateId);
    assert(template?.isActive, 404, 'ARENA_TEMPLATE_NOT_FOUND', 'Active arena template not found');
    const normalizedAddress = agentAddress.trim().toLowerCase();
    assert(this.agents.has(normalizedAddress), 404, 'ARENA_AGENT_NOT_FOUND', 'The selected agent is not registered');
    const dayKey = utcDayKey();
    const existingAttempt = [...this.arenaAttempts.values()].find((attempt) =>
      attempt.agentAddress.toLowerCase() === normalizedAddress && attempt.templateId === templateId && attempt.dayKey === dayKey);
    assert(!existingAttempt || existingAttempt.status === 'STARTED',
      409, 'ARENA_DAILY_ATTEMPT_USED', 'This agent has already submitted today\'s attempt for this challenge');

    // Opening a challenge is not a completion. If the user closes the modal or
    // refreshes the page, issue a new bearer token for the same STARTED attempt
    // so it can be safely resumed without creating a second daily attempt.
    const attemptToken = randomBytes(32).toString('hex');
    if (existingAttempt) {
      existingAttempt.tokenHash = sha256(attemptToken);
      this.emitSnapshot();
      const templateRecord = this.arenaTemplates.get(existingAttempt.templateId)!;
      return {
        attemptId: existingAttempt.id,
        attemptToken,
        templateId: existingAttempt.templateId,
        templateTitle: templateRecord.title,
        kind: templateRecord.kind,
        dayKey: existingAttempt.dayKey,
        agentAddress: existingAttempt.agentAddress,
        payload: publicArenaPayload(existingAttempt.privateInstance),
        generatorVersion: ARENA_GENERATOR_VERSION,
        rubricVersion: ARENA_RUBRIC_VERSION,
        instanceCommitment: existingAttempt.instanceCommitment,
        startedAt: existingAttempt.startedAt
      };
    }
    const startedAt = nowSeconds();
    const attemptId = randomUUID();
    const generated = createArenaInstance({
      kind: template.kind,
      dayKey,
      templateId,
      agentAddress: normalizedAddress,
      attemptId
    });
    const attempt: ArenaAttemptRecord = {
      id: attemptId,
      templateId,
      agentAddress: this.agents.get(normalizedAddress)!.agentAddress,
      dayKey,
      tokenHash: sha256(attemptToken),
      status: 'STARTED',
      startedAt,
      submittedAt: null,
      privateInstance: generated.instance,
      instanceCommitment: generated.commitment,
      submission: null,
      trainingConsent: false,
      result: null
    };
    this.arenaAttempts.set(attempt.id, attempt);
    this.emitSnapshot();
    return {
      attemptId: attempt.id,
      attemptToken,
      templateId,
      templateTitle: template.title,
      kind: template.kind,
      dayKey,
      agentAddress: attempt.agentAddress,
      payload: publicArenaPayload(generated.instance),
      generatorVersion: ARENA_GENERATOR_VERSION,
      rubricVersion: ARENA_RUBRIC_VERSION,
      instanceCommitment: generated.commitment,
      startedAt
    };
  }

  async submitArenaAttempt(id: string, input: {
    attemptToken: string;
    agentAddress: string;
    submission: ArenaSubmission;
    consentToTraining?: boolean;
  }, services: { codeRunner: ArenaCodeRunner; qualityJudge: ArenaQualityJudge; platformPoints?: PlatformPointsService | null }): Promise<ArenaEvaluationResult> {
    const attempt = this.arenaAttempts.get(id);
    assert(attempt, 404, 'ARENA_ATTEMPT_NOT_FOUND', 'Arena attempt not found');
    assert(attempt.status === 'STARTED', 409, 'ARENA_ATTEMPT_FINALIZED', 'This arena attempt already has a final result');
    assert(input && typeof input === 'object', 400, 'INVALID_ARENA_SUBMISSION', 'A submission body is required');
    assert(input.agentAddress?.trim().toLowerCase() === attempt.agentAddress.toLowerCase(), 403, 'ARENA_AGENT_MISMATCH', 'Only the assigned agent may submit this attempt');
    assert(typeof input.attemptToken === 'string' && sha256(input.attemptToken) === attempt.tokenHash, 403, 'ARENA_TOKEN_INVALID', 'The private attempt token is invalid');
    const template = this.arenaTemplates.get(attempt.templateId)!;
    const submission = input.submission;
    assert(submission && typeof submission === 'object' && submission.kind === template.kind,
      400, 'ARENA_SUBMISSION_KIND_MISMATCH', 'Submission kind must match the issued challenge');
    const submittedAt = nowSeconds();
    let deterministicScore = 0;
    let criticalChecksPassed = false;
    let checks: ArenaCheckResult[] = [];
    let efficiencyScore: number | null = null;
    let artifactHash: string | null = null;
    let executionDurationMs = Math.max(0, (submittedAt - attempt.startedAt) * 1000);
    let judgeTask = '';
    let judgeSubmission = JSON.stringify(submission);
    let judgeEvidence = '';

    if (attempt.privateInstance.kind === 'GROUNDED_QA' && submission.kind === 'GROUNDED_QA') {
      assert(submission.answer.length <= 2_000 && submission.reasoning.length <= 4_000,
        400, 'ARENA_SUBMISSION_TOO_LARGE', 'Answer and reasoning exceed the grounded QA limits');
      const answerCorrect = Math.abs(parseArenaNumber(submission.answer) - Number(attempt.privateInstance.expectedAnswer)) <= 0.001;
      const recordCorrect = normalizeArenaText(submission.citation?.recordId ?? '') === normalizeArenaText(attempt.privateInstance.expectedRecordId);
      const fieldCorrect = normalizeArenaText(submission.citation?.field ?? '') === normalizeArenaText(attempt.privateInstance.expectedField);
      const reasoningPresent = submission.reasoning.trim().length >= 10;
      checks = [
        { code: 'ANSWER_EXACT', passed: answerCorrect, detail: answerCorrect ? 'Answer matches the private numeric key.' : 'Answer does not match the private numeric key.' },
        { code: 'CITATION_RECORD', passed: recordCorrect, detail: recordCorrect ? 'Citation resolves to the supporting record.' : 'Citation does not resolve to the supporting record.' },
        { code: 'CITATION_FIELD', passed: fieldCorrect, detail: fieldCorrect ? 'Citation identifies the supporting field.' : 'Citation field is incorrect.' },
        { code: 'REASONING_PRESENT', passed: reasoningPresent, detail: reasoningPresent ? 'A bounded explanation was supplied.' : 'Explanation is missing or too short.' }
      ];
      deterministicScore = (answerCorrect ? 60 : 0) + (recordCorrect ? 20 : 0) + (fieldCorrect ? 10 : 0) + (reasoningPresent ? 10 : 0);
      criticalChecksPassed = answerCorrect && recordCorrect && fieldCorrect;
      artifactHash = attempt.privateInstance.payload.dataset.contentHash;
      judgeTask = attempt.privateInstance.payload.question.prompt;
      judgeEvidence = JSON.stringify({
        citedRecord: attempt.privateInstance.payload.dataset.rows.find((row) => row.recordId === submission.citation.recordId) ?? null,
        citation: submission.citation
      });
    } else if (attempt.privateInstance.kind === 'CODE_REPAIR' && submission.kind === 'CODE_REPAIR') {
      assert(submission.reasoning.length <= 4_000, 400, 'ARENA_SUBMISSION_TOO_LARGE', 'Code reasoning exceeds 4000 characters');
      let run;
      try {
        run = await services.codeRunner.evaluate(attempt.privateInstance, submission.files);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Arena sandbox unavailable';
        throw new ApiProblem(503, 'ARENA_SANDBOX_UNAVAILABLE', message.replace(/^ARENA_SANDBOX_UNAVAILABLE:\s*/, ''));
      }
      executionDurationMs = run.durationMs;
      const passedTests = run.tests.filter((test) => test.passed).length;
      const testRatio = run.tests.length ? passedTests / run.tests.length : 0;
      checks = [
        { code: 'SOURCE_POLICY', passed: run.policyPassed, detail: run.policyPassed ? 'Submission passed the container source policy.' : run.stderr || 'Submission failed the source policy.' },
        ...run.tests.map((test, index) => ({
          code: `${test.hidden ? 'HIDDEN' : 'PUBLIC'}_TEST_${index + 1}`,
          passed: test.passed,
          detail: test.hidden ? (test.passed ? 'Hidden case passed.' : 'Hidden case failed.') : `${test.name}: ${test.detail}`
        }))
      ];
      deterministicScore = Math.round((run.policyPassed ? 10 : 0) + testRatio * 90);
      criticalChecksPassed = run.policyPassed && run.tests.length > 0 && passedTests === run.tests.length;
      artifactHash = typeof submission.files?.['index.mjs'] === 'string' ? sha256(submission.files['index.mjs']) : null;
      judgeTask = `${attempt.privateInstance.functionName}: ${attempt.privateInstance.payload.publicTests.join('; ')}`;
      judgeEvidence = JSON.stringify({ runner: run.runner, passedTests, totalTests: run.tests.length, policyPassed: run.policyPassed });
    } else if (attempt.privateInstance.kind === 'TOOL_WORKFLOW' && submission.kind === 'TOOL_WORKFLOW') {
      assert(submission.reasoning.length <= 4_000, 400, 'ARENA_SUBMISSION_TOO_LARGE', 'Tool-workflow reasoning exceeds 4000 characters');
      const artifactCorrect = Boolean(attempt.privateInstance.artifactHash && submission.artifactHash === attempt.privateInstance.artifactHash);
      const successfulTools = attempt.privateInstance.calls.filter((call) => call.ok).map((call) => call.tool);
      const requiredSequence = ['fetch_orders', 'normalize_orders', 'publish_report'];
      let cursor = 0;
      for (const tool of successfulTools) if (tool === requiredSequence[cursor]) cursor += 1;
      const sequenceCorrect = cursor === requiredSequence.length && attempt.privateInstance.stage === 3;
      const minimumCalls = attempt.privateInstance.calls.length >= 3;
      const reasoningPresent = submission.reasoning.trim().length >= 10;
      checks = [
        { code: 'ARTIFACT_MATCH', passed: artifactCorrect, detail: artifactCorrect ? 'Submitted hash matches the server-published artifact.' : 'Artifact hash is missing or does not match.' },
        { code: 'CAUSAL_TOOL_SEQUENCE', passed: sequenceCorrect, detail: sequenceCorrect ? 'Fetch, normalize, and publish receipts form a valid chain.' : 'Required causal tool sequence is incomplete.' },
        { code: 'MINIMUM_REQUIRED_CALLS', passed: minimumCalls, detail: `${attempt.privateInstance.calls.length} call(s) recorded by the server.` },
        { code: 'REASONING_PRESENT', passed: reasoningPresent, detail: reasoningPresent ? 'A bounded process explanation was supplied.' : 'Process explanation is missing or too short.' }
      ];
      deterministicScore = (artifactCorrect ? 60 : 0) + (sequenceCorrect ? 25 : 0) + (minimumCalls ? 10 : 0) + (reasoningPresent ? 5 : 0);
      criticalChecksPassed = artifactCorrect && sequenceCorrect;
      efficiencyScore = Math.max(0, 100 - Math.max(0, attempt.privateInstance.calls.length - 3) * 15);
      artifactHash = attempt.privateInstance.artifactHash;
      judgeTask = attempt.privateInstance.payload.goal;
      judgeEvidence = JSON.stringify({ artifact: attempt.privateInstance.artifact, calls: attempt.privateInstance.calls });
    } else {
      throw new ApiProblem(400, 'ARENA_SUBMISSION_KIND_MISMATCH', 'Submission does not match the issued private instance');
    }

    const quality = await services.qualityJudge.evaluate({
      kind: template.kind,
      task: judgeTask,
      submission: judgeSubmission,
      validatedEvidence: judgeEvidence,
      deterministicChecks: checks
    });
    const scored = scoreWithCorrectnessGate({ deterministicScore, qualityScore: quality.score, efficiencyScore, criticalChecksPassed });
    const passed = criticalChecksPassed && scored.score >= 80;
    const pointsAwarded = passed ? Math.max(1, Math.round(template.rewardPoints * scored.score / 100)) : 0;
    let pointsReceipt: ArenaEvaluationResult['pointsReceipt'] = {
      mode: services.platformPoints ? 'ARC_TESTNET' : 'OFFCHAIN',
      transactionHash: null,
      contractAddress: null,
      chainId: null,
      agentTotal: null
    };
    if (pointsAwarded > 0) {
      if (services.platformPoints) {
        // The on-chain receipt is obtained before the local score is updated.
        // If Arc rejects the award, the attempt remains STARTED and can be
        // retried without recording a false local success.
        pointsReceipt = await services.platformPoints.award(attempt.agentAddress, pointsAwarded, attempt.id);
      }
      const agent = this.agents.get(attempt.agentAddress.toLowerCase())!;
      agent.platformPoints = (agent.platformPoints ?? 0) + pointsAwarded;
      agent.lastUpdated = submittedAt;
    }
    const result: ArenaEvaluationResult = {
      attemptId: attempt.id,
      templateId: attempt.templateId,
      kind: template.kind,
      dayKey: attempt.dayKey,
      status: passed ? 'PASSED' : 'FAILED',
      score: scored.score,
      deterministicScore,
      qualityScore: quality.score,
      qualityModifier: scored.qualityModifier,
      efficiencyScore,
      efficiencyModifier: scored.efficiencyModifier,
      criticalChecksPassed,
      pointsAwarded,
      pointsReceipt,
      checks,
      judge: {
        provider: quality.provider,
        rubricVersion: ARENA_RUBRIC_VERSION,
        reasoning: quality.reasoning,
        receiptHash: quality.receiptHash
      },
      execution: {
        durationMs: executionDurationMs,
        toolCalls: attempt.privateInstance.kind === 'TOOL_WORKFLOW' ? attempt.privateInstance.calls.length : 0,
        tokensUsed: quality.tokensUsed,
        artifactHash
      },
      submittedAt,
      nextAttemptAt: nextUtcDaySeconds(submittedAt),
      trainingConsent: input.consentToTraining === true
    };
    attempt.status = 'SUBMITTED';
    attempt.submittedAt = submittedAt;
    attempt.submission = structuredClone(submission);
    attempt.trainingConsent = result.trainingConsent;
    attempt.result = structuredClone(result);
    this.emitSnapshot();
    return structuredClone(result);
  }

  executeArenaTool(id: string, attemptToken: string, tool: string, args: Record<string, unknown>) {
    const attempt = this.arenaAttempts.get(id);
    assert(attempt, 404, 'ARENA_ATTEMPT_NOT_FOUND', 'Arena attempt not found');
    assert(attempt.status === 'STARTED', 409, 'ARENA_ATTEMPT_FINALIZED', 'This arena attempt already has a final result');
    assert(sha256(attemptToken) === attempt.tokenHash, 403, 'ARENA_TOKEN_INVALID', 'The private attempt token is invalid');
    assert(attempt.privateInstance.kind === 'TOOL_WORKFLOW', 409, 'ARENA_TOOL_KIND_INVALID', 'This attempt does not expose MCP tools');
    const instance = attempt.privateInstance;
    const started = Date.now();
    const inputHash = sha256(JSON.stringify(args ?? {}));
    const record = (ok: boolean, output: unknown) => {
      const call = {
        tool,
        ok,
        inputHash,
        outputHash: ok ? sha256(JSON.stringify(output)) : null,
        durationMs: Math.max(0, Date.now() - started),
        calledAt: nowSeconds()
      };
      instance.calls.push(call);
      this.emitSnapshot();
      return output;
    };
    try {
      if (tool === 'fetch_orders') {
        return record(true, { rows: structuredClone(instance.sourceRows), sourceReceipt: instance.sourceReceipt });
      }
      if (tool === 'normalize_orders') {
        assert(String(args?.sourceReceipt ?? '') === instance.sourceReceipt, 409, 'ARENA_SOURCE_RECEIPT_INVALID', 'normalize_orders requires the receipt returned by fetch_orders');
        const normalized = instance.sourceRows
          .filter((row) => row.status === 'SETTLED')
          .map((row) => ({ orderId: row.orderId, amountUsdc: (row.amountCents / 100).toFixed(2) }));
        instance.normalized = normalized;
        instance.transformReceipt = sha256(JSON.stringify({ attemptId: id, sourceReceipt: instance.sourceReceipt, normalized }));
        instance.stage = Math.max(instance.stage, 2) as 2 | 3;
        return record(true, { rows: structuredClone(normalized), transformReceipt: instance.transformReceipt });
      }
      if (tool === 'publish_report') {
        assert(instance.normalized && instance.transformReceipt, 409, 'ARENA_TRANSFORM_REQUIRED', 'Run normalize_orders before publish_report');
        assert(String(args?.transformReceipt ?? '') === instance.transformReceipt, 409, 'ARENA_TRANSFORM_RECEIPT_INVALID', 'publish_report requires the receipt returned by normalize_orders');
        assert(args?.format === 'json', 400, 'ARENA_FORMAT_INVALID', 'publish_report format must be json');
        const totalCents = instance.sourceRows.filter((row) => row.status === 'SETTLED').reduce((sum, row) => sum + row.amountCents, 0);
        instance.artifact = {
          schemaVersion: '1.0',
          count: instance.normalized.length,
          totalUsdc: (totalCents / 100).toFixed(2),
          rows: structuredClone(instance.normalized)
        };
        instance.artifactHash = sha256(JSON.stringify(instance.artifact));
        instance.stage = 3;
        return record(true, { artifact: structuredClone(instance.artifact), artifactHash: instance.artifactHash });
      }
      throw new ApiProblem(404, 'ARENA_TOOL_NOT_FOUND', `Unknown arena tool ${tool}`);
    } catch (error) {
      record(false, { error: error instanceof Error ? error.message : 'Tool call failed' });
      throw error;
    }
  }

  arenaLeaderboard(): ArenaLeaderboardEntry[] {
    const rows = [...this.agents.values()].map((agent) => {
      const attempts = [...this.arenaAttempts.values()].filter((attempt) => attempt.agentAddress.toLowerCase() === agent.agentAddress.toLowerCase() && attempt.result);
      const passedAttempts = attempts.filter((attempt) => attempt.result?.status === 'PASSED').length;
      const averageScore = attempts.length ? Math.round(attempts.reduce((sum, attempt) => sum + (attempt.result?.score ?? 0), 0) / attempts.length) : 0;
      return {
        rank: 0,
        agentAddress: agent.agentAddress,
        displayName: agent.displayName,
        platformPoints: agent.platformPoints ?? 0,
        passedAttempts,
        totalAttempts: attempts.length,
        averageScore,
        trackScores: {
          GROUNDED_QA: this.averageArenaTrack(attempts, 'GROUNDED_QA'),
          CODE_REPAIR: this.averageArenaTrack(attempts, 'CODE_REPAIR'),
          TOOL_WORKFLOW: this.averageArenaTrack(attempts, 'TOOL_WORKFLOW')
        }
      };
    }).sort((left, right) => right.platformPoints - left.platformPoints || right.averageScore - left.averageScore || left.agentAddress.localeCompare(right.agentAddress));
    return rows.map((row, index) => ({ ...row, rank: index + 1 }));
  }

  private averageArenaTrack(attempts: ArenaAttemptRecord[], kind: ArenaEvaluationResult['kind']) {
    const track = attempts.filter((attempt) => attempt.result?.kind === kind);
    return track.length ? Math.round(track.reduce((sum, attempt) => sum + (attempt.result?.score ?? 0), 0) / track.length) : null;
  }

  createAgentRun(taskId: string, agentAddress: string, provider: string) {
    const task = this.refresh(this.getTaskMutable(taskId));
    assert(task.agentAddress?.toLowerCase() === agentAddress.toLowerCase(), 403, 'RUN_AGENT_MISMATCH', 'Only the assigned agent may run this task');
    assert(['STREAMING', 'PAUSED'].includes(task.status), 409, 'RUN_TASK_NOT_ACTIVE', 'Agent runs require an active task');
    assert(![...this.deliverables.values()].some((deliverable) => deliverable.taskId === task.id), 409, 'DELIVERABLE_ALREADY_EXISTS', 'This task already has a deliverable');
    const manifest = this.ensureAgent(agentAddress).capabilityManifest;
    const activeRuns = [...this.agentRuns.values()].filter((run) => run.agentAddress.toLowerCase() === agentAddress.toLowerCase() && ['QUEUED', 'PLANNING', 'RUNNING'].includes(run.status));
    assert(activeRuns.length < manifest.maxConcurrentTasks, 409, 'AGENT_CONCURRENCY_LIMIT', `Agent allows ${manifest.maxConcurrentTasks} concurrent task(s)`);
    assert(Number(task.totalAmount) <= Number(manifest.walletPolicy.perTaskLimitUsdc), 403, 'AGENT_WALLET_LIMIT', `Agent wallet policy caps tasks at ${manifest.walletPolicy.perTaskLimitUsdc} USDC`);
    const startedAt = nowSeconds();
    const run: AgentRun = {
      id: randomUUID(),
      taskId,
      agentAddress,
      provider: provider.trim() || 'deterministic-local',
      status: 'PLANNING',
      plan: null,
      steps: [{
        id: randomUUID(),
        kind: 'POLICY',
        label: 'Preflight policy gate',
        status: 'SUCCESS',
        detail: `Assigned identity, concurrency ${activeRuns.length + 1}/${manifest.maxConcurrentTasks}, wallet cap ${manifest.walletPolicy.perTaskLimitUsdc} USDC`,
        inputHash: sha256(JSON.stringify({ taskId, agentAddress, totalAmount: task.totalAmount })),
        outputHash: sha256(JSON.stringify({ allowed: true, manifestVersion: manifest.version })),
        startedAt,
        completedAt: startedAt
      }],
      deliverableId: null,
      error: null,
      startedAt,
      completedAt: null
    };
    this.agentRuns.set(run.id, run);
    this.emitSnapshot();
    return structuredClone(run);
  }

  setAgentRunPlan(id: string, plan: AgentPlan) {
    const run = this.getAgentRunMutable(id);
    assert(run.status === 'PLANNING', 409, 'RUN_NOT_PLANNING', 'Run is not waiting for a plan');
    run.plan = structuredClone(plan);
    run.status = 'RUNNING';
    const timestamp = nowSeconds();
    run.steps.push({
      id: randomUUID(),
      kind: 'PLAN',
      label: 'Execution plan approved',
      status: 'SUCCESS',
      detail: `${plan.steps.length} allowlisted step(s) · evidence: ${plan.expectedEvidence.join(', ')}`,
      inputHash: sha256(plan.objective),
      outputHash: sha256(JSON.stringify(plan)),
      startedAt: timestamp,
      completedAt: timestamp
    });
    this.emitSnapshot();
    return structuredClone(run);
  }

  appendAgentRunStep(id: string, step: Omit<AgentRunStep, 'id'>) {
    const run = this.getAgentRunMutable(id);
    assert(run.status === 'RUNNING', 409, 'RUN_NOT_RUNNING', 'Run is not active');
    run.steps.push({ ...structuredClone(step), id: randomUUID() });
    this.emitSnapshot();
    return structuredClone(run);
  }

  finishAgentRun(id: string, deliverableId: string) {
    const run = this.getAgentRunMutable(id);
    assert(run.status === 'RUNNING', 409, 'RUN_NOT_RUNNING', 'Run is not active');
    run.status = 'SUBMITTED';
    run.deliverableId = deliverableId;
    run.completedAt = nowSeconds();
    this.emitSnapshot();
    return structuredClone(run);
  }

  failAgentRun(id: string, error: string, blocked = false) {
    const run = this.getAgentRunMutable(id);
    run.status = blocked ? 'BLOCKED' : 'FAILED';
    run.error = error.slice(0, 2_000);
    run.completedAt = nowSeconds();
    this.emitSnapshot();
    return structuredClone(run);
  }

  listAgentRuns() {
    return [...this.agentRuns.values()].sort((a, b) => b.startedAt - a.startedAt).map((run) => structuredClone(run));
  }

  getAgentRun(id: string) {
    return structuredClone(this.getAgentRunMutable(id));
  }

  private getAgentRunMutable(id: string) {
    const run = this.agentRuns.get(id);
    assert(run, 404, 'RUN_NOT_FOUND', `Agent run ${id} was not found`);
    return run;
  }

  submitDeliverable(taskId: string, agentAddress: string, input: SubmitDeliverableInput) {
    const task = this.refresh(this.getTaskMutable(taskId));
    assert(task.agentAddress?.toLowerCase() === agentAddress.toLowerCase(), 403, 'DELIVERABLE_AGENT_MISMATCH', 'Only the assigned agent may submit a deliverable');
    assert(['STREAMING', 'PAUSED'].includes(task.status), 409, 'DELIVERABLE_TASK_NOT_ACTIVE', 'Deliverables require an active task');
    assert(![...this.deliverables.values()].some((deliverable) => deliverable.taskId === task.id), 409, 'DELIVERABLE_ALREADY_EXISTS', 'A deliverable already exists for this task');
    assert(typeof input?.summary === 'string' && input.summary.trim().length >= 12 && input.summary.length <= 10_000,
      400, 'INVALID_DELIVERABLE_SUMMARY', 'summary must contain 12..10000 characters');
    assert(Array.isArray(input.artifacts) && input.artifacts.length >= 1 && input.artifacts.length <= 16 && input.artifacts.every((artifact) =>
      artifact && typeof artifact.name === 'string' && artifact.name.length > 0 && artifact.name.length <= 160 &&
      typeof artifact.mediaType === 'string' && artifact.mediaType.length > 0 && artifact.mediaType.length <= 120 &&
      /^sha256:[a-f0-9]{64}$/i.test(artifact.contentHash) && Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes >= 0 && artifact.sizeBytes <= 100_000_000 &&
      (artifact.uri === null || (typeof artifact.uri === 'string' && /^(https?:|ipfs:|ar:)/i.test(artifact.uri))) &&
      (artifact.preview === null || (typeof artifact.preview === 'string' && artifact.preview.length <= 10_000))),
    400, 'INVALID_DELIVERABLE_ARTIFACT', 'Each artifact requires bounded metadata, a SHA-256 hash, and an optional safe URI/preview');
    const evidence = input.evidence ?? [];
    assert(Array.isArray(evidence) && evidence.length >= 1 && evidence.length <= 32 && evidence.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 2_000),
      400, 'INVALID_DELIVERABLE_EVIDENCE', 'evidence must contain 1..32 bounded references');
    const deliverable: AgentDeliverable = {
      id: randomUUID(),
      taskId,
      agentAddress,
      summary: input.summary.trim(),
      artifacts: structuredClone(input.artifacts),
      evidence: [...evidence],
      status: 'SUBMITTED',
      createdAt: nowSeconds(),
      reviewedAt: null
    };
    this.deliverables.set(deliverable.id, deliverable);
    this.emitSnapshot();
    return structuredClone(deliverable);
  }

  listDeliverables() {
    return [...this.deliverables.values()].sort((a, b) => b.createdAt - a.createdAt).map((deliverable) => structuredClone(deliverable));
  }

  getDeliverable(id: string) {
    const deliverable = this.deliverables.get(id);
    assert(deliverable, 404, 'DELIVERABLE_NOT_FOUND', `Deliverable ${id} was not found`);
    return structuredClone(deliverable);
  }

  acceptDeliverable(id: string) {
    const deliverable = this.deliverables.get(id);
    assert(deliverable, 404, 'DELIVERABLE_NOT_FOUND', `Deliverable ${id} was not found`);
    assert(deliverable.status === 'SUBMITTED', 409, 'DELIVERABLE_NOT_REVIEWABLE', 'Deliverable is not awaiting review');
    deliverable.status = 'ACCEPTED';
    deliverable.reviewedAt = nowSeconds();
    const task = this.finalizeSuccessfulTask(deliverable.taskId);
    return { deliverable: structuredClone(deliverable), task };
  }

  recalculate(address: string) {
    const agent = this.getRegisteredAgent(address);
    const previousTerms = this.termsFor(agent.score);
    agent.score = this.calculateScore(agent);
    agent.lastUpdated = nowSeconds();
    this.emitSnapshot();
    return { ...this.reputation(address), previousTerms };
  }

  leaderboard() {
    return [...this.agents.values()]
      .map((agent) => ({ ...agent, terms: this.termsFor(agent.score) }))
      .sort((a, b) => b.score - a.score || a.agentAddress.localeCompare(b.agentAddress));
  }

  createTask(input: CreateTaskInput) {
    assert(input && typeof input === 'object', 400, 'INVALID_BODY', 'A JSON request body is required');
    assert(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 255, 400, 'INVALID_TITLE', 'title must contain 1..255 characters');
    assert(typeof input.creatorAddress === 'string' && /^0x[a-fA-F0-9]{40}$/.test(input.creatorAddress.trim()), 400, 'INVALID_CREATOR', 'creatorAddress must be a 20-byte hex address');
    const total = parseMoney(input.totalAmount, 'totalAmount');
    const estimatedDurationSeconds = input.estimatedDurationSeconds ?? DEFAULT_TASK_DURATION_SECONDS;
    assert(Number.isInteger(estimatedDurationSeconds) && estimatedDurationSeconds > 0 && estimatedDurationSeconds <= 31_536_000, 400, 'INVALID_DURATION', 'estimatedDurationSeconds must be an integer from 1 second to 365 days');
    const description = boundedOptionalText(input.description, 'description', 50_000);
    const successCriteria = boundedOptionalText(input.successCriteria, 'successCriteria', 50_000);
    const workOrder = validateWorkOrderSpec(input.workOrder ?? defaultWorkOrderForTask(input));
    const preferredAgentAddress = input.preferredAgentAddress == null || input.preferredAgentAddress === ''
      ? null
      : input.preferredAgentAddress.trim().toLowerCase();
    if (preferredAgentAddress) {
      assert(/^0x[a-f0-9]{40}$/.test(preferredAgentAddress), 400, 'INVALID_PREFERRED_AGENT', 'preferredAgentAddress must be a 20-byte hex address');
      assert(this.agents.has(preferredAgentAddress), 404, 'AGENT_NOT_REGISTERED', 'The invited agent must be registered before it can be hired');
    }
    const task: MarketplaceTask = {
      id: randomUUID(),
      chainTaskId: null,
      title: input.title.trim(),
      description,
      successCriteria,
      creatorAddress: input.creatorAddress.trim().toLowerCase(),
      preferredAgentAddress,
      agentAddress: null,
      totalAmount: money(total),
      estimatedDurationSeconds,
      streamRatePerSecond: money(total / estimatedDurationSeconds),
      status: 'OPEN',
      collateralLocked: '0',
      accruedAmount: '0',
      withdrawnAmount: '0',
      createdAt: nowSeconds(),
      startedAt: null,
      completedAt: null,
      templateId: input.templateId ?? 'ad-hoc',
      terms: null,
      workOrder,
    };
    this.tasks.set(task.id, task);
    this.emitSnapshot();
    return this.copyTask(task);
  }

  updateTask(id: string, input: UpdateTaskInput) {
    assert(input && typeof input === 'object' && !Array.isArray(input), 400, 'INVALID_BODY', 'A JSON request body is required');
    const task = this.getTaskMutable(id);
    assert(task.status === 'OPEN', 409, 'TASK_NOT_EDITABLE', 'Only open tasks can be edited');
    if (input.title !== undefined) {
      assert(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 255, 400, 'INVALID_TITLE', 'title must contain 1..255 characters');
      task.title = input.title.trim();
    }
    if (input.description !== undefined) task.description = boundedOptionalText(input.description, 'description', 50_000);
    if (input.successCriteria !== undefined) task.successCriteria = boundedOptionalText(input.successCriteria, 'successCriteria', 50_000);
    if (input.totalAmount !== undefined) task.totalAmount = money(parseMoney(input.totalAmount, 'totalAmount'));
    if (input.estimatedDurationSeconds !== undefined) {
      assert(Number.isInteger(input.estimatedDurationSeconds) && input.estimatedDurationSeconds > 0 && input.estimatedDurationSeconds <= 31_536_000, 400, 'INVALID_DURATION', 'estimatedDurationSeconds must be an integer from 1 second to 365 days');
      task.estimatedDurationSeconds = input.estimatedDurationSeconds;
    }
    task.streamRatePerSecond = money(Number(task.totalAmount) / task.estimatedDurationSeconds);
    this.emitSnapshot();
    return this.copyTask(task);
  }

  deleteTask(id: string) {
    const task = this.getTaskMutable(id);
    assert(task.status === 'OPEN', 409, 'TASK_NOT_DELETABLE', 'Only open tasks can be deleted');
    this.tasks.delete(id);
    this.emitSnapshot();
  }

  listTasks(status?: string) {
    const tasks = [...this.tasks.values()].map((task) => this.copyTask(this.refresh(task)));
    return status ? tasks.filter((task) => task.status === status.toUpperCase()) : tasks;
  }

  getTask(id: string) {
    return this.copyTask(this.refresh(this.getTaskMutable(id)));
  }

  private getTaskMutable(id: string) {
    const task = this.tasks.get(id);
    assert(task, 404, 'TASK_NOT_FOUND', `Task ${id} was not found`);
    return task;
  }

  claimTask(id: string, agentAddress: string) {
    assert(/^0x[a-fA-F0-9]{40}$/.test(agentAddress.trim()), 400, 'INVALID_AGENT_ADDRESS', 'agentAddress must be a 20-byte hex address');
    const normalizedAgentAddress = agentAddress.trim().toLowerCase();
    const registeredAgent = this.agents.get(normalizedAgentAddress);
    assert(registeredAgent, 403, 'AGENT_NOT_REGISTERED', 'Register this wallet in the Agent Registry before claiming paid work');
    const task = this.getTaskMutable(id);
    assert(task.status === 'OPEN', 409, 'TASK_NOT_OPEN', 'Task is no longer open');
    assert(!task.preferredAgentAddress || task.preferredAgentAddress === normalizedAgentAddress, 403, 'AGENT_INVITE_ONLY', 'This work order is reserved for the invited agent', { invitedAgentAddress: task.preferredAgentAddress });
    const reputation = this.reputation(registeredAgent.agentAddress);
    const category = task.workOrder?.category ?? inferTaskCategory(task);
    assert(manifestSupportsTaskCategory(reputation.capabilityManifest, category), 403, 'CAPABILITY_MISMATCH',
      `Agent manifest does not declare a capability for this ${category?.toLowerCase() ?? 'work'} brief`,
      { category, capabilities: reputation.capabilityManifest.capabilities.map((capability) => capability.id) });
    assert(manifestSupportsWorkOrder(reputation.capabilityManifest, task.workOrder), 403, 'CAPABILITY_MISMATCH',
      'Agent manifest does not satisfy the capabilities required by this work order',
      { requiredCapabilities: task.workOrder?.requiredCapabilities ?? [], capabilities: reputation.capabilityManifest.capabilities.map((capability) => capability.id) });
    const maximum = reputation.terms.maxTaskSize === null ? Infinity : Number(reputation.terms.maxTaskSize);
    assert(Number(task.totalAmount) <= maximum, 403, 'REPUTATION_TOO_LOW',
      `Agent score ${reputation.score} permits tasks up to ${reputation.terms.maxTaskSize} USDC`,
      { score: reputation.score, maxTaskSize: reputation.terms.maxTaskSize, requiredScore: this.requiredScore(Number(task.totalAmount)) });
    task.agentAddress = registeredAgent.agentAddress;
    task.terms = reputation.terms;
    task.collateralLocked = money(Number(task.totalAmount) * reputation.terms.collateralPct / 100);
    task.status = 'ASSIGNED';
    return this.startStream(id);
  }

  private requiredScore(amount: number) {
    const ascending = [...REPUTATION_TIERS].reverse();
    return ascending.find((tier) => tier.terms.maxTaskSize === null || Number(tier.terms.maxTaskSize) >= amount)?.minScore ?? 701;
  }

  initiateStream(input: CreateTaskInput & { agentAddress: string }) {
    const task = this.createTask(input);
    return this.claimTask(task.id, input.agentAddress);
  }

  startStream(id: string) {
    const task = this.getTaskMutable(id);
    assert(task.agentAddress, 409, 'TASK_UNASSIGNED', 'Task must be claimed before streaming');
    assert(task.status === 'ASSIGNED' || task.status === 'PAUSED', 409, 'STREAM_NOT_STARTABLE', `Cannot start a stream in ${task.status} state`);
    task.status = 'STREAMING';
    task.startedAt ??= nowSeconds();
    this.emitStream(task);
    this.emitSnapshot();
    return this.streamStatus(id);
  }

  streamStatus(id: string) {
    const task = this.refresh(this.getTaskMutable(id));
    const elapsedSeconds = task.startedAt === null ? 0 : Math.max(0, nowSeconds() - task.startedAt);
    return {
      taskId: task.id,
      accruedAmount: task.accruedAmount,
      withdrawnAmount: task.withdrawnAmount,
      availableToWithdraw: money(Number(task.accruedAmount) - Number(task.withdrawnAmount)),
      remainingAmount: money(Number(task.totalAmount) - Number(task.accruedAmount)),
      collateralLocked: task.collateralLocked,
      status: task.status,
      elapsedSeconds,
      terms: task.terms
    };
  }

  withdraw(id: string) {
    const task = this.refresh(this.getTaskMutable(id));
    assert(task.agentAddress, 409, 'TASK_UNASSIGNED', 'Task has no agent');
    assert(['STREAMING', 'PAUSED', 'COMPLETED'].includes(task.status), 409, 'STREAM_NOT_WITHDRAWABLE', 'Stream is not withdrawable');
    const amount = Math.max(0, Number(task.accruedAmount) - Number(task.withdrawnAmount));
    assert(amount > 0, 409, 'NOTHING_TO_WITHDRAW', 'No streamed funds are currently available');
    task.withdrawnAmount = money(Number(task.withdrawnAmount) + amount);
    this.emitStream(task);
    this.emitSnapshot();
    return { withdrawnNow: money(amount), ...this.streamStatus(id) };
  }

  completeTask(id: string) {
    const deliverable = [...this.deliverables.values()].find((candidate) => candidate.taskId === id && candidate.status === 'SUBMITTED');
    assert(deliverable, 409, 'DELIVERABLE_REQUIRED', 'A submitted deliverable with evidence is required before completion');
    return this.acceptDeliverable(deliverable.id).task;
  }

  private finalizeSuccessfulTask(id: string) {
    const task = this.refresh(this.getTaskMutable(id));
    assert(task.status === 'STREAMING' || task.status === 'PAUSED', 409, 'TASK_NOT_COMPLETABLE', 'Task is not active');
    task.status = 'COMPLETED';
    task.accruedAmount = task.totalAmount;
    task.collateralLocked = '0';
    task.completedAt = nowSeconds();
    this.recordOutcome(task, true, Number(task.totalAmount));
    this.emitStream(task);
    this.emitSnapshot();
    return this.copyTask(task);
  }

  private refresh(task: MarketplaceTask) {
    if (task.status === 'STREAMING' && task.startedAt !== null) {
      const elapsed = Math.max(0, nowSeconds() - task.startedAt);
      task.accruedAmount = money(Math.min(Number(task.totalAmount), elapsed * Number(task.streamRatePerSecond)));
    }
    return task;
  }

  private recordOutcome(task: MarketplaceTask, success: boolean, volume: number) {
    if (!task.agentAddress) return;
    const alreadyRecorded = this.reputationEvents.some((event) => event.taskId === task.id);
    if (alreadyRecorded) return;
    const agent = this.ensureAgent(task.agentAddress);
    if (success) agent.completedTasks += 1;
    else agent.failedTasks += 1;
    agent.totalVolumeStreamed = money(Number(agent.totalVolumeStreamed) + volume);
    this.reputationEvents.push({
      id: randomUUID(),
      agentAddress: task.agentAddress,
      taskId: task.id,
      success,
      volumeStreamed: money(volume),
      timestamp: nowSeconds()
    });
    agent.score = this.calculateScore(agent);
    agent.lastUpdated = nowSeconds();
    const trace = [...this.executionTraces.values()].find((candidate) => candidate.taskId === task.id);
    if (trace && trace.outcome === 'PENDING') {
      trace.outcome = success ? 'SUCCESS' : 'FAILURE';
      trace.finalizedAt = nowSeconds();
    }
  }

  createDispute(taskId: string, reason: string, evidence: string, decision: ArbitrationDecision) {
    const task = this.refresh(this.getTaskMutable(taskId));
    assert(task.status === 'STREAMING' || task.status === 'PAUSED', 409, 'TASK_NOT_DISPUTABLE', 'Only an active task can be disputed');
    assert(typeof reason === 'string' && reason.trim().length > 0, 400, 'INVALID_REASON', 'reason is required');
    assert(typeof evidence === 'string' && evidence.trim().length > 0, 400, 'INVALID_EVIDENCE', 'evidence is required');
    task.status = 'DISPUTED';
    const deliverable = [...this.deliverables.values()].find((candidate) => candidate.taskId === taskId && candidate.status === 'SUBMITTED');
    if (deliverable) {
      deliverable.status = 'DISPUTED';
      deliverable.reviewedAt = nowSeconds();
    }
    const { verdict, reasoning } = decision;
    assert(verdict !== null || (decision.needsHumanReview && decision.receipt), 500, 'INVALID_ARBITRATION_DECISION', 'An unresolved arbitration decision requires a review receipt');
    const slashPct = verdict === null ? null : VERDICT_SLASH_PCT[verdict];
    const dispute: Dispute = {
      id: randomUUID(),
      taskId,
      reason,
      evidence,
      status: verdict === null ? 'NEEDS_HUMAN_REVIEW' : 'RESOLVED',
      verdict,
      slashPct,
      reasoning,
      arbitratorProvider: decision.provider ?? null,
      decisionConfidence: decision.confidence ?? null,
      arbitrationReceipt: decision.receipt ?? null,
      humanReview: null,
      createdAt: nowSeconds(),
      resolvedAt: verdict === null ? null : nowSeconds()
    };
    this.disputes.set(dispute.id, dispute);
    if (verdict === null) {
      this.emitStream(task);
      this.emitSnapshot();
      return { ...dispute };
    } else if (verdict === 'NO_FAULT') {
      task.status = 'COMPLETED';
      task.accruedAmount = task.totalAmount;
      task.collateralLocked = '0';
      task.completedAt = nowSeconds();
      this.recordOutcome(task, true, Number(task.totalAmount));
    } else {
      task.status = 'SLASHED';
      task.collateralLocked = money(Number(task.collateralLocked) * (100 - VERDICT_SLASH_PCT[verdict]) / 100);
      task.completedAt = nowSeconds();
      this.recordOutcome(task, false, Number(task.accruedAmount));
    }
    this.emitStream(task);
    this.emitSnapshot();
    return { ...dispute };
  }

  finalizeHumanReview(id: string, verdict: DisputeVerdict, reasoning: string, reviewerId: string) {
    const dispute = this.disputes.get(id);
    assert(dispute, 404, 'DISPUTE_NOT_FOUND', `Dispute ${id} was not found`);
    assert(dispute.status === 'NEEDS_HUMAN_REVIEW', 409, 'DISPUTE_ALREADY_FINALIZED', 'This dispute is not awaiting human review');
    assert(['NO_FAULT', 'PARTIAL_FAULT', 'FULL_FAULT'].includes(verdict), 400, 'INVALID_VERDICT', 'verdict must be NO_FAULT, PARTIAL_FAULT, or FULL_FAULT');
    assert(typeof reasoning === 'string' && reasoning.trim().length > 0, 400, 'INVALID_REASONING', 'reasoning is required');
    assert(reasoning.length <= 2_000, 413, 'REASONING_TOO_LARGE', 'reasoning must fit within 2000 characters');
    const task = this.getTaskMutable(dispute.taskId);
    assert(task.status === 'DISPUTED', 409, 'TASK_NOT_AWAITING_REVIEW', 'The task is not awaiting dispute review');

    const reviewedAt = nowSeconds();
    const normalizedReasoning = reasoning.trim();
    const reasoningHash = sha256(normalizedReasoning);
    const councilDecisionHash = dispute.arbitrationReceipt?.decisionHash ?? 'none';
    dispute.status = 'RESOLVED';
    dispute.verdict = verdict;
    dispute.slashPct = VERDICT_SLASH_PCT[verdict];
    dispute.reasoning = normalizedReasoning;
    dispute.resolvedAt = reviewedAt;
    dispute.humanReview = {
      reviewerId,
      reviewedAt,
      verdict,
      reasoningHash,
      councilDecisionHash,
      decisionHash: sha256(JSON.stringify({
        disputeId: dispute.id,
        taskId: dispute.taskId,
        reviewerId,
        reviewedAt,
        verdict,
        reasoningHash,
        councilDecisionHash
      }))
    };

    if (verdict === 'NO_FAULT') {
      task.status = 'COMPLETED';
      task.accruedAmount = task.totalAmount;
      task.collateralLocked = '0';
      task.completedAt = reviewedAt;
      this.recordOutcome(task, true, Number(task.totalAmount));
    } else {
      task.status = 'SLASHED';
      task.collateralLocked = money(Number(task.collateralLocked) * (100 - VERDICT_SLASH_PCT[verdict]) / 100);
      task.completedAt = reviewedAt;
      this.recordOutcome(task, false, Number(task.accruedAmount));
    }
    this.emitStream(task);
    this.emitSnapshot();
    return { ...dispute };
  }

  listDisputes() {
    return [...this.disputes.values()].map((dispute) => ({ ...dispute }));
  }

  getDispute(id: string) {
    const dispute = this.disputes.get(id);
    assert(dispute, 404, 'DISPUTE_NOT_FOUND', `Dispute ${id} was not found`);
    return { ...dispute };
  }

  seedVeteran(successes = 8) {
    assert(Number.isInteger(successes) && successes > 0 && successes <= 100, 400, 'INVALID_SEED_COUNT', 'successes must be an integer between 1 and 100');
    const veteran = this.ensureAgent(DEMO_ADDRESSES.veteran, 'Agent Veteran');
    const existingTaskIds = new Set(this.reputationEvents
      .filter((event) => event.agentAddress.toLowerCase() === veteran.agentAddress.toLowerCase())
      .map((event) => event.taskId));
    for (let index = 0; index < successes; index += 1) {
      const taskId = `seed-${index + 1}`;
      if (existingTaskIds.has(taskId)) continue;
      veteran.completedTasks += 1;
      veteran.totalVolumeStreamed = money(Number(veteran.totalVolumeStreamed) + 250);
      this.reputationEvents.push({
        id: randomUUID(),
        agentAddress: veteran.agentAddress,
        taskId,
        success: true,
        volumeStreamed: '250',
        timestamp: nowSeconds() - (successes - index)
      });
    }
    veteran.score = this.calculateScore(veteran);
    veteran.lastUpdated = nowSeconds();
    this.emitSnapshot();
    return this.reputation(veteran.agentAddress);
  }

  seedMarketplace() {
    this.seedVeteran(8);
    const workOrderForTemplate = (id: (typeof WORK_ORDER_TEMPLATES)[number]['id']): Partial<WorkOrderSpec> => {
      const template = WORK_ORDER_TEMPLATES.find((candidate) => candidate.id === id)!;
      return {
        templateId: template.id,
        category: template.category,
        inputRequirements: template.inputRequirements,
        deliverableFormat: template.deliverableFormat,
        acceptanceChecklist: template.acceptanceChecklist,
        sourceUrl: null,
        requiredCapabilities: template.requiredCapabilities,
      };
    };
    const showcaseTasks: CreateTaskInput[] = [
      {
        title: 'Create the PACT presentation video',
        description: 'Produce a sharp 90-second launch video that explains the trust problem, Newbie versus Veteran economics, the Agent Workbench, streaming USDC, and the dispute council.',
        successCriteria: 'Deliver 1920x1080 MP4, 75-90 seconds, English captions, voice-over, PACT visual identity, six named product beats, and a SHA-256 export receipt.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '400',
        estimatedDurationSeconds: 900,
        workOrder: workOrderForTemplate('CONTENT_PACK')
      },
      {
        title: 'Audit Agent Wallet spending policy',
        description: 'Review the declared Circle Agent Wallet limits and identify privilege, chain, amount, and approval-boundary risks.',
        successCriteria: 'Return a severity-ranked Markdown report, policy diff, five abuse cases, recommended limits, and evidence hashes.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '800',
        estimatedDurationSeconds: 1800,
        workOrder: workOrderForTemplate('SECURITY_REVIEW')
      },
      {
        title: 'Research autonomous-agent payment competitors',
        description: 'Compare five current agent-payment or escrow products against PACT reputation-gated streaming.',
        successCriteria: 'Return a sourced comparison table, positioning summary, unknowns, citation manifest, and JSON export.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '250',
        estimatedDurationSeconds: 1200,
        workOrder: workOrderForTemplate('RESEARCH_BRIEF')
      },
      {
        title: 'Validate Arc deployment readiness',
        description: 'Inspect the contract deployment package, environment requirements, and operational handoff for Arc Testnet.',
        successCriteria: 'Return a deployment checklist, contract/test receipts, unresolved blockers, rollback steps, and artifact hashes.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '1200',
        estimatedDurationSeconds: 2400,
        workOrder: workOrderForTemplate('CODE_CHANGE')
      },
      {
        title: 'Verify the PACT evidence pack',
        description: 'Review a demo agent deliverable against its acceptance criteria and produce a compact proof manifest for customer approval.',
        successCriteria: 'Return a criteria matrix, artifact SHA-256 receipt, missing-evidence list, explicit pass/fail recommendation, and no unsupported external claims.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '300',
        estimatedDurationSeconds: 420,
        workOrder: { ...workOrderForTemplate('SECURITY_REVIEW'), requiredCapabilities: ['evidence verification'] }
      },
      {
        title: 'Red-team the dispute council',
        description: 'Design adversarial cases for prompt injection, conflicting evidence, judge collusion, and a valid three-way split.',
        successCriteria: 'Return eight test cases, expected verdicts, one NEEDS_HUMAN_REVIEW case, attack rationale, and a machine-readable JSON fixture.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '450',
        estimatedDurationSeconds: 900,
        workOrder: workOrderForTemplate('SECURITY_REVIEW')
      },
      {
        title: 'Write the Arc Testnet operator runbook',
        description: 'Turn the deployment handoff into a step-by-step operator document covering wallets, contract addresses, writer authorization, funding, and rollback.',
        successCriteria: 'Return ordered commands, required environment variables, preflight checks, transaction receipt slots, rollback steps, and owner sign-off gates.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '900',
        estimatedDurationSeconds: 1500,
        workOrder: workOrderForTemplate('CODE_CHANGE')
      },
      {
        title: 'Prepare marketplace onboarding copy',
        description: 'Create concise onboarding copy that explains escrow, reputation-priced terms, deliverables, and disputes to a first-time customer.',
        successCriteria: 'Return hero copy, four onboarding steps, six tooltip definitions, two risk disclosures, and an English caption-ready Markdown artifact.',
        creatorAddress: DEMO_ADDRESSES.creator,
        totalAmount: '180',
        estimatedDurationSeconds: 480,
        workOrder: workOrderForTemplate('CONTENT_PACK')
      }
    ];
    for (const task of showcaseTasks) {
      const existing = this.listTasks().find((candidate) => candidate.title === task.title);
      if (!existing) {
        this.createTask(task);
      } else if (existing.status === 'OPEN' && task.workOrder && !existing.workOrder?.templateId) {
        // Upgrade legacy demo rows in place without touching funded or active work.
        this.getTaskMutable(existing.id).workOrder = validateWorkOrderSpec(task.workOrder);
        this.emitSnapshot();
      }
    }
    return this.dashboard();
  }

  runScenario() {
    this.reset();
    const veteran = this.seedVeteran(8);
    const newbieTask = this.createTask({
      title: 'Newbie verification task',
      description: 'Call a deterministic verification API.',
      successCriteria: 'Return the expected proof.',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '500',
      estimatedDurationSeconds: 120
    });
    const veteranTask = this.createTask({
      title: 'Veteran high-value task',
      description: 'Process a high-value agent workflow.',
      successCriteria: 'Return a verifiable completion proof.',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '500',
      estimatedDurationSeconds: 120
    });
    const platformTask = this.createTask({
      title: 'Platform orchestration task',
      description: 'Analyze ongoing tasks and prepare a platform state summary with dispute resolution recommendations.',
      successCriteria: 'Return a verifiable JSON orchestration audit log.',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '1000',
      estimatedDurationSeconds: 600
    });
    const newbieStream = this.claimTask(newbieTask.id, DEMO_ADDRESSES.newbie);
    const veteranStream = this.claimTask(veteranTask.id, DEMO_ADDRESSES.veteran);
    // Keep the orchestration order open in the demo: the platform coordinator is
    // shown in the comparison but does not consume a customer-funded stream.
    const platformStream = null;
    return {
      message: 'Demo scenario is live with Platform Orchestrator',
      comparison: {
        newbie: { reputation: this.reputation(DEMO_ADDRESSES.newbie), task: this.getTask(newbieTask.id), stream: newbieStream },
        veteran: { reputation: veteran, task: this.getTask(veteranTask.id), stream: veteranStream },
        platform: { reputation: this.reputation(DEMO_ADDRESSES.platformAgent), task: this.getTask(platformTask.id), stream: platformStream }
      },
      dashboard: this.dashboard()
    };
  }

  dashboard(): DashboardSnapshot {
    const tasks = this.listTasks();
    const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
    const activeStreams = tasks.filter((task) => task.status === 'STREAMING').length;
    const totalVolume = [...this.agents.values()].reduce((sum, agent) => sum + Number(agent.totalVolumeStreamed), 0);
    const protectedValue = tasks
      .filter((task) => !['COMPLETED', 'SLASHED'].includes(task.status))
      .reduce((sum, task) => sum + Number(task.totalAmount) + Number(task.collateralLocked), 0);
    return {
      tasks,
      agents: this.leaderboard(),
      disputes: this.listDisputes(),
      agentRuns: this.listAgentRuns(),
      deliverables: this.listDeliverables(),
      metrics: { totalVolume: money(totalVolume), activeStreams, completedTasks, protectedValue: money(protectedValue) },
      mode: 'demo'
    };
  }

  tick() {
    for (const task of this.tasks.values()) {
      if (task.status === 'STREAMING') this.emitStream(this.refresh(task));
    }
  }

  private copyTask(task: MarketplaceTask): MarketplaceTask {
    return {
      ...task,
      terms: task.terms ? { ...task.terms } : null,
      workOrder: task.workOrder ? {
        ...task.workOrder,
        acceptanceChecklist: [...task.workOrder.acceptanceChecklist],
        requiredCapabilities: [...task.workOrder.requiredCapabilities],
      } : undefined,
    };
  }

  private emitStream(task: MarketplaceTask) {
    const event: StoreEvent = { type: 'stream', taskId: task.id, status: this.streamStatus(task.id) };
    for (const listener of this.listeners) listener(event);
  }

  private emitSnapshot() {
    const saved = this.persistence?.save(this.serialize());
    if (isPromiseLike<void>(saved)) saved.catch((error) => console.error('PACT persistence save failed', error));
    if (this.listeners.size === 0) return;
    const event: StoreEvent = { type: 'snapshot', snapshot: this.dashboard() };
    for (const listener of this.listeners) listener(event);
  }

  private serialize(): PersistedDemoState {
    return {
      version: 1,
      tasks: [...this.tasks.values()].map((task) => this.copyTask(task)),
      agents: [...this.agents.values()].map((agent) => ({ ...agent })),
      disputes: [...this.disputes.values()].map((dispute) => ({ ...dispute })),
      reputationEvents: this.reputationEvents.map((event) => ({ ...event })),
      executionTraces: [...this.executionTraces.values()].map((trace) => structuredClone(trace)),
      agentRuns: [...this.agentRuns.values()].map((run) => structuredClone(run)),
      deliverables: [...this.deliverables.values()].map((deliverable) => structuredClone(deliverable)),
      arenaTemplates: [...this.arenaTemplates.values()].map((template) => structuredClone(template)),
      arenaAttempts: [...this.arenaAttempts.values()].map((attempt) => structuredClone(attempt))
    };
  }

  private hydrate(state: PersistedDemoState) {
    this.tasks = new Map(state.tasks.map((task) => [task.id, this.copyTask({
      ...task,
      // Persisted demo databases created before the work envelope existed are
      // upgraded on read, so old listings remain understandable and claimable.
      workOrder: task.workOrder ?? validateWorkOrderSpec(defaultWorkOrderForTask(task)),
    })]));
    this.agents = new Map(state.agents.map((agent) => [agent.agentAddress.toLowerCase(), {
      ...agent,
      platformPoints: agent.platformPoints ?? 0,
      capabilityManifest: agent.capabilityManifest ?? defaultCapabilityManifest(agent.agentAddress)
    }]));
    this.disputes = new Map(state.disputes.map((dispute) => [dispute.id, { ...dispute }]));
    this.reputationEvents = state.reputationEvents.map((event) => ({ ...event }));
    this.executionTraces = new Map((state.executionTraces ?? []).map((trace) => [trace.id, structuredClone({
      ...trace,
      provider: trace.provider ?? 'legacy-external-agent',
      reviewStatus: trace.reviewStatus ?? 'PENDING',
      reviewedAt: trace.reviewedAt ?? null,
      reviewerId: trace.reviewerId ?? null
    })]));
    this.agentRuns = new Map((state.agentRuns ?? []).map((run) => [run.id, structuredClone(run)]));
    this.deliverables = new Map((state.deliverables ?? []).map((deliverable) => [deliverable.id, structuredClone(deliverable)]));
    // Arena v2 is generator-backed. Legacy document challenges and attempts do
    // not carry the private instance required by the new deterministic judge,
    // so only valid v2 attempts survive an upgrade.
    this.arenaTemplates = new Map(BUILT_IN_ARENA_TEMPLATES.map((template) => [template.id, structuredClone(template)]));
    const v2Attempts = (state.arenaAttempts ?? []).filter((attempt) => attempt.privateInstance && attempt.instanceCommitment);
    this.arenaAttempts = new Map(v2Attempts.map((attempt) => [attempt.id, structuredClone(attempt)]));
    this.ensureAgent(DEMO_ADDRESSES.newbie, 'Agent Newbie');
    this.ensureAgent(DEMO_ADDRESSES.veteran, 'Agent Veteran');
    this.ensureAgent(DEMO_ADDRESSES.proofAgent, 'PACT Proof Agent');
    this.ensureAgent(DEMO_ADDRESSES.platformAgent, 'Platform Coordinator Agent');
  }
}

export const demoStore = new DemoStore();
