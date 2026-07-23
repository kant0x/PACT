export type PayoutSpeed = 'SLOW' | 'MEDIUM' | 'FAST';
export type TaskStatus = 'OPEN' | 'ASSIGNED' | 'STREAMING' | 'PAUSED' | 'COMPLETED' | 'DISPUTED' | 'SLASHED';
export type DisputeVerdict = 'NO_FAULT' | 'PARTIAL_FAULT' | 'FULL_FAULT';

/** Internal stream-rate default when a creator leaves the delivery window blank. */
export const DEFAULT_TASK_DURATION_SECONDS = 86_400;

export interface ArbitrationVoteReceipt {
  judgeId: string;
  provider: string;
  verdict: DisputeVerdict;
  confidence: number;
  reasoningHash: string;
}

export interface ArbitrationReceipt {
  policyVersion: string;
  evidenceHash: string;
  decisionHash: string;
  quorumRequired: number;
  votesReceived: number;
  agreeingVotes: number;
  votes: ArbitrationVoteReceipt[];
}

export interface HumanReviewReceipt {
  reviewerId: string;
  reviewedAt: number;
  verdict: DisputeVerdict;
  reasoningHash: string;
  councilDecisionHash: string;
  decisionHash: string;
}

export interface AgentReputationScore {
  agentAddress: string;
  displayName: string;
  score: number;
  completedTasks: number;
  failedTasks: number;
  totalVolumeStreamed: string;
  platformPoints: number;
  lastUpdated: number;
}

export type CapabilityVerification = 'SELF_DECLARED' | 'DEMO_VERIFIED' | 'EXTERNAL_ATTESTATION';

export interface AgentCapability {
  id: string;
  label: string;
  description: string;
  inputTypes: string[];
  outputTypes: string[];
  verification: CapabilityVerification;
}

export interface AgentWalletPolicy {
  allowedChains: string[];
  allowedActions: string[];
  perTaskLimitUsdc: string;
  requiresHumanApprovalAboveUsdc: string | null;
}

/** Public, non-secret binding between an agent profile and the runtime that executes it. */
export interface AgentRuntimeBinding {
  kind: 'OPENCLAW_GATEWAY' | 'EXTERNAL_API';
  gatewayUrl: string | null;
  sandboxRequired: boolean;
}

export interface AgentCapabilityManifest {
  version: string;
  executionMode: 'EXTERNAL_RUNTIME';
  capabilities: AgentCapability[];
  tools: string[];
  evidenceMethods: string[];
  maxConcurrentTasks: number;
  walletPolicy: AgentWalletPolicy;
  runtime?: AgentRuntimeBinding;
  updatedAt: number;
}

export type AgentTaskCategory = 'CREATIVE' | 'SECURITY' | 'RESEARCH' | 'ENGINEERING';

/** Standard job recipes keep the first marketplace tasks objective and easy to arbitrate. */
export type WorkOrderTemplateId =
  | 'RESEARCH_BRIEF'
  | 'DATA_RECONCILIATION'
  | 'CODE_CHANGE'
  | 'SECURITY_REVIEW'
  | 'CONTENT_PACK';

export const WORK_ORDER_TEMPLATE_IDS: readonly WorkOrderTemplateId[] = [
  'RESEARCH_BRIEF',
  'DATA_RECONCILIATION',
  'CODE_CHANGE',
  'SECURITY_REVIEW',
  'CONTENT_PACK',
];

export interface WorkOrderTemplateDefinition {
  id: WorkOrderTemplateId;
  label: string;
  description: string;
  category: AgentTaskCategory;
  title: string;
  brief: string;
  inputRequirements: string;
  deliverableFormat: string;
  acceptanceChecklist: string[];
  requiredCapabilities: string[];
}

export interface WorkOrderSpec {
  /** Optional standard recipe used to select objective checks and matching rules. */
  templateId?: WorkOrderTemplateId | null;
  /** Commercial work lane used for matching and filtering. */
  category: AgentTaskCategory;
  /** What the creator will provide to the agent, including links or document identifiers. */
  inputRequirements: string;
  /** The concrete artifact or response format expected from the agent. */
  deliverableFormat: string;
  /** Human-readable, independently checkable acceptance rows. */
  acceptanceChecklist: string[];
  /** Optional public source URL or document reference used by the brief. */
  sourceUrl: string | null;
  /** Capabilities that should be present in the agent manifest before claiming. */
  requiredCapabilities: string[];
  /** Who absorbs metered API/tool costs incurred while completing this work order. */
  apiExpensePolicy: 'INCLUDED_IN_TASK_BUDGET' | 'X402_SEPARATE';
  /** Creator-approved ceiling for separate x402 charges; null when costs are included in the task budget. */
  maxApiExpenseUsdc: string | null;
}

export const DEFAULT_WORK_ORDER_SPEC: WorkOrderSpec = {
  templateId: null,
  category: 'RESEARCH',
  inputRequirements: 'Creator-provided brief and any source links listed below.',
  deliverableFormat: 'A concise report with evidence links and a machine-readable export where applicable.',
  acceptanceChecklist: ['All requested outputs are present.', 'Claims are supported by the supplied evidence.'],
  sourceUrl: null,
  // A legacy/generic task must remain claimable by any registered agent. A
  // creator can opt into a stricter capability gate in the publish envelope.
  requiredCapabilities: [],
  apiExpensePolicy: 'INCLUDED_IN_TASK_BUDGET',
  maxApiExpenseUsdc: null,
};

export const WORK_ORDER_TEMPLATES: readonly WorkOrderTemplateDefinition[] = [
  {
    id: 'RESEARCH_BRIEF',
    label: 'Research brief',
    description: 'Source-backed comparison, market note, or economic/legal brief.',
    category: 'RESEARCH',
    title: 'Prepare a source-backed research brief',
    brief: 'Answer a focused question using the supplied documents and public sources. Separate facts, calculations, and assumptions.',
    inputRequirements: 'A bounded question, the supplied documents or URLs, the date range, and the required audience for the brief.',
    deliverableFormat: 'Markdown or PDF brief with an executive summary, comparison table, citations, source manifest, and a JSON claims export.',
    acceptanceChecklist: [
      'Every material claim has a source URL or supplied-document reference.',
      'The brief answers the stated question and separates facts from assumptions.',
      'The comparison table and JSON claims export match the narrative.',
      'The source manifest includes retrieval dates and content hashes where available.',
    ],
    requiredCapabilities: ['research', 'source verification', 'analysis'],
  },
  {
    id: 'DATA_RECONCILIATION',
    label: 'Data cleanup & reconciliation',
    description: 'Normalize a dataset, reconcile totals, and explain every exception.',
    category: 'RESEARCH',
    title: 'Clean and reconcile a data batch',
    brief: 'Normalize the supplied CSV or JSON batch, reconcile totals against the source of truth, and flag every unexplained difference.',
    inputRequirements: 'The source CSV/JSON files, a column dictionary, the source-of-truth totals, and the allowed normalization rules.',
    deliverableFormat: 'Normalized CSV or JSON, a reconciliation report, an exception list, row counts, and SHA-256 hashes for source and output files.',
    acceptanceChecklist: [
      'The output parses against the declared schema and preserves required source rows.',
      'Reported totals reconcile to the source of truth within the stated tolerance.',
      'Every rejected or changed row appears in the exception list with a reason.',
      'Source, output, and report hashes are included and internally consistent.',
    ],
    requiredCapabilities: ['data analysis', 'schema validation', 'evidence review'],
  },
  {
    id: 'CODE_CHANGE',
    label: 'Code change & tests',
    description: 'Implement a scoped change with a reproducible test receipt.',
    category: 'ENGINEERING',
    title: 'Implement a scoped code change',
    brief: 'Make the requested change in the supplied repository without expanding scope. Explain trade-offs and leave a reproducible test receipt.',
    inputRequirements: 'A repository or patch target, the issue statement, runtime/version constraints, and commands allowed for verification.',
    deliverableFormat: 'Patch or public commit link, changed-file summary, test output, migration/rollback notes, and artifact hashes.',
    acceptanceChecklist: [
      'The requested behavior is implemented in the named scope without unrelated changes.',
      'The declared test or verification command completes with a recorded receipt.',
      'The summary identifies changed files, remaining risks, and rollback steps.',
      'The patch or commit reference is reproducible and its artifact hash is included.',
    ],
    requiredCapabilities: ['software engineering', 'testing', 'repository access'],
  },
  {
    id: 'SECURITY_REVIEW',
    label: 'Security & policy review',
    description: 'Review a bounded system or policy and rank actionable risks.',
    category: 'SECURITY',
    title: 'Review a system or policy for security risks',
    brief: 'Inspect the supplied policy, contract, or deployment boundary and report only reproducible findings with severity and remediation.',
    inputRequirements: 'The policy or repository snapshot, declared trust boundaries, threat assumptions, and the review scope that is out of bounds.',
    deliverableFormat: 'Severity-ranked Markdown report, threat model, reproduction steps, policy diff, remediation plan, and evidence hashes.',
    acceptanceChecklist: [
      'Each finding names an affected boundary, severity, and concrete evidence.',
      'A reviewer can reproduce the material findings from the supplied inputs.',
      'False positives and unverified assumptions are clearly marked.',
      'Every high or critical finding has a specific remediation or accepted-risk rationale.',
    ],
    requiredCapabilities: ['security review', 'threat modeling', 'policy analysis'],
  },
  {
    id: 'CONTENT_PACK',
    label: 'Document or content pack',
    description: 'Produce a finished document, presentation, or media package to a fixed brief.',
    category: 'CREATIVE',
    title: 'Produce a finished content pack',
    brief: 'Turn the supplied brief and source material into a polished document, presentation, or media package with the requested structure and format.',
    inputRequirements: 'The brief, source assets, audience, visual or editorial constraints, target format, and required delivery dimensions.',
    deliverableFormat: 'Final document or media files, editable source where requested, a content checklist, and a manifest of supplied assets.',
    acceptanceChecklist: [
      'All requested sections, scenes, or slides are present in the stated order.',
      'The final files open in the requested format and meet the declared dimensions.',
      'Claims, quotations, and supplied assets have an identifiable source or license note.',
      'The delivery includes the final artifact and a concise change/coverage checklist.',
    ],
    requiredCapabilities: ['content production', 'document formatting', 'asset handling'],
  },
];

/**
 * Keep the signed work envelope deterministic. The API validates limits; this
 * helper only normalizes omitted optional fields so wallet receipts remain
 * identical across the browser, demo store, and PostgreSQL gateway.
 */
export function normalizeWorkOrderSpec(input?: Partial<WorkOrderSpec> | null): WorkOrderSpec {
  const templateId = input?.templateId;
  const inputRequirements = typeof input?.inputRequirements === 'string' ? input.inputRequirements.trim() : '';
  const deliverableFormat = typeof input?.deliverableFormat === 'string' ? input.deliverableFormat.trim() : '';
  const sourceUrl = typeof input?.sourceUrl === 'string' ? input.sourceUrl.trim() : '';
  const maxApiExpenseUsdc = typeof input?.maxApiExpenseUsdc === 'string' ? input.maxApiExpenseUsdc.trim() : '';
  const checklist = Array.isArray(input?.acceptanceChecklist)
    ? input.acceptanceChecklist.filter((item): item is string => typeof item === 'string')
    : DEFAULT_WORK_ORDER_SPEC.acceptanceChecklist;
  const requiredCapabilities = Array.isArray(input?.requiredCapabilities)
    ? input.requiredCapabilities.filter((item): item is string => typeof item === 'string')
    : DEFAULT_WORK_ORDER_SPEC.requiredCapabilities;
  return {
    templateId: templateId && WORK_ORDER_TEMPLATE_IDS.includes(templateId)
      ? templateId
      : DEFAULT_WORK_ORDER_SPEC.templateId,
    category: input?.category ?? DEFAULT_WORK_ORDER_SPEC.category,
    inputRequirements: inputRequirements || DEFAULT_WORK_ORDER_SPEC.inputRequirements,
    deliverableFormat: deliverableFormat || DEFAULT_WORK_ORDER_SPEC.deliverableFormat,
    acceptanceChecklist: checklist
      .map((item) => item.trim())
      .filter(Boolean),
    sourceUrl: sourceUrl || null,
    requiredCapabilities: requiredCapabilities
      .map((item) => item.trim())
      .filter(Boolean),
    apiExpensePolicy: input?.apiExpensePolicy === 'X402_SEPARATE'
      ? 'X402_SEPARATE'
      : DEFAULT_WORK_ORDER_SPEC.apiExpensePolicy,
    maxApiExpenseUsdc: input?.apiExpensePolicy === 'X402_SEPARATE' && maxApiExpenseUsdc
      ? maxApiExpenseUsdc
      : null,
  };
}

const TASK_CATEGORY_PATTERNS: Record<AgentTaskCategory, RegExp> = {
  CREATIVE: /(video|presentation|creative|visual|caption|voice|storyboard|design|media|animation)/i,
  SECURITY: /(security|audit|policy|risk|threat|abuse|privilege|compliance)/i,
  RESEARCH: /(research|analysis|compare|source|market|competitor|economic|legal|document|report)/i,
  ENGINEERING: /(engineering|code|software|deploy|deployment|api|contract|test|repository|transaction|arc)/i,
};

/** Infer a work category from the published brief. A null result means the brief is intentionally generic. */
export function inferTaskCategory(input: { title?: string; description?: string; successCriteria?: string }): AgentTaskCategory | null {
  const text = `${input.title ?? ''} ${input.description ?? ''} ${input.successCriteria ?? ''}`;
  return (Object.entries(TASK_CATEGORY_PATTERNS) as Array<[AgentTaskCategory, RegExp]>).find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

/** Capability matching is a soft qualification gate; generic briefs remain claimable by any registered agent. */
export function manifestSupportsTaskCategory(manifest: AgentCapabilityManifest, category: AgentTaskCategory | null): boolean {
  if (!category) return true;
  const declared = [
    ...manifest.capabilities.flatMap((capability) => [capability.id, capability.label, capability.description, ...capability.inputTypes, ...capability.outputTypes]),
    ...manifest.tools,
    ...manifest.evidenceMethods,
  ].join(' ');
  return TASK_CATEGORY_PATTERNS[category].test(declared);
}

/** Match creator-declared capabilities against the agent's signed manifest. */
export function manifestSupportsWorkOrder(manifest: AgentCapabilityManifest, workOrder?: WorkOrderSpec): boolean {
  if (!workOrder?.requiredCapabilities?.length) return true;
  const declared = [
    ...manifest.capabilities.flatMap((capability) => [capability.id, capability.label, capability.description, ...capability.inputTypes, ...capability.outputTypes]),
    ...manifest.tools,
    ...manifest.evidenceMethods,
  ].join(' ').toLowerCase();
  return workOrder.requiredCapabilities.every((requirement) => {
    const terms = requirement.toLowerCase().split(/[^a-z0-9а-яё]+/i).filter((term) => term.length >= 3);
    return terms.length === 0 || terms.every((term) => declared.includes(term));
  });
}

export type AgentTraceOutcome = 'PENDING' | 'SUCCESS' | 'FAILURE';

export interface AgentTraceMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
}

export interface AgentToolCallTrace {
  name: string;
  inputHash: string;
  outputHash: string;
  status: 'SUCCESS' | 'ERROR';
  durationMs: number;
}

export interface AgentExecutionTrace {
  id: string;
  taskId: string;
  agentAddress: string;
  messages: AgentTraceMessage[];
  toolCalls: AgentToolCallTrace[];
  deliverableSummary: string;
  evidence: string[];
  consentToTraining: boolean;
  provider: string;
  reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewedAt: number | null;
  reviewerId: string | null;
  outcome: AgentTraceOutcome;
  createdAt: number;
  finalizedAt: number | null;
}

export interface DeliverableArtifact {
  name: string;
  mediaType: string;
  contentHash: string;
  sizeBytes: number;
  uri: string | null;
  preview: string | null;
}

export interface AgentDeliverable {
  id: string;
  taskId: string;
  agentAddress: string;
  summary: string;
  artifacts: DeliverableArtifact[];
  evidence: string[];
  status: 'SUBMITTED' | 'ACCEPTED' | 'DISPUTED';
  createdAt: number;
  reviewedAt: number | null;
}

export interface AgentPlanStep {
  id: string;
  tool: string;
  rationale: string;
  input: Record<string, unknown>;
}

export interface AgentPlan {
  objective: string;
  steps: AgentPlanStep[];
  expectedEvidence: string[];
}

export interface AgentRunStep {
  id: string;
  kind: 'POLICY' | 'PLAN' | 'TOOL' | 'DELIVERABLE';
  label: string;
  status: 'PENDING' | 'RUNNING' | 'SUCCESS' | 'ERROR' | 'BLOCKED';
  detail: string;
  inputHash: string | null;
  outputHash: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface AgentRun {
  id: string;
  taskId: string;
  agentAddress: string;
  provider: string;
  status: 'QUEUED' | 'PLANNING' | 'RUNNING' | 'SUBMITTED' | 'FAILED' | 'BLOCKED';
  plan: AgentPlan | null;
  steps: AgentRunStep[];
  deliverableId: string | null;
  error: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface TrainingStatus {
  baseModel: string;
  method: 'QLORA_SFT_ASSISTANT_ONLY';
  minimumReleaseTraces: number;
  recommendedTraces: number;
  totalSubmittedTraces: number;
  eligibleSuccessfulTraces: number;
  pendingTraces: number;
  failedTraces: number;
  pendingReviewTraces: number;
  readyForSmokeTraining: boolean;
  readyForReleaseTraining: boolean;
}

export interface StreamTerms {
  collateralPct: number;
  payoutSpeed: PayoutSpeed;
  maxTaskSize: string | null;
  requiresManualCheckpoints: boolean;
  unlockIntervalSeconds: number;
}

export interface ReputationSnapshot extends AgentReputationScore {
  terms: StreamTerms;
  capabilityManifest: AgentCapabilityManifest;
  previousTerms?: StreamTerms;
}

export interface ReputationEvent {
  id: string;
  agentAddress: string;
  taskId: string;
  success: boolean;
  volumeStreamed: string;
  timestamp: number;
}

export interface MarketplaceTask {
  id: string;
  templateId: string | null;
  chainTaskId: string | null;
  title: string;
  description: string;
  successCriteria: string;
  creatorAddress: string;
  /** Optional direct invitation. The task stays OPEN until this agent accepts it. */
  preferredAgentAddress?: string | null;
  agentAddress: string | null;
  totalAmount: string;
  estimatedDurationSeconds: number;
  streamRatePerSecond: string;
  status: TaskStatus;
  collateralLocked: string;
  accruedAmount: string;
  withdrawnAmount: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  // The marketplace task always belongs to a published template.
  terms: StreamTerms | null;
  /** Signed execution envelope for a creator-published work order. */
  workOrder?: WorkOrderSpec;
}

export interface TaskTemplate {
  id: string;
  title: string;
  description: string;
  successCriteria: string;
  rewardPoints: number;
  isActive: boolean;
  createdAt: number;
}

export type ArenaChallengeKind = 'GROUNDED_QA' | 'CODE_REPAIR' | 'TOOL_WORKFLOW';
export type ArenaEvaluationMode = 'HYBRID';

export interface ArenaTemplate {
  id: string;
  title: string;
  description: string;
  kind: ArenaChallengeKind;
  evaluationMode: ArenaEvaluationMode;
  rewardPoints: number;
  ownerType: 'PLATFORM';
  ownerName: string;
  variantCount: number;
  expectedMinutes: number;
  isActive: boolean;
  availableToday: boolean;
  completedToday: boolean;
  /** A daily attempt has been opened but its final answer has not been submitted yet. */
  inProgressToday: boolean;
  nextAttemptAt: number;
}

export interface ArenaGroundedPayload {
  kind: 'GROUNDED_QA';
  dataset: {
    name: string;
    format: 'JSON';
    columns: string[];
    rows: Array<Record<string, string | number>>;
    contentHash: string;
    notice: string;
  };
  question: {
    prompt: string;
    answerFormat: 'TEXT' | 'NUMBER';
    citationInstructions: string;
  };
}

export interface ArenaCodePayload {
  kind: 'CODE_REPAIR';
  language: 'javascript';
  entrypoint: 'index.mjs';
  files: Record<string, string>;
  publicTests: string[];
  constraints: string[];
  sourceHash: string;
}

export interface ArenaToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ArenaToolPayload {
  kind: 'TOOL_WORKFLOW';
  goal: string;
  mcpEndpoint: string;
  transport: 'STREAMABLE_HTTP';
  authentication: 'ATTEMPT_BEARER_TOKEN';
  tools: ArenaToolDescriptor[];
  outputSchema: Record<string, unknown>;
  minimumRequiredCalls: number;
}

export type ArenaChallengePayload = ArenaGroundedPayload | ArenaCodePayload | ArenaToolPayload;

export interface ArenaChallenge {
  attemptId: string;
  attemptToken: string;
  templateId: string;
  templateTitle: string;
  kind: ArenaChallengeKind;
  dayKey: string;
  agentAddress: string;
  payload: ArenaChallengePayload;
  generatorVersion: string;
  rubricVersion: string;
  instanceCommitment: string;
  startedAt: number;
}

export interface ArenaGroundedSubmission {
  kind: 'GROUNDED_QA';
  answer: string;
  citation: { recordId: string; field: string };
  reasoning: string;
}

export interface ArenaCodeSubmission {
  kind: 'CODE_REPAIR';
  files: Record<string, string>;
  reasoning: string;
}

export interface ArenaToolSubmission {
  kind: 'TOOL_WORKFLOW';
  artifactHash: string;
  reasoning: string;
}

export type ArenaSubmission = ArenaGroundedSubmission | ArenaCodeSubmission | ArenaToolSubmission;

export interface ArenaCheckResult {
  code: string;
  passed: boolean;
  detail: string;
}

export interface ArenaEvaluationResult {
  attemptId: string;
  templateId: string;
  kind: ArenaChallengeKind;
  dayKey: string;
  status: 'PASSED' | 'FAILED';
  score: number;
  deterministicScore: number;
  qualityScore: number;
  qualityModifier: number;
  efficiencyScore: number | null;
  efficiencyModifier: number;
  criticalChecksPassed: boolean;
  pointsAwarded: number;
  pointsReceipt?: {
    mode: 'OFFCHAIN' | 'ARC_TESTNET';
    transactionHash: string | null;
    contractAddress: string | null;
    chainId: number | null;
    agentTotal: number | null;
  };
  checks: ArenaCheckResult[];
  judge: {
    provider: string;
    rubricVersion: string;
    reasoning: string;
    receiptHash: string;
  };
  execution: {
    durationMs: number;
    toolCalls: number;
    tokensUsed: number | null;
    artifactHash: string | null;
  };
  submittedAt: number;
  nextAttemptAt: number;
  trainingConsent: boolean;
}

export interface ArenaLeaderboardEntry {
  rank: number;
  agentAddress: string;
  displayName: string;
  platformPoints: number;
  passedAttempts: number;
  totalAttempts: number;
  averageScore: number;
  trackScores: Record<ArenaChallengeKind, number | null>;
}

export interface Dispute {
  id: string;
  taskId: string;
  reason: string;
  evidence: string;
  status: 'PENDING' | 'NEEDS_HUMAN_REVIEW' | 'RESOLVED';
  verdict: DisputeVerdict | null;
  slashPct: number | null;
  reasoning: string | null;
  arbitratorProvider: string | null;
  decisionConfidence: number | null;
  arbitrationReceipt: ArbitrationReceipt | null;
  humanReview: HumanReviewReceipt | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface DashboardSnapshot {
  tasks: MarketplaceTask[];
  agents: ReputationSnapshot[];
  disputes: Dispute[];
  agentRuns: AgentRun[];
  deliverables: AgentDeliverable[];
  metrics: {
    totalVolume: string;
    activeStreams: number;
    completedTasks: number;
    protectedValue: string;
  };
  mode: 'demo' | 'arc';
}

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}

export const DEMO_ADDRESSES = {
  creator: '0xC100000000000000000000000000000000000001',
  newbie: '0xA100000000000000000000000000000000000001',
  veteran: '0xA100000000000000000000000000000000000002',
  proofAgent: '0xA100000000000000000000000000000000000003',
  platformAgent: '0xA100000000000000000000000000000000000004'
} as const;
