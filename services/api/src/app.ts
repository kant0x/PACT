import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { DEFAULT_TASK_DURATION_SECONDS, DEMO_ADDRESSES, inferTaskCategory, manifestSupportsTaskCategory, manifestSupportsWorkOrder, normalizeWorkOrderSpec, type ApiError, type WorkOrderSpec } from '@pact/shared';
import { ApiProblem } from './errors.js';
import { DemoStore, demoStore } from './store.js';
import { SCORE } from './config.js';
import { createArbitratorFromEnv, DeterministicArbitrator, type Arbitrator } from './arbitration.js';
import {
  assertWalletSubject,
  assertWalletOrAgentSubject,
  authenticatedGuard,
  identityMiddleware,
  operatorGuard,
  parseCorsOrigins,
  requestIdentity,
} from './security.js';
import { AgentRuntime, DeterministicAgentProvider, OpenAIAgentProvider, type AgentModelProvider } from './agent-runtime.js';
import { createArcSponsoredWallet, getCircleTransaction, submitArcContractCall } from './integrations/circle.js';
import { encodeFunctionData, getAddress, parseAbi, parseUnits, verifyMessage } from 'viem';
import { defaultExternalManifest, validateCapabilityManifest } from './capability-validation.js';
import { defaultWorkOrderForTask, validateWorkOrderSpec } from './work-order-validation.js';
import { createX402RuntimeIntegration } from './integrations/x402.js';
import { DockerArenaCodeRunner, type ArenaCodeRunner } from './arena-code-runner.js';
import { createArenaQualityJudgeFromEnv, DeterministicArenaQualityJudge, type ArenaQualityJudge } from './arena-quality-judge.js';
import { createPlatformPointsFromEnv, type PlatformPointsService } from './platform-points.js';
import { WalletAuthService } from './wallet-auth.js';
import {
  ArcSettlementError,
  createArcSettlementGatewayFromEnv,
  type ArcSettlementGateway,
} from './arc-settlement.js';
import { AgentKeyStore, type AgentApiKeyRecord } from './agent-key-store.js';
import { ArenaAutopilot } from './arena-autopilot.js';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const ETHEREUM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const FIFTEEN_MINUTES_SECONDS = 15 * 60;

const CIRCLE_AGENT_VAULT_ABI = parseAbi([
  'function claimOpenTask(uint256 taskId)',
  'function postCollateral(uint256 taskId)',
  'function withdrawStreamed(uint256 taskId)',
  'function pauseForDispute(uint256 taskId)',
]);
const CIRCLE_AGENT_ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

const hashSecret = (value: string) => createHash('sha256').update(value).digest('hex');

const creatorTaskMessage = (input: {
  creatorAddress: string;
  title: string;
  description?: string;
  successCriteria?: string;
  totalAmount: string | number;
  estimatedDurationSeconds?: number;
  preferredAgentAddress?: string | null;
  workOrder?: Partial<WorkOrderSpec> | null;
}) => [
  'PACT: publish funded task',
  `creator=${input.creatorAddress.toLowerCase()}`,
  `title=${input.title.trim()}`,
  `description=${(input.description ?? '').trim()}`,
  `criteria=${(input.successCriteria ?? '').trim()}`,
    `amount=${input.totalAmount}`,
    `duration=${input.estimatedDurationSeconds ?? DEFAULT_TASK_DURATION_SECONDS}`,
    `preferredAgent=${input.preferredAgentAddress?.toLowerCase() ?? ''}`,
  `workOrder=${JSON.stringify(normalizeWorkOrderSpec(input.workOrder))}`,
].join('\n');

const agentRegistrationMessage = (input: { displayName: string; capabilityManifest?: unknown }) => [
  `Registering on PACT as ${input.displayName.trim()}`,
  `manifest=${JSON.stringify(input.capabilityManifest && typeof input.capabilityManifest === 'object'
    ? Object.fromEntries(Object.entries(input.capabilityManifest).filter(([key]) => key !== 'updatedAt'))
    : null)}`,
].join('\n');

const arenaAttemptMessage = (input: { templateId: string; agentAddress: string; dayKey: string }) => [
  'PACT: start Training Ground attempt',
  `template=${input.templateId}`,
  `agent=${input.agentAddress.toLowerCase()}`,
  `day=${input.dayKey}`
].join('\n');

export interface AppOptions {
  arbitrator?: Arbitrator;
  authToken?: string;
  corsOrigins?: string[] | boolean;
  enableDemoEndpoints?: boolean;
  humanReviewerId?: string;
  agentProvider?: AgentModelProvider;
  arenaCodeRunner?: ArenaCodeRunner;
  arenaQualityJudge?: ArenaQualityJudge;
  platformPoints?: PlatformPointsService;
  sessionSecret?: string;
  authAudience?: string;
  arcSettlement?: ArcSettlementGateway | null;
  arenaAutopilotEnabled?: boolean;
}

export function createApp(store: DemoStore = demoStore, options: AppOptions = {}) {
  const app = express();
  const testMode = process.env.NODE_ENV === 'test';
  if (!testMode && process.env.PACT_MODE !== 'arc') {
    throw new Error('PACT_MODE=arc is required outside the test runtime; demo mode has been removed');
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!testMode && !openaiKey) {
    throw new Error('OPENAI_API_KEY is required outside the test runtime; live agent execution and arbitration cannot use a local fallback');
  }
  const defaultAgentProvider = openaiKey
    ? new OpenAIAgentProvider(openaiKey)
    : new DeterministicAgentProvider();
  const agentRuntime = new AgentRuntime(options.agentProvider ?? defaultAgentProvider, store);
  const arenaCodeRunner = options.arenaCodeRunner ?? new DockerArenaCodeRunner();
  const arenaQualityJudge = options.arenaQualityJudge ?? (() => {
    if (testMode) return new DeterministicArenaQualityJudge();
    try {
      return createArenaQualityJudgeFromEnv();
    } catch (error) {
      throw error;
    }
  })();
  const platformPoints = options.platformPoints ?? (() => {
    try {
      return createPlatformPointsFromEnv();
    } catch (error) {
      if (testMode) return null;
      throw error;
    }
  })();
  const arenaAutopilotEnabled = options.arenaAutopilotEnabled
    ?? (process.env.VITEST !== 'true' && process.env.PACT_AGENT_AUTOPILOT_ENABLED !== 'false');
  const arenaAutopilot = new ArenaAutopilot({
    store,
    codeRunner: arenaCodeRunner,
    qualityJudge: arenaQualityJudge,
    platformPoints,
    enabled: arenaAutopilotEnabled,
    pollIntervalMs: Number(process.env.PACT_AUTOPILOT_POLL_INTERVAL_MS ?? 15_000),
    maxAgentsPerTick: Number(process.env.PACT_AUTOPILOT_MAX_AGENTS_PER_TICK ?? 2),
    syncProductionAgents: arenaAutopilotEnabled && process.env.PACT_MODE === 'arc'
      ? async () => (await import('./repositories/agent.repository.js')).agentRepository.findAll()
      : undefined,
    onResult: arenaAutopilotEnabled && process.env.PACT_MODE === 'arc'
      ? async (agentAddress, result) => {
          if (result.pointsAwarded > 0) {
            await (await import('./repositories/agent.repository.js')).agentRepository.awardPlatformPoints(agentAddress, result.pointsAwarded);
          }
        }
      : undefined,
  });
  app.locals.arenaAutopilot = arenaAutopilot;
  if (testMode) {
    for (const agent of store.dashboard().agents) arenaAutopilot.enroll(agent.agentAddress);
  }
  if (!testMode && process.env.PLATFORM_POINTS_REQUIRED === 'true' && !platformPoints) {
    throw new Error('PLATFORM_POINTS_REQUIRED=true but no Arc PlatformPoints adapter is configured');
  }
  const x402Integration = (() => {
    try {
      return createX402RuntimeIntegration();
    } catch (error) {
      if (testMode) return null;
      throw error;
    }
  })();
  const arbitrator = options.arbitrator ?? (() => {
    try {
      return testMode ? new DeterministicArbitrator() : createArbitratorFromEnv();
    } catch (error) {
      throw error;
    }
  })();
  const authToken = options.authToken ?? process.env.PACT_AUTH_TOKEN;
  const hardenedRuntime = !testMode;
  const sessionSecret = options.sessionSecret
    ?? process.env.PACT_SESSION_SECRET
    ?? (process.env.NODE_ENV === 'test' ? 'test-only-pact-session-secret-32-bytes' : undefined);
  const authAudience = options.authAudience ?? process.env.PACT_AUTH_DOMAIN ?? 'localhost';
  if (hardenedRuntime && !authToken) {
    throw new Error('PACT_AUTH_TOKEN is required in production/Arc mode');
  }
  if (hardenedRuntime && !sessionSecret) {
    throw new Error('PACT_SESSION_SECRET is required in production/Arc mode');
  }
  if (hardenedRuntime && !(process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL)) {
    throw new Error('PACT_DATABASE_URL or DATABASE_URL is required in production/Arc mode');
  }
  if (hardenedRuntime && (!authAudience || authAudience === 'localhost')) {
    throw new Error('PACT_AUTH_DOMAIN must name the public PACT domain in production/Arc mode');
  }
  const arcSettlement = options.arcSettlement ?? createArcSettlementGatewayFromEnv();
  if (!testMode && !arcSettlement) {
    throw new Error('Arc settlement gateway is required in Arc mode');
  }
  const walletAuth = new WalletAuthService(sessionSecret ?? 'development-only-pact-session-secret', authAudience);
  const agentKeyStore = new AgentKeyStore();
  const verifyAgentToken = (token: string) => agentKeyStore.verify(token);
  const publicAgentKey = (record: AgentApiKeyRecord) => ({
    id: record.id,
    agentAddress: record.agentAddress,
    label: record.label,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    nextPollAt: record.nextPollAt
  });
  const demoEndpointsEnabled = testMode && (options.enableDemoEndpoints ?? true);
  // A funded work order must be explicitly approved by the creator wallet. Tests can
  // use the in-memory store without a Web3 signature; every real/dev HTTP request is
  // protected unless an operator deliberately opts into the legacy bypass.
  const creatorSignatureRequired = !testMode;
  // Live registration must prove wallet ownership over the exact capability JSON
  // that is persisted; a bearer token alone is not an agent identity proof.
  const agentSignatureRequired = !testMode;
  // Never let a browser claim an arena attempt merely by naming a registered
  // agent address. Tests may intentionally exercise the store without a wallet.
  const arenaSignatureRequired = process.env.NODE_ENV !== 'test'
    || process.env.PACT_REQUIRE_ARENA_SIGNATURES === 'true';
  const assertCreatorSignature = async (input: Record<string, unknown>) => {
    if (!creatorSignatureRequired) return;
    const creatorAddress = text(input.creatorAddress).trim();
    const signature = text(input.signature).trim();
    if (!creatorAddress) throw new ApiProblem(400, 'INVALID_CREATOR', 'creatorAddress is required');
    if (!signature) throw new ApiProblem(401, 'CREATOR_SIGNATURE_REQUIRED', 'Connect the creator wallet and approve the task before publishing');
    try {
      const valid = await verifyMessage({
        address: creatorAddress as `0x${string}`,
        message: creatorTaskMessage({
          creatorAddress,
          title: text(input.title),
          description: text(input.description),
          successCriteria: text(input.successCriteria),
          totalAmount: typeof input.totalAmount === 'number' ? input.totalAmount : text(input.totalAmount),
          estimatedDurationSeconds: input.estimatedDurationSeconds == null ? DEFAULT_TASK_DURATION_SECONDS : Number(input.estimatedDurationSeconds),
          preferredAgentAddress: text(input.preferredAgentAddress).trim() || null,
          workOrder: input.workOrder as Partial<WorkOrderSpec> | null | undefined,
        }),
        signature: signature as `0x${string}`,
      });
      if (!valid) throw new ApiProblem(403, 'INVALID_CREATOR_SIGNATURE', 'The connected wallet did not approve this task');
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
      throw new ApiProblem(403, 'INVALID_CREATOR_SIGNATURE', 'The connected wallet did not approve this task');
    }
  };
  const assertAgentSignature = async (input: Record<string, unknown>, address: string, manifest?: unknown) => {
    if (!agentSignatureRequired) return;
    const signature = text(input.signature).trim();
    if (!signature) throw new ApiProblem(401, 'AGENT_SIGNATURE_REQUIRED', 'Connect the agent wallet and approve the registration');
    try {
      const valid = await verifyMessage({
        address: address as `0x${string}`,
        message: agentRegistrationMessage({ displayName: text(input.displayName), capabilityManifest: manifest }),
        signature: signature as `0x${string}`
      });
      if (!valid) throw new ApiProblem(403, 'INVALID_AGENT_SIGNATURE', 'The connected wallet did not approve this agent profile');
    } catch (error) {
      if (error instanceof ApiProblem) throw error;
      throw new ApiProblem(403, 'INVALID_AGENT_SIGNATURE', 'The connected wallet did not approve this agent profile');
    }
  };
  const allowAnonymousTestBypass = (request: Request) =>
    process.env.NODE_ENV === 'test' && !authToken && !requestIdentity(request);
  const requireAuth = authenticatedGuard;
  const requireOperator = (request: Request, response: Response, next: NextFunction) => {
    if (allowAnonymousTestBypass(request)) return next();
    return operatorGuard(request, response, next);
  };
  const humanReviewerId = (options.humanReviewerId ?? process.env.PACT_HUMAN_REVIEWER_ID ?? 'authorized-human-reviewer').trim()
    || 'authorized-human-reviewer';
  const redactDispute = (dispute: ReturnType<DemoStore['getDispute']>) => ({
    ...dispute,
    reason: '[restricted: authenticate to view dispute details]',
    evidence: '[restricted: evidence hash remains available in the decision receipt]'
  });
  const canReadSensitive = (request: Request) => requestIdentity(request)?.kind === 'operator';
  const authorizeAddress = (request: Request, address: string, message?: string) => {
    if (allowAnonymousTestBypass(request)) return;
    assertWalletSubject(request, address, message);
  };
  const authorizeWalletOrAgent = (request: Request, address: string, message?: string) => {
    if (allowAnonymousTestBypass(request)) return;
    assertWalletOrAgentSubject(request, address, message);
  };
  const authorizeAgentController = async (request: Request, address: string, message = 'Only the agent wallet owner can manage this agent') => {
    if (allowAnonymousTestBypass(request)) return;
    const identity = requestIdentity(request);
    if (identity?.kind === 'operator') return;
    if (identity?.kind !== 'wallet') throw new ApiProblem(403, 'RESOURCE_FORBIDDEN', message);
    if (identity.subject.toLowerCase() === address.toLowerCase()) return;
    if (process.env.PACT_MODE === 'arc') {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const agent = await agentRepository.findByAddress(address);
      if (agent?.controllerAddress.toLowerCase() === identity.subject.toLowerCase()) return;
    }
    throw new ApiProblem(403, 'RESOURCE_FORBIDDEN', message);
  };
  const authorizeAgentExecution = async (request: Request, address: string, message = 'Only the selected agent or its controller can start runtime execution') => {
    if (allowAnonymousTestBypass(request)) return;
    const identity = requestIdentity(request);
    if (identity?.kind === 'operator') return;
    if (identity?.kind === 'agent' && identity.subject.toLowerCase() === address.toLowerCase()) return;
    if (identity?.kind !== 'wallet') throw new ApiProblem(403, 'RESOURCE_FORBIDDEN', message);
    if (identity.subject.toLowerCase() === address.toLowerCase()) return;
    if (process.env.PACT_MODE === 'arc') {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const agent = await agentRepository.findByAddress(address);
      if (agent?.controllerAddress.toLowerCase() === identity.subject.toLowerCase()) return;
    }
    throw new ApiProblem(403, 'RESOURCE_FORBIDDEN', message);
  };
  const configuredCorsOrigins = options.corsOrigins ?? parseCorsOrigins();
  const persistenceMode = (process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL) ? 'postgres' : 'memory';
  // Caddy is the single public reverse proxy. Trust exactly that hop so the
  // rate limiter receives the actual client address from X-Forwarded-For.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: configuredCorsOrigins }));
  app.use(identityMiddleware(authToken, walletAuth, verifyAgentToken));
  app.use('/api', rateLimit({
    windowMs: Number(process.env.PACT_RATE_LIMIT_WINDOW_MS ?? 60_000),
    limit: Number(process.env.PACT_RATE_LIMIT_MAX ?? 300),
    standardHeaders: 'draft-8',
    legacyHeaders: false
  }));
  app.use(express.json({ limit: process.env.PACT_JSON_LIMIT ?? '64kb' }));
  app.use('/api', (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    if (request.path === '/auth/challenge' || request.path === '/auth/verify') return next();
    // Attempt-scoped arena mutations authenticate with the private attempt
    // token, so an MCP client never needs the platform-wide operator token.
    if (request.path.startsWith('/arena/attempts/')) return next();
    if (/^\/arena\/templates\/[^/]+\/start$/.test(request.path)) return next();
    if (process.env.NODE_ENV === 'test') return next();
    return requireAuth(request, response, next);
  });

  // The in-memory/demo API is test-only. In live mode every public data
  // mutation and read must go through the PostgreSQL + Arc routes below.
  app.use('/api', (request, _response, next) => {
    if (testMode) return next();
    const livePath = /^(?:\/health(?:\/|$)|\/auth\/(?:challenge|verify|session)$|\/trust-model$|\/runtime\/paid-capability$|\/training\/(?:catalog|agents\/[^/]+\/reports)$|\/dashboard\/pg$|\/leaderboard\/pg$|\/agents\/pg(?:\/|$)|\/agents\/[^/]+\/(?:autopilot|api-keys|work-queue)(?:\/|$)|\/tasks\/pg(?:\/|$)|\/templates\/pg(?:\/|$)|\/deliverables\/pg(?:\/|$)|\/disputes\/pg(?:\/|$))$/.test(request.path);
    if (!livePath) {
      return next(new ApiProblem(410, 'DEMO_RUNTIME_REMOVED', 'Demo and in-memory runtime routes are disabled; use the live Arc API'));
    }
    next();
  });

  app.post('/api/auth/challenge', async (request, response, next) => {
    try {
      response.status(201).json(await walletAuth.issueChallenge(text(request.body?.address)));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/verify', async (request, response, next) => {
    try {
      response.json(await walletAuth.verifyChallenge({
        challengeId: text(request.body?.challengeId),
        address: text(request.body?.address),
        signature: text(request.body?.signature),
      }));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/session', requireAuth, (request, response) => {
    const identity = requestIdentity(request);
    if (identity?.kind !== 'wallet') {
      throw new ApiProblem(403, 'WALLET_SESSION_REQUIRED', 'A wallet session is required');
    }
    response.json({ address: identity.subject, expiresAt: identity.claims.exp });
  });

  const health = (_request: Request, response: Response) => response.json({
    status: 'ok',
    service: 'pact-api',
    mode: process.env.PACT_MODE === 'arc' ? 'arc' : 'local',
    persistence: persistenceMode,
    readiness: {
      productionReady: hardenedRuntime
        ? persistenceMode === 'postgres' && (process.env.PACT_MODE !== 'arc' || Boolean(arcSettlement))
        : false,
      auth: hardenedRuntime ? 'required' : 'local-relaxed',
      cors: configuredCorsOrigins === true ? 'development-wildcard' : 'allowlist',
      data: persistenceMode === 'postgres' ? 'durable' : 'ephemeral',
      settlement: arcSettlement ? 'arc-contract-backed' : 'offchain'
    },
    boundaries: {
      judge: 'verdict-only',
      settlement: 'separate collateral policy',
      reputation: 'updates after accepted work or finalized dispute',
      offchainFallback: 'cancelTaskAfterTimeout'
    },
    training: {
      platformPoints: platformPoints ? 'contract-backed' : 'offchain-adapter',
      agentPollIntervalSeconds: FIFTEEN_MINUTES_SECONDS,
      autopilot: arenaAutopilotEnabled ? 'active' : 'disabled',
      dailyTemplates: store.listArenaTemplates().length,
      launchMode: 'runs-all-available-daily-tasks'
    },
    timestamp: new Date().toISOString()
  });
  app.get('/health', health);
  app.get('/api/health', health);
  app.get('/api/health/live', health);
  app.get('/api/health/ready', async (_request, response) => {
    if (!arcSettlement) {
      return response.status(hardenedRuntime ? 503 : 200).json({
        ready: !hardenedRuntime,
        settlement: 'offchain',
      });
    }
    try {
      const status = await arcSettlement.readiness();
      const ready = status.chainId === 5_042_002
        && status.disputeModuleOwned
        && status.disputeModuleConfigured
        && !status.disputeModulePaused
        && persistenceMode === 'postgres';
      return response.status(ready ? 200 : 503).json({ ready, settlement: status, persistence: persistenceMode });
    } catch (error) {
      return response.status(503).json({
        ready: false,
        settlement: 'unavailable',
        error: error instanceof Error ? error.message : 'Arc readiness check failed',
      });
    }
  });

  // Public, read-only system assignment catalogue. It intentionally exposes
  // neither agent attempts nor attempt credentials; agents receive those only
  // through their authenticated work queue.
  app.get('/api/training/catalog', (request, response) => {
    const requestedAgent = text(request.query.agentAddress).toLowerCase();
    // The Arc registry can know an agent before its local training runtime is
    // enrolled. In that case, keep the public catalogue visible and omit only
    // the per-agent lifecycle markers instead of returning an empty board.
    const agentAddress = requestedAgent && store.hasRegisteredAgent(requestedAgent) ? requestedAgent : undefined;
    response.json(store.listArenaTemplates(agentAddress));
  });

  app.get('/api/x402/status', (_request, response) => response.json({
    enabled: Boolean(x402Integration),
    ...(x402Integration ? {
      network: x402Integration.config.network,
      price: x402Integration.config.price,
      route: x402Integration.config.route,
      facilitator: x402Integration.config.facilitatorUrl
    } : {
      reason: 'Set X402_SELLER_ADDRESS to enable the real payment middleware.'
    })
  }));

  // This is intentionally a separate paid runtime resource. Work-order
  // funding still uses StreamingVault; x402 only meters an external API call.
  if (x402Integration) {
    app.get(x402Integration.config.route, x402Integration.gateway.require(x402Integration.config.price), (request, response) => {
      const payment = (request as Request & { payment?: { payer?: string; transaction?: string; network?: string } }).payment;
      response.json({
        resource: 'PACT bounded agent capability call',
        result: 'paid runtime access granted',
        payer: payment?.payer ?? null,
        network: payment?.network ?? x402Integration.config.network,
        transaction: payment?.transaction ?? null,
        policy: 'This payment is separate from task escrow, collateral, arbitration and Trust Score.'
      });
    });
  } else {
    app.get('/api/runtime/paid-capability', (_request, response) => response.status(503).json({
      error: 'X402_NOT_CONFIGURED',
      message: 'The operator has not configured an x402 seller wallet for runtime metering.'
    }));
  }

  app.get('/api/trust-model', (_request, response) => response.json({
    rankAuthority: 'deterministic-reputation-engine',
    rankInputs: ['resolved task outcomes', 'failed outcomes', 'settled USDC volume'],
    arbitrator: arbitrator.provider,
    arbitratorAuthority: 'verdict-only',
    safeguards: arbitrator.provider === 'council'
      ? ['2-of-3 judge quorum', 'evidence hash', 'decision receipt', 'fail closed without quorum', 'evidence firewall', 'secret redaction', 'prompt-injection isolation']
      : ['deterministic policy', 'evidence size limit', 'single-outcome protection', 'verdict-only authority', 'evidence firewall', 'secret redaction', 'prompt-injection isolation']
  }));

  app.get('/api/dashboard', (request, response) => {
    const dashboard = store.dashboard();
    const enriched = {
      ...dashboard,
      agentAutomation: arenaAutopilot.snapshots(dashboard.agents.map((agent) => agent.agentAddress)),
    };
    response.json(canReadSensitive(request)
      ? enriched
      : { ...enriched, disputes: dashboard.disputes.map(redactDispute) });
  });
  app.get('/api/leaderboard', (_request, response) => response.json(store.leaderboard()));
  app.get('/api/agents', (_request, response) => response.json(store.leaderboard()));
  app.get('/api/agents/:agentAddress/autopilot', async (request, response, next) => {
    try {
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      if (process.env.PACT_MODE === 'arc') {
        const agent = await (await import('./repositories/agent.repository.js')).agentRepository.findByAddress(agentAddress);
        if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent profile was not found');
      } else {
        store.reputation(agentAddress);
      }
      response.json(arenaAutopilot.snapshot(agentAddress));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agents/:agentAddress/autopilot/start', requireAuth, async (request, response, next) => {
    try {
      if (!arenaAutopilotEnabled) throw new ApiProblem(503, 'SERVER_AUTOPILOT_DISABLED', 'Self-training is disabled by PACT_AGENT_AUTOPILOT_ENABLED');
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      await authorizeAgentController(request, agentAddress, 'Only the agent owner wallet can start autopilot');
      if (process.env.PACT_MODE === 'arc') {
        const { agentRepository } = await import('./repositories/agent.repository.js');
        const agent = await agentRepository.findByAddress(agentAddress);
        if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent profile was not found');
        if (!store.hasRegisteredAgent(agentAddress)) store.syncAgentProfile(agent);
      } else {
        store.reputation(agentAddress);
      }
      response.json(arenaAutopilot.enroll(agentAddress));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agents/:agentAddress/autopilot/pause', requireAuth, async (request, response, next) => {
    try {
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      await authorizeAgentController(request, agentAddress, 'Only the agent owner wallet can pause autopilot');
      response.json(arenaAutopilot.disable(agentAddress));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agents/:agentAddress/api-keys', requireAuth, async (request, response, next) => {
    try {
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      if (process.env.PACT_MODE === 'arc') {
        const { agentService } = await import('./services/agent.service.js');
        await agentService.getReputation(agentAddress);
      } else {
        store.reputation(agentAddress);
      }
      authorizeAddress(request, agentAddress, 'Only the agent owner wallet can list runtime keys');
      response.json((await agentKeyStore.list(agentAddress)).map(publicAgentKey));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/agents/:agentAddress/api-keys', requireAuth, async (request, response, next) => {
    try {
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      if (process.env.PACT_MODE === 'arc') {
        const { agentService } = await import('./services/agent.service.js');
        await agentService.getReputation(agentAddress);
      } else {
        store.reputation(agentAddress);
      }
      authorizeAddress(request, agentAddress, 'Only the agent owner wallet can create runtime keys');
      const created = await agentKeyStore.issue(agentAddress, text(request.body?.label));
      response.status(201).json({ ...publicAgentKey(created), token: created.token });
    } catch (error) {
      next(error);
    }
  });
  app.delete('/api/agents/:agentAddress/api-keys/:keyId', requireAuth, async (request, response, next) => {
    try {
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      authorizeAddress(request, agentAddress, 'Only the agent owner wallet can revoke runtime keys');
      const record = await agentKeyStore.revoke(text(request.params.keyId), agentAddress);
      if (!record) throw new ApiProblem(404, 'AGENT_KEY_NOT_FOUND', 'Agent runtime key was not found');
      response.json(publicAgentKey(record));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/agents/:agentAddress/work-queue', requireAuth, async (request, response, next) => {
    try {
      const agentAddress = text(request.params.agentAddress).toLowerCase();
      const reputation = process.env.PACT_MODE === 'arc'
        ? await (await import('./services/agent.service.js')).agentService.getReputation(agentAddress)
        : store.reputation(agentAddress);
      authorizeWalletOrAgent(request, agentAddress, 'Only the agent runtime or owner wallet can read this work queue');
      const identity = requestIdentity(request);
      if (identity?.kind === 'agent') {
        const reservation = await agentKeyStore.reservePoll(identity.keyId, FIFTEEN_MINUTES_SECONDS);
        if (!reservation.allowed) {
          const now = Math.floor(Date.now() / 1000);
          if (reservation.nextPollAt) response.setHeader('Retry-After', String(Math.max(1, reservation.nextPollAt - now)));
          throw new ApiProblem(429, 'AGENT_POLL_RATE_LIMITED', 'Agent work queue polling is limited to one request every 15 minutes', {
            nextPollAt: reservation.nextPollAt,
          });
        }
      }
      const candidateTasks = process.env.PACT_MODE === 'arc'
        ? await (await import('./repositories/task.repository.js')).taskRepository.findAll('OPEN')
        : store.listTasks('OPEN');
      const paidWork = candidateTasks.filter((task) => {
        if (task.preferredAgentAddress && task.preferredAgentAddress.toLowerCase() !== agentAddress) return false;
        const category = task.workOrder?.category ?? inferTaskCategory(task);
        return manifestSupportsTaskCategory(reputation.capabilityManifest, category)
          && manifestSupportsWorkOrder(reputation.capabilityManifest, task.workOrder);
      });
      response.json({
        agent: { agentAddress: reputation.agentAddress, displayName: reputation.displayName, score: reputation.score, platformPoints: reputation.platformPoints },
        pollIntervalSeconds: FIFTEEN_MINUTES_SECONDS,
        paidWork,
        training: store.listArenaTemplates(agentAddress),
        runtime: { authenticatedAs: identity?.kind ?? null }
      });
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/arena/leaderboard', async (_request, response, next) => {
    try {
      const localRows = store.arenaLeaderboard();
      if (!platformPoints) {
        response.json(localRows);
        return;
      }

      // Arc is authoritative when the points adapter is enabled. The local
      // attempt statistics remain useful, but the displayed point total is
      // read from the contract so a restart cannot erase the leaderboard.
      const rows = await Promise.all(localRows.map(async (row) => ({
        ...row,
        platformPoints: await platformPoints.getPoints(row.agentAddress)
      })));
      rows.sort((left, right) => right.platformPoints - left.platformPoints || right.averageScore - left.averageScore || left.agentAddress.localeCompare(right.agentAddress));
      response.json(rows.map((row, index) => ({ ...row, rank: index + 1 })));
    } catch (error) {
      if (process.env.PLATFORM_POINTS_REQUIRED === 'true') {
        next(new ApiProblem(503, 'PLATFORM_POINTS_UNAVAILABLE', 'Arc Platform Points could not be read; leaderboard is fail-closed'));
        return;
      }
      response.json(store.arenaLeaderboard());
    }
  });
  // Reports expose verdict metadata only: no prompt, private packet,
  // submission payload, or attempt credential leaves the arena store.
  app.get('/api/training/agents/:agentAddress/reports', (request, response) => {
    response.json(store.arenaReports(text(request.params.agentAddress)));
  });
  app.get('/api/arena/runtime', (_request, response) => response.json({
    generator: 'private deterministic HMAC instances',
    qualityJudge: arenaQualityJudge.provider,
    codeRunner: arenaCodeRunner.describe(),
    platformPoints: platformPoints?.describe() ?? {
      mode: 'OFFCHAIN',
      reason: 'Configure PLATFORM_POINTS_ADDRESS and PLATFORM_POINTS_AWARDER_PRIVATE_KEY to record points on Arc Testnet'
    },
    toolTransport: 'MCP Streamable HTTP',
    startAuthentication: arenaSignatureRequired ? 'EIP-191 wallet signature' : 'development bypass'
  }));
  app.get('/api/arena/templates', (request, response) => response.json(store.listArenaTemplates(text(request.query.agentAddress) || undefined)));
  app.post('/api/arena/templates/:id/start', async (request, response) => {
    const agentAddress = text(request.body?.agentAddress).trim();
    if (!agentAddress) throw new ApiProblem(400, 'INVALID_ARENA_START', 'agentAddress is required');
    if (!ETHEREUM_ADDRESS.test(agentAddress)) throw new ApiProblem(400, 'INVALID_ARENA_START', 'agentAddress must be an EVM address');
    const identity = requestIdentity(request);
    const authorizedAgentRuntime = identity?.kind === 'agent' && identity.subject.toLowerCase() === agentAddress.toLowerCase();
    if (!authorizedAgentRuntime && identity?.kind === 'wallet') {
      authorizeAddress(request, agentAddress, 'Only the selected agent wallet can start this daily attempt');
    }
    if (!authorizedAgentRuntime && arenaSignatureRequired) {
      const signature = text(request.body?.signature).trim();
      if (!signature) throw new ApiProblem(401, 'ARENA_SIGNATURE_REQUIRED', 'Connect the selected agent wallet and sign the daily attempt');
      try {
        const valid = await verifyMessage({
          address: agentAddress as `0x${string}`,
          message: arenaAttemptMessage({
            templateId: request.params.id,
            agentAddress,
            dayKey: new Date().toISOString().slice(0, 10)
          }),
          signature: signature as `0x${string}`
        });
        if (!valid) throw new ApiProblem(403, 'INVALID_ARENA_SIGNATURE', 'The selected agent wallet did not approve this attempt');
      } catch (error) {
        if (error instanceof ApiProblem) throw error;
        throw new ApiProblem(403, 'INVALID_ARENA_SIGNATURE', 'The selected agent wallet did not approve this attempt');
      }
    }
    response.status(201).json(store.startArenaAttempt(request.params.id, agentAddress));
  });
  app.post('/api/arena/attempts/:id/submit', async (request, response) => {
    response.json(await store.submitArenaAttempt(request.params.id, request.body, {
      codeRunner: arenaCodeRunner,
      qualityJudge: arenaQualityJudge,
      platformPoints
    }));
  });

  const attemptBearer = (request: Request) => {
    const match = request.get('authorization')?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) throw new ApiProblem(401, 'ARENA_TOKEN_REQUIRED', 'Use the attempt token as a Bearer credential');
    return match[1];
  };

  app.post('/api/arena/attempts/:id/tools/:tool', (request, response) => {
    const output = store.executeArenaTool(request.params.id, attemptBearer(request), request.params.tool, request.body ?? {});
    response.json(output);
  });

  app.post('/api/arena/attempts/:id/mcp', async (request, response) => {
    const attemptToken = attemptBearer(request);
    const attemptId = request.params.id;
    const rpc = request.body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return response.status(400).json({ jsonrpc: '2.0', id: rpc?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } });
    }
    const id = typeof rpc.id === 'string' || typeof rpc.id === 'number' ? rpc.id : null;
    const success = (result: Record<string, unknown>) => response.json({ jsonrpc: '2.0', id, result });
    if (rpc.method === 'notifications/initialized' || rpc.method === 'notifications/cancelled') {
      return response.status(202).end();
    }
    if (id === null) return response.status(202).end();
    if (rpc.method === 'initialize') {
      const params = rpc.params && typeof rpc.params === 'object' ? rpc.params as Record<string, unknown> : {};
      return success({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pact-arena-tools', version: '2.0.0' },
        instructions: 'Call fetch_orders, normalize_orders, then publish_report. Pass each returned receipt to the next tool.'
      });
    }
    if (rpc.method === 'ping') return success({});
    if (rpc.method === 'tools/list') {
      return success({ tools: [
        { name: 'fetch_orders', description: 'Fetch attempt-scoped source orders.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
        { name: 'normalize_orders', description: 'Normalize SETTLED orders using the source receipt.', inputSchema: { type: 'object', properties: { sourceReceipt: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['sourceReceipt'], additionalProperties: false } },
        { name: 'publish_report', description: 'Publish the final JSON report using the transform receipt.', inputSchema: { type: 'object', properties: { transformReceipt: { type: 'string', minLength: 1, maxLength: 200 }, format: { type: 'string', const: 'json' } }, required: ['transformReceipt', 'format'], additionalProperties: false } }
      ] });
    }
    if (rpc.method === 'tools/call') {
      const params = rpc.params && typeof rpc.params === 'object' ? rpc.params as Record<string, unknown> : {};
      const name = text(params.name);
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown>
        : {};
      try {
        const output = store.executeArenaTool(attemptId, attemptToken, name, args);
        return success({ content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output });
      } catch (error) {
        return success({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Arena tool failed' }] });
      }
    }
    return response.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpc.method}` } });
  });
  app.get('/api/arena/attempts/:id/mcp', (_request, response) => response.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Use MCP Streamable HTTP POST.' }));
  app.delete('/api/arena/attempts/:id/mcp', (_request, response) => response.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'Stateless MCP sessions do not require DELETE.' }));

  // Production PostgreSQL Dashboard
  app.get('/api/dashboard/pg', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const { agentRunRepository } = await import('./repositories/agent-run.repository.js');
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const { agentService } = await import('./services/agent.service.js');

      const tasks = await taskRepository.findAll();
      const agentsList = await agentRepository.findAll();
      const agents = await Promise.all(agentsList.map(a => agentService.getReputation(a.agentAddress)));
      const disputes = await disputeRepository.findAll();
      const agentRuns = await agentRunRepository.findAll();
      const deliverables = await deliverableRepository.findAll();
      const identity = requestIdentity(request);
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const controlledAgentAddresses = new Set(identity?.kind === 'wallet'
        ? agentsList
          .filter((agent) => agent.walletProvider === 'CIRCLE' && agent.controllerAddress.toLowerCase() === identity.subject.toLowerCase())
          .map((agent) => agent.agentAddress.toLowerCase())
        : []);
      const isTaskParticipant = (taskId: string) => {
        if (identity?.kind === 'operator') return true;
        const task = taskById.get(taskId);
        return Boolean(identity && task && (
          (identity.kind === 'wallet' && task.creatorAddress.toLowerCase() === identity.subject.toLowerCase())
          || ((identity.kind === 'wallet' || identity.kind === 'agent') && task.agentAddress?.toLowerCase() === identity.subject.toLowerCase())
          || Boolean(task.agentAddress && controlledAgentAddresses.has(task.agentAddress.toLowerCase()))
        ));
      };
      const visibleDisputes = disputes.map((dispute) => isTaskParticipant(dispute.taskId) ? dispute : redactDispute(dispute));
      const visibleAgentRuns = agentRuns.filter((run) => isTaskParticipant(run.taskId));
      const visibleDeliverables = deliverables.map((deliverable) => {
        return isTaskParticipant(deliverable.taskId) ? deliverable : {
          ...deliverable,
          summary: '[private deliverable: connect a participating wallet to review]',
          artifacts: [],
          evidence: [],
        };
      });

      let totalVolume = 0;
      let activeStreams = 0;
      let completedTasksCount = 0;
      let protectedValue = 0;

      for (const t of tasks) {
        if (t.status === 'STREAMING') activeStreams++;
        if (t.status === 'COMPLETED') completedTasksCount++;
        totalVolume += Number(t.withdrawnAmount || 0);
        protectedValue += Number(t.collateralLocked || 0);
      }

      const money = (value: number) => Math.max(0, value).toFixed(6).replace(/\.?0+$/, '') || '0';

      const dashboard = {
        tasks,
        agents,
        disputes: visibleDisputes,
        agentRuns: visibleAgentRuns,
        deliverables: visibleDeliverables,
        metrics: {
          totalVolume: money(totalVolume),
          activeStreams,
          completedTasks: completedTasksCount,
          protectedValue: money(protectedValue)
        },
        mode: 'arc',
        agentAutomation: arenaAutopilot.snapshots(agents.map((agent) => agent.agentAddress))
      };

      response.json(dashboard);
    } catch(e) { next(e); }
  });

  app.get('/api/leaderboard/pg', async (request, response, next) => {
    try {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const { agentService } = await import('./services/agent.service.js');
      const agentsList = await agentRepository.findAll();
      const agents = await Promise.all(agentsList.map(a => agentService.getReputation(a.agentAddress)));
      agents.sort((a, b) => b.score - a.score || a.agentAddress.localeCompare(b.agentAddress));
      response.json(agents);
    } catch(e) { next(e); }
  });

  // Legacy in-memory registration
  app.post('/api/agents', async (request, response) => {
    const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
    const address = text(body.agentAddress).trim();
    const displayName = text(body.displayName).trim();
    if (!ETHEREUM_ADDRESS.test(address)) throw new ApiProblem(400, 'INVALID_AGENT_ADDRESS', 'agentAddress must be a 20-byte hex address');
    if (displayName.length < 2 || displayName.length > 80) throw new ApiProblem(400, 'INVALID_AGENT_NAME', 'displayName must contain 2..80 characters');
    authorizeAddress(request, address, 'Only the agent wallet owner can register this profile');
    const manifest = body.capabilityManifest === undefined ? undefined : validateCapabilityManifest(body.capabilityManifest);
    await assertAgentSignature(body, address, manifest);
    const agent = store.registerAgent({
      agentAddress: address,
      displayName,
      capabilityManifest: manifest
    });
    const automation = arenaAutopilot.enroll(address);
    response.status(201).json({ ...agent, automation });
  });

  // Production PostgreSQL registration for Agents (Third-Party Registration)
  app.post('/api/agents/pg', async (request, response, next) => {
    try {
      const { agentRepository } = await import('./repositories/agent.repository.js');

      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      const { displayName, capabilityManifest, provisionWallet } = body;
      const requestedName = text(displayName).trim() || 'New AI Agent';
      if (requestedName.length < 2 || requestedName.length > 80) throw new ApiProblem(400, 'INVALID_AGENT_NAME', 'displayName must contain 2..80 characters');
      const submittedManifest = capabilityManifest === undefined ? undefined : validateCapabilityManifest(capabilityManifest);
      const manifest = submittedManifest ?? defaultExternalManifest();

      if (provisionWallet !== true) {
        throw new ApiProblem(400, 'CIRCLE_WALLET_REQUIRED', 'Every PACT agent must use a dedicated Circle smart wallet');
      }
      const identity = requestIdentity(request);
      if (identity?.kind !== 'wallet') {
        throw new ApiProblem(401, 'CONTROLLER_WALLET_REQUIRED', 'Connect and authenticate the human controller wallet before creating a Circle agent wallet');
      }
      const provisioned = await createArcSponsoredWallet();
      const finalAddress = provisioned.wallet.address;
      if (!finalAddress) throw new ApiProblem(502, 'CIRCLE_WALLET_ADDRESS_MISSING', 'Circle did not return an Arc wallet address');
      if (!provisioned.wallet.id) throw new ApiProblem(502, 'CIRCLE_WALLET_ID_MISSING', 'Circle did not return a wallet ID');

      if (!ETHEREUM_ADDRESS.test(finalAddress)) throw new ApiProblem(502, 'INVALID_PROVISIONED_ADDRESS', 'Circle did not return a valid agent wallet address');

      const agent = {
        agentAddress: finalAddress.toLowerCase(),
        displayName: requestedName,
        // ReputationRegistry starts every new on-chain identity at 100.
        score: 100,
        completedTasks: 0,
        failedTasks: 0,
        totalVolumeStreamed: '0',
        platformPoints: 0,
        lastUpdated: Math.floor(Date.now() / 1000),
        capabilityManifest: manifest,
        walletProvider: 'CIRCLE' as const,
        walletAccountType: 'SCA' as const,
        controllerAddress: identity.subject.toLowerCase(),
        circleWalletId: provisioned.wallet.id,
        circleWalletSetId: provisioned.walletSetId,
      };
      await agentRepository.create(agent);
      // Live agents are never auto-solved by the server. A registered agent
      // must use its own runtime/API key or an explicitly integrated worker.
      const automation = arenaAutopilot.snapshot(finalAddress);
      response.status(201).json({
        message: 'Agent registered; connect its authenticated runtime to begin work',
        agent: {
          ...agent,
          // Circle resource IDs are operational metadata and never leave the API.
          circleWalletId: undefined,
          circleWalletSetId: undefined,
        },
        automation,
      });
    } catch (e) { next(e); }
  });

  // Production PostgreSQL registration for Clients (Заказчики)
  app.post('/api/agents/pg/:agentAddress/circle/actions', async (request, response, next) => {
    try {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const agentAddress = text(request.params.agentAddress).trim().toLowerCase();
      const agent = await agentRepository.findByAddress(agentAddress);
      if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent not found');
      if (agent.walletProvider !== 'CIRCLE' || agent.walletAccountType !== 'SCA' || !agent.circleWalletId) {
        throw new ApiProblem(409, 'CIRCLE_WALLET_REQUIRED', 'This agent does not use a Circle smart wallet');
      }
      const identity = requestIdentity(request);
      if (identity?.kind !== 'wallet' || identity.subject.toLowerCase() !== agent.controllerAddress.toLowerCase()) {
        throw new ApiProblem(403, 'AGENT_CONTROLLER_REQUIRED', 'Only the authenticated controller wallet can authorize this agent action');
      }

      const action = text(request.body?.action).trim().toUpperCase();
      const taskId = text(request.body?.taskId).trim();
      if (!['CLAIM_TASK', 'APPROVE_COLLATERAL', 'POST_COLLATERAL', 'WITHDRAW_STREAM', 'PAUSE_DISPUTE'].includes(action)) {
        throw new ApiProblem(400, 'CIRCLE_ACTION_INVALID', 'Unsupported Circle agent action');
      }
      const task = await taskRepository.findById(taskId);
      if (!task) throw new ApiProblem(404, 'TASK_NOT_FOUND', 'Task not found');
      if (!task.chainTaskId || !/^[1-9][0-9]*$/.test(task.chainTaskId)) {
        throw new ApiProblem(409, 'TASK_NOT_FUNDED_ONCHAIN', 'Work order has no Arc StreamingVault task');
      }
      if (action === 'CLAIM_TASK') {
        if (task.status !== 'OPEN') throw new ApiProblem(409, 'TASK_NOT_OPEN', 'Only an open work order can be claimed');
        if (task.preferredAgentAddress && task.preferredAgentAddress !== agentAddress) {
          throw new ApiProblem(403, 'AGENT_INVITE_ONLY', 'This work order is reserved for another agent');
        }
      } else if (task.agentAddress !== agentAddress) {
        throw new ApiProblem(403, 'AGENT_TASK_MISMATCH', 'The Circle wallet can act only on work assigned to this agent');
      }
      if (action === 'WITHDRAW_STREAM' && task.status !== 'STREAMING') {
        throw new ApiProblem(409, 'STREAM_NOT_ACTIVE', 'Only an active stream can be withdrawn');
      }
      if (action === 'PAUSE_DISPUTE' && task.status !== 'STREAMING') {
        throw new ApiProblem(409, 'STREAM_NOT_ACTIVE', 'Only an active stream can be paused for dispute');
      }
      if ((action === 'APPROVE_COLLATERAL' || action === 'POST_COLLATERAL') && task.status !== 'ASSIGNED') {
        throw new ApiProblem(409, 'COLLATERAL_NOT_DUE', 'Collateral is available only after the claim receipt is recorded');
      }

      const vaultAddress = process.env.PACT_STREAMING_VAULT_ADDRESS ?? process.env.STREAMING_VAULT_ADDRESS ?? process.env.VAULT_ADDRESS;
      if (!vaultAddress || !ETHEREUM_ADDRESS.test(vaultAddress)) {
        throw new ApiProblem(503, 'STREAMING_VAULT_UNAVAILABLE', 'StreamingVault address is not configured');
      }
      const chainTaskId = BigInt(task.chainTaskId);
      let contractAddress = getAddress(vaultAddress);
      let callData: `0x${string}`;
      if (action === 'CLAIM_TASK') {
        callData = encodeFunctionData({ abi: CIRCLE_AGENT_VAULT_ABI, functionName: 'claimOpenTask', args: [chainTaskId] });
      } else if (action === 'APPROVE_COLLATERAL') {
        const usdcAddress = process.env.ARC_USDC_ADDRESS;
        if (!usdcAddress || !ETHEREUM_ADDRESS.test(usdcAddress)) {
          throw new ApiProblem(503, 'ARC_USDC_UNAVAILABLE', 'ARC_USDC_ADDRESS is not configured');
        }
        contractAddress = getAddress(usdcAddress);
        callData = encodeFunctionData({
          abi: CIRCLE_AGENT_ERC20_ABI,
          functionName: 'approve',
          args: [getAddress(vaultAddress), parseUnits(task.collateralLocked, 6)],
        });
      } else if (action === 'POST_COLLATERAL') {
        callData = encodeFunctionData({ abi: CIRCLE_AGENT_VAULT_ABI, functionName: 'postCollateral', args: [chainTaskId] });
      } else if (action === 'WITHDRAW_STREAM') {
        callData = encodeFunctionData({ abi: CIRCLE_AGENT_VAULT_ABI, functionName: 'withdrawStreamed', args: [chainTaskId] });
      } else {
        callData = encodeFunctionData({ abi: CIRCLE_AGENT_VAULT_ABI, functionName: 'pauseForDispute', args: [chainTaskId] });
      }

      const transaction = await submitArcContractCall({
        walletId: agent.circleWalletId,
        contractAddress,
        callData,
        refId: `PACT:${action}:${task.id}`,
      });
      response.status(202).json({ id: transaction.id, state: transaction.state, action, taskId: task.id });
    } catch (error) { next(error); }
  });

  app.get('/api/agents/pg/:agentAddress/circle/transactions/:transactionId', async (request, response, next) => {
    try {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const agent = await agentRepository.findByAddress(text(request.params.agentAddress).trim().toLowerCase());
      if (!agent || !agent.circleWalletId) throw new ApiProblem(404, 'CIRCLE_WALLET_NOT_FOUND', 'Circle agent wallet not found');
      const identity = requestIdentity(request);
      if (identity?.kind !== 'wallet' || identity.subject.toLowerCase() !== agent.controllerAddress.toLowerCase()) {
        throw new ApiProblem(403, 'AGENT_CONTROLLER_REQUIRED', 'Only the authenticated controller wallet can inspect this transaction');
      }
      const transaction = await getCircleTransaction(text(request.params.transactionId));
      if (transaction.walletId !== agent.circleWalletId) {
        throw new ApiProblem(404, 'CIRCLE_TRANSACTION_NOT_FOUND', 'Transaction does not belong to this agent wallet');
      }
      response.json({
        id: transaction.id,
        state: transaction.state,
        txHash: transaction.txHash ?? null,
        blockchain: transaction.blockchain,
        createDate: transaction.createDate,
        updateDate: transaction.updateDate,
        errorReason: transaction.errorReason ?? null,
      });
    } catch (error) { next(error); }
  });

  app.post('/api/clients/pg', async (request, response, next) => {
    try {
      const { clientRepository } = await import('./repositories/client.repository.js');
      const address = request.body.address;
      if (!address) throw new ApiProblem(400, 'BAD_REQUEST', 'address is required');
      const client = {
        clientAddress: address.toLowerCase(),
        displayName: request.body.displayName || 'New Client',
        totalSpent: '0',
        tasksCreated: 0,
        createdAt: Math.floor(Date.now() / 1000)
      };
      await clientRepository.create(client);
      response.status(201).json({ message: 'Client registered in PostgreSQL', client });
    } catch (e) { next(e); }
  });

  app.get('/api/tasks', (request, response) => response.json(store.listTasks(text(request.query.status) || undefined)));
  app.post('/api/tasks', async (request, response) => {
    authorizeAddress(request, text(request.body?.creatorAddress), 'Only the connected creator wallet can publish this work order');
    await assertCreatorSignature(request.body ?? {});
    response.status(201).json(store.createTask(request.body));
  });

  // Production PostgreSQL routes for Tasks
  app.get('/api/tasks/pg', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const status = text(request.query.status)?.toUpperCase() as any;
      const tasks = await taskRepository.findAll(status || undefined);
      response.json(tasks);
    } catch(e) { next(e); }
  });

  app.post('/api/tasks/pg', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const input = request.body;
      if (!input || typeof input !== 'object') throw new ApiProblem(400, 'INVALID_BODY', 'A JSON request body is required');
      if (typeof input.title !== 'string' || input.title.trim().length === 0 || input.title.trim().length > 255) throw new ApiProblem(400, 'INVALID_TITLE', 'title must contain 1..255 characters');
      if (typeof input.creatorAddress !== 'string' || !ETHEREUM_ADDRESS.test(input.creatorAddress.trim())) throw new ApiProblem(400, 'INVALID_CREATOR', 'creatorAddress must be a 20-byte hex address');
      authorizeAddress(request, input.creatorAddress, 'Only the connected creator wallet can publish this work order');
      const total = typeof input.totalAmount === 'number' ? input.totalAmount : Number(input.totalAmount);
      if (!Number.isFinite(total) || total <= 0 || total > 1_000_000_000) throw new ApiProblem(400, 'INVALID_AMOUNT', 'totalAmount must be between 0 and 1,000,000,000 USDC');
      const estimatedDurationSeconds = input.estimatedDurationSeconds == null ? DEFAULT_TASK_DURATION_SECONDS : Number(input.estimatedDurationSeconds);
      if (!Number.isInteger(estimatedDurationSeconds) || estimatedDurationSeconds <= 0 || estimatedDurationSeconds > 31_536_000) throw new ApiProblem(400, 'INVALID_DURATION', 'estimatedDurationSeconds must be an integer from 1 second to 365 days when provided');
      if (typeof input.description !== 'undefined' && (typeof input.description !== 'string' || input.description.length > 50_000)) throw new ApiProblem(400, 'INVALID_DESCRIPTION', 'description must be at most 50000 characters');
      if (typeof input.successCriteria !== 'undefined' && (typeof input.successCriteria !== 'string' || input.successCriteria.length > 50_000)) throw new ApiProblem(400, 'INVALID_CRITERIA', 'successCriteria must be at most 50000 characters');

      const workOrder = validateWorkOrderSpec(input.workOrder ?? defaultWorkOrderForTask(input));
      const preferredAgentAddress = input.preferredAgentAddress == null || input.preferredAgentAddress === ''
        ? null
        : text(input.preferredAgentAddress).trim().toLowerCase();
      if (preferredAgentAddress) {
        if (!ETHEREUM_ADDRESS.test(preferredAgentAddress)) throw new ApiProblem(400, 'INVALID_PREFERRED_AGENT', 'preferredAgentAddress must be a 20-byte hex address');
        const { agentService } = await import('./services/agent.service.js');
        await agentService.getReputation(preferredAgentAddress);
      }

      await assertCreatorSignature(input);

      const money = (value: number) => Math.max(0, value).toFixed(6).replace(/\.?0+$/, '') || '0';
      let verifiedFunding: { chainTaskId: string; fundingTransactionHash: string } | undefined;
      if (process.env.PACT_MODE === 'arc') {
        if (!arcSettlement) throw new ApiProblem(503, 'ARC_SETTLEMENT_UNAVAILABLE', 'Arc settlement gateway is unavailable');
        const fundingTransactionHash = text(input.fundingTransactionHash).trim().toLowerCase();
        if (!fundingTransactionHash) {
          throw new ApiProblem(400, 'FUNDING_TX_REQUIRED', 'Fund the work order in StreamingVault before publishing it');
        }
        const existingFunding = await taskRepository.findByFundingTransactionHash(fundingTransactionHash);
        if (existingFunding) {
          const sameRequest = existingFunding.creatorAddress.toLowerCase() === input.creatorAddress.toLowerCase()
            && existingFunding.title === input.title.trim()
            && Number(existingFunding.totalAmount) === total;
          if (sameRequest) {
            response.json(existingFunding);
            return;
          }
          throw new ApiProblem(409, 'FUNDING_TX_ALREADY_USED', 'This funding transaction is already attached to a work order');
        }
        try {
          const funding = await arcSettlement.verifyOpenTaskFunding({
            creatorAddress: input.creatorAddress,
            totalAmount: money(total),
            ratePerSecond: money(Math.ceil(total * 1_000_000 / estimatedDurationSeconds) / 1_000_000),
            preferredAgentAddress,
            transactionHash: fundingTransactionHash,
          });
          const existingTask = await taskRepository.findByChainTaskId(funding.chainTaskId);
          if (existingTask) {
            throw new ApiProblem(409, 'CHAIN_TASK_ALREADY_USED', 'This on-chain work order is already published');
          }
          verifiedFunding = {
            chainTaskId: funding.chainTaskId,
            fundingTransactionHash: funding.transactionHash,
          };
        } catch (error) {
          if (error instanceof ApiProblem) throw error;
          if (error instanceof ArcSettlementError) {
            throw new ApiProblem(422, error.code, error.message);
          }
          throw error;
        }
      }

      const taskData = {
        title: input.title.trim(),
        description: input.description?.trim() ?? '',
        successCriteria: input.successCriteria?.trim() ?? '',
        creatorAddress: input.creatorAddress.trim().toLowerCase(),
        preferredAgentAddress,
        agentAddress: null,
        totalAmount: money(total),
        estimatedDurationSeconds,
        streamRatePerSecond: money(Math.ceil(total * 1_000_000 / estimatedDurationSeconds) / 1_000_000),
        status: 'OPEN' as any,
        collateralLocked: '0',
        accruedAmount: '0',
        withdrawnAmount: '0',
        startedAt: null,
        completedAt: null,
        templateId: input.templateId ?? null,
        terms: null,
        workOrder,
      };

      const task = await taskRepository.create(taskData, verifiedFunding);
      response.status(201).json(task);
    } catch(e) { next(e); }
  });
  app.get('/api/tasks/:id', (request, response) => response.json(store.getTask(request.params.id)));
  app.patch('/api/tasks/:id', (request, response) => {
    authorizeAddress(request, store.getTask(request.params.id).creatorAddress, 'Only the task creator can edit this work order');
    response.json(store.updateTask(request.params.id, request.body));
  });
  app.put('/api/tasks/:id', (request, response) => {
    authorizeAddress(request, store.getTask(request.params.id).creatorAddress, 'Only the task creator can edit this work order');
    response.json(store.updateTask(request.params.id, request.body));
  });
  app.delete('/api/tasks/:id', (request, response) => {
    authorizeAddress(request, store.getTask(request.params.id).creatorAddress, 'Only the task creator can delete this work order');
    store.deleteTask(request.params.id);
    response.status(204).end();
  });
  app.post('/api/tasks/:id/claim', (request, response) => {
    const agentAddress = text(request.body?.agentAddress);
    authorizeWalletOrAgent(request, agentAddress, 'Only the selected agent can claim this work order');
    response.json(store.claimTask(request.params.id, agentAddress));
  });

  // PostgreSQL versions for Task ID ops
  app.get('/api/tasks/pg/:id', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      response.json(task);
    } catch(e) { next(e); }
  });

  app.patch('/api/tasks/pg/:id', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const existing = await taskRepository.findById(request.params.id);
      if (!existing) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      authorizeAddress(request, existing.creatorAddress, 'Only the task creator can edit this work order');
      if (process.env.PACT_MODE === 'arc' && existing.status !== 'OPEN') {
        throw new ApiProblem(409, 'FUNDED_TASK_IMMUTABLE', 'A funded work order cannot be edited after an agent has claimed it');
      }
      const task = await taskRepository.update(request.params.id, request.body);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      response.json(task);
    } catch(e) { next(e); }
  });

  app.delete('/api/tasks/pg/:id', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const existing = await taskRepository.findById(request.params.id);
      if (!existing) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      authorizeAddress(request, existing.creatorAddress, 'Only the task creator can delete this work order');
      if (process.env.PACT_MODE === 'arc') {
        throw new ApiProblem(405, 'ONCHAIN_CANCELLATION_REQUIRED', 'Funded work orders must be cancelled through StreamingVault so escrow is refunded');
      }
      await taskRepository.delete(request.params.id);
      response.status(204).end();
    } catch(e) { next(e); }
  });

  app.post('/api/tasks/pg/:id/cancel', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      authorizeAddress(request, task.creatorAddress, 'Only the task creator can cancel this work order');
      if (process.env.PACT_MODE !== 'arc' || !arcSettlement) {
        throw new ApiProblem(405, 'ARC_ONLY', 'On-chain cancellation is only available in Arc mode');
      }
      if (task.status !== 'OPEN' || task.agentAddress) {
        throw new ApiProblem(409, 'TASK_NOT_CANCELLABLE', 'Only an unclaimed open work order can be cancelled');
      }
      if (!task.chainTaskId) throw new ApiProblem(409, 'CHAIN_TASK_MISSING', 'The work order has no Arc task ID');
      const cancellationTransactionHash = text(request.body?.cancellationTransactionHash).trim().toLowerCase();
      if (!cancellationTransactionHash) {
        throw new ApiProblem(400, 'CANCELLATION_TX_REQUIRED', 'Cancel the work order in StreamingVault before updating PACT');
      }
      try {
        await arcSettlement.verifyTaskCancelled({
          chainTaskId: task.chainTaskId,
          creatorAddress: task.creatorAddress,
          transactionHash: cancellationTransactionHash,
        });
      } catch (error) {
        if (error instanceof ArcSettlementError) throw new ApiProblem(422, error.code, error.message);
        throw error;
      }
      const updated = await taskRepository.update(task.id, {
        status: 'CANCELLED',
        settlementTransactionHash: cancellationTransactionHash,
      });
      response.json(updated);
    } catch (e) { next(e); }
  });

  app.post('/api/tasks/pg/:id/claim', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { agentService } = await import('./services/agent.service.js');
      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      if (task.status !== 'OPEN') throw new ApiProblem(409, 'NOT_OPEN', 'Task is not open');

      const agentAddress = text(request.body?.agentAddress).trim();
      if (!ETHEREUM_ADDRESS.test(agentAddress)) throw new ApiProblem(400, 'INVALID_AGENT_ADDRESS', 'agentAddress must be a 20-byte hex address');
      authorizeWalletOrAgent(request, agentAddress, 'Only the selected agent can claim this work order');
      if (task.preferredAgentAddress && task.preferredAgentAddress !== agentAddress.toLowerCase()) {
        throw new ApiProblem(403, 'AGENT_INVITE_ONLY', 'This work order is reserved for the invited agent', { invitedAgentAddress: task.preferredAgentAddress });
      }
      const reputation = await agentService.getReputation(agentAddress);
      const category = inferTaskCategory(task);
      if (!manifestSupportsTaskCategory(reputation.capabilityManifest, category)) {
        throw new ApiProblem(403, 'CAPABILITY_MISMATCH', `Agent manifest does not declare a capability for this ${category?.toLowerCase() ?? 'work'} brief`, {
          category,
          capabilities: reputation.capabilityManifest.capabilities.map((capability) => capability.id)
        });
      }
      if (!manifestSupportsWorkOrder(reputation.capabilityManifest, task.workOrder)) {
        throw new ApiProblem(403, 'CAPABILITY_MISMATCH', 'Agent manifest does not satisfy the capabilities required by this work order', {
          requiredCapabilities: task.workOrder?.requiredCapabilities ?? [],
          capabilities: reputation.capabilityManifest.capabilities.map((capability) => capability.id)
        });
      }
      const maximum = reputation.terms.maxTaskSize === null ? Infinity : Number(reputation.terms.maxTaskSize);
      if (Number(task.totalAmount) > maximum) {
        throw new ApiProblem(403, 'REPUTATION_TOO_LOW', `Agent score ${reputation.score} permits tasks up to ${reputation.terms.maxTaskSize} USDC`, {
          score: reputation.score,
          maxTaskSize: reputation.terms.maxTaskSize
        });
      }

      let assignmentTransactionHash: string | null = null;
      if (process.env.PACT_MODE === 'arc') {
        if (!arcSettlement) throw new ApiProblem(503, 'ARC_SETTLEMENT_UNAVAILABLE', 'Arc settlement gateway is unavailable');
        if (!task.chainTaskId) throw new ApiProblem(409, 'TASK_NOT_FUNDED_ONCHAIN', 'Work order has no Arc StreamingVault task');
        assignmentTransactionHash = text(request.body?.assignmentTransactionHash).trim().toLowerCase();
        if (!assignmentTransactionHash) {
          throw new ApiProblem(400, 'ASSIGNMENT_TX_REQUIRED', 'The agent must sign claimOpenTask before the API records the assignment');
        }
        try {
          assignmentTransactionHash = await arcSettlement.verifyAgentClaimed({
            chainTaskId: task.chainTaskId,
            agentAddress,
            transactionHash: assignmentTransactionHash,
          });
        } catch (error) {
          if (error instanceof ArcSettlementError) {
            throw new ApiProblem(422, error.code, error.message);
          }
          throw error;
        }
      }

      const updated = await taskRepository.update(request.params.id, {
        status: 'ASSIGNED',
        agentAddress: agentAddress.toLowerCase(),
        collateralLocked: (Number(task.totalAmount) * reputation.terms.collateralPct / 100).toFixed(6).replace(/\.?0+$/, '') || '0',
        terms: reputation.terms,
        assignmentTransactionHash
      });
      response.json(updated);
    } catch(e) { next(e); }
  });

  app.post('/api/tasks/pg/:id/start', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      if (task.status !== 'ASSIGNED') throw new ApiProblem(409, 'TASK_NOT_ASSIGNED', 'Task is not waiting for collateral');
      if (!task.agentAddress) throw new ApiProblem(409, 'TASK_UNASSIGNED', 'Task has no assigned agent');
      authorizeWalletOrAgent(request, task.agentAddress, 'Only the assigned agent can activate this stream');
      if (!task.chainTaskId) throw new ApiProblem(409, 'TASK_NOT_FUNDED_ONCHAIN', 'Work order has no Arc StreamingVault task');
      if (!arcSettlement) throw new ApiProblem(503, 'ARC_SETTLEMENT_UNAVAILABLE', 'Arc settlement gateway is unavailable');

      const collateralTransactionHash = text(request.body?.collateralTransactionHash).trim().toLowerCase();
      if (!collateralTransactionHash) {
        throw new ApiProblem(400, 'COLLATERAL_TX_REQUIRED', 'Post the required collateral in StreamingVault before starting work');
      }
      try {
        await arcSettlement.verifyCollateralPosted({
          chainTaskId: task.chainTaskId,
          agentAddress: task.agentAddress,
          transactionHash: collateralTransactionHash,
        });
        const updated = await taskRepository.update(task.id, {
          status: 'STREAMING',
          startedAt: Math.floor(Date.now() / 1000),
          collateralTransactionHash,
          // StreamingVault starts a public work order atomically in the same
          // agent-signed transaction that locks collateral.
          streamStartTransactionHash: collateralTransactionHash,
        });
        response.json(updated);
      } catch (error) {
        if (error instanceof ArcSettlementError) {
          throw new ApiProblem(422, error.code, error.message);
        }
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/templates/pg', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const templates = await taskRepository.findActiveTemplates();
      response.json(templates);
    } catch(e) { next(e); }
  });

  app.post('/api/templates/pg/:id/claim', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { agentService } = await import('./services/agent.service.js');
      const templateId = request.params.id;
      const template = await taskRepository.findTemplateById(templateId);
      if (!template || !template.isActive) throw new ApiProblem(404, 'NOT_FOUND', 'Active template not found');

      const agentAddress = text(request.body?.agentAddress).trim();
      if (!ETHEREUM_ADDRESS.test(agentAddress)) throw new ApiProblem(400, 'INVALID_AGENT_ADDRESS', 'agentAddress must be a 20-byte hex address');
      authorizeWalletOrAgent(request, agentAddress, 'Only the selected agent can claim this platform task');
      const reputation = await agentService.getReputation(agentAddress);

      const money = (value: number) => Math.max(0, value).toFixed(6).replace(/\.?0+$/, '') || '0';

      const taskData = {
        title: template.title,
        description: template.description,
        successCriteria: template.successCriteria,
        creatorAddress: DEMO_ADDRESSES.creator, // Platform is the creator
        agentAddress: agentAddress.toLowerCase(),
        totalAmount: '0',
        estimatedDurationSeconds: 60, // Training task default
        streamRatePerSecond: '0',
        status: 'ASSIGNED' as any,
        collateralLocked: '0',
        accruedAmount: '0',
        withdrawnAmount: '0',
        startedAt: Math.floor(Date.now() / 1000), // Auto-start
        completedAt: null,
        templateId: template.id,
        terms: reputation.terms
      };

      const task = await taskRepository.create(taskData);
      response.status(201).json(task);
    } catch(e) { next(e); }
  });

  // Local PostgreSQL lifecycle helpers. Arc mode rejects these routes because
  // StreamingVault receipts are the only production settlement authority.
  app.post('/api/streams/pg/:id/withdraw', async (request, response, next) => {
    try {
      if (process.env.PACT_MODE === 'arc') {
        throw new ApiProblem(405, 'ONCHAIN_WITHDRAWAL_REQUIRED', 'Arc stream withdrawals must be submitted directly to StreamingVault');
      }
      const { taskRepository } = await import('./repositories/task.repository.js');
      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      if (!task.agentAddress) throw new ApiProblem(409, 'TASK_UNASSIGNED', 'Task has no assigned agent');
      if (!['STREAMING', 'PAUSED', 'COMPLETED'].includes(task.status)) throw new ApiProblem(409, 'STREAM_NOT_WITHDRAWABLE', 'Stream is not withdrawable');

      const now = Math.floor(Date.now() / 1000);
      const accrued = task.status === 'STREAMING' && task.startedAt
        ? Math.min(Number(task.totalAmount), Math.max(Number(task.accruedAmount), (now - task.startedAt) * Number(task.streamRatePerSecond)))
        : Number(task.accruedAmount);
      const available = Math.max(0, accrued - Number(task.withdrawnAmount));
      if (available <= 0) throw new ApiProblem(409, 'NOTHING_TO_WITHDRAW', 'No streamed funds are currently available');

      const updated = await taskRepository.update(request.params.id, {
        accruedAmount: accrued.toFixed(6).replace(/\.?0+$/, '') || '0',
        withdrawnAmount: (Number(task.withdrawnAmount) + available).toFixed(6).replace(/\.?0+$/, '') || '0'
      });
      response.json(updated);
    } catch (e) { next(e); }
  });

  app.post('/api/streams/pg/:id/complete', async (request, response, next) => {
    try {
      if (process.env.PACT_MODE === 'arc') {
        throw new ApiProblem(405, 'ONCHAIN_COMPLETION_REQUIRED', 'Arc work orders are completed by the creator through StreamingVault and the deliverable acceptance endpoint');
      }
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      if (!['STREAMING', 'PAUSED'].includes(task.status)) throw new ApiProblem(409, 'TASK_NOT_COMPLETABLE', 'Task is not active');
      const deliverable = (await deliverableRepository.findByTaskId(task.id)).find((item) => item.status === 'SUBMITTED');
      if (!deliverable) throw new ApiProblem(409, 'DELIVERABLE_REQUIRED', 'A submitted deliverable with evidence is required before completion');

      await deliverableRepository.update(deliverable.id, { status: 'ACCEPTED', reviewedAt: Math.floor(Date.now() / 1000) });
      const updated = await taskRepository.update(task.id, {
        status: 'COMPLETED',
        accruedAmount: task.totalAmount,
        collateralLocked: '0',
        completedAt: Math.floor(Date.now() / 1000)
      });
      response.json(updated);
    } catch (e) { next(e); }
  });

  app.get('/api/agents/pg/:agentAddress/capabilities', async (request, response, next) => {
    try {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const agent = await agentRepository.findByAddress(request.params.agentAddress.toLowerCase());
      if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent not found');
      response.json(agent.capabilityManifest);
    } catch (e) { next(e); }
  });

  app.put('/api/agents/pg/:agentAddress/capabilities', async (request, response, next) => {
    try {
      authorizeAddress(request, request.params.agentAddress, 'Only the agent owner wallet can update capabilities');
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const manifest = validateCapabilityManifest(request.body);
      const agentAddress = text(request.params.agentAddress);
      const agent = await agentRepository.updateCapabilities(agentAddress, manifest);
      if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent not found');
      response.json(agent.capabilityManifest);
    } catch (e) { next(e); }
  });

  app.get('/api/reputation/:agentAddress', (request, response) => response.json(store.reputation(text(request.params.agentAddress))));
  app.post('/api/reputation/recalculate/:agentAddress', requireOperator, (request, response) => response.json(store.recalculate(text(request.params.agentAddress))));
  app.get('/api/agents/:agentAddress/capabilities', (request, response) => response.json(store.capabilities(text(request.params.agentAddress))));
  app.put('/api/agents/:agentAddress/capabilities', (request, response) => {
    const agentAddress = text(request.params.agentAddress);
    authorizeAddress(request, agentAddress, 'Only the agent owner wallet can update capabilities');
    response.json(store.updateCapabilities(agentAddress, request.body));
  });
  app.post('/api/agents/:agentAddress/traces', (request, response) => {
    const agentAddress = text(request.params.agentAddress);
    authorizeWalletOrAgent(request, agentAddress, 'Only the assigned agent runtime can submit its execution trace');
    response.status(201).json(store.addExecutionTrace(agentAddress, request.body));
  });
  app.get('/api/training/status', (_request, response) => response.json(store.trainingStatus()));
  app.get('/api/training/traces', requireOperator, (_request, response) => response.json(store.trainingTraces()));
  app.get('/api/training/review-queue', requireOperator, (_request, response) => response.json(store.trainingReviewQueue()));
  app.post('/api/training/traces/:id/review', requireOperator, (request, response) => {
    const status = text(request.body?.status);
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      throw new ApiProblem(400, 'INVALID_TRACE_REVIEW', 'status must be APPROVED or REJECTED');
    }
    response.json(store.reviewTrainingTrace(text(request.params.id), status as 'APPROVED' | 'REJECTED', humanReviewerId));
  });

  app.get('/api/agent-runtime', (_request, response) => response.json(agentRuntime.describe()));
  app.get('/api/agent-runs', requireOperator, (_request, response) => response.json(store.listAgentRuns()));
  app.get('/api/agent-runs/:id', requireAuth, (request, response) => {
    const run = store.getAgentRun(text(request.params.id));
    authorizeWalletOrAgent(request, run.agentAddress, 'Only the assigned agent or operator can view this run');
    response.json(run);
  });
  app.post('/api/agent-runs', async (request, response) => {
    const taskId = text(request.body?.taskId);
    const agentAddress = text(request.body?.agentAddress);
    if (!taskId || !agentAddress) throw new ApiProblem(400, 'INVALID_AGENT_RUN', 'taskId and agentAddress are required');
    authorizeWalletOrAgent(request, agentAddress, 'Only the selected agent can start its runtime');
    response.status(201).json(await agentRuntime.run(taskId, agentAddress));
  });

  // Production PostgreSQL routes for Agent Runs
  app.get('/api/agent-runs/pg', requireOperator, async (request, response, next) => {
    try {
      const { agentRunRepository } = await import('./repositories/agent-run.repository.js');
      response.json(await agentRunRepository.findAll());
    } catch(e) { next(e); }
  });

  app.get('/api/agent-runs/pg/:id', requireAuth, async (request, response, next) => {
    try {
      const { agentRunRepository } = await import('./repositories/agent-run.repository.js');
      const run = await agentRunRepository.findById(text(request.params.id));
      if (!run) throw new ApiProblem(404, 'NOT_FOUND', 'Agent run not found');
      authorizeWalletOrAgent(request, run.agentAddress, 'Only the assigned agent or operator can view this run');
      response.json(run);
    } catch(e) { next(e); }
  });

  app.post('/api/agent-runs/pg', async (request, response, next) => {
    try {
      const taskId = text(request.body?.taskId);
      const agentAddress = text(request.body?.agentAddress);
      if (!taskId || !agentAddress) throw new ApiProblem(400, 'INVALID_AGENT_RUN', 'taskId and agentAddress are required');
      await authorizeAgentExecution(request, agentAddress);
      response.status(201).json(await agentRuntime.run(taskId, agentAddress, true));
    } catch(e) { next(e); }
  });

  app.get('/api/deliverables', requireOperator, (_request, response) => response.json(store.listDeliverables()));
  app.get('/api/deliverables/:id', requireAuth, (request, response) => {
    const deliverable = store.getDeliverable(text(request.params.id));
    authorizeWalletOrAgent(request, deliverable.agentAddress, 'Only the assigned agent or operator can view this deliverable');
    response.json(deliverable);
  });
  app.post('/api/tasks/:id/deliverables', (request, response) => {
    const agentAddress = text(request.body?.agentAddress);
    authorizeWalletOrAgent(request, agentAddress, 'Only the assigned agent can submit a deliverable');
    response.status(201).json(store.submitDeliverable(request.params.id, agentAddress, request.body));
  });
  app.post('/api/deliverables/:id/accept', (request, response) => {
    const deliverable = store.getDeliverable(request.params.id);
    authorizeAddress(request, store.getTask(deliverable.taskId).creatorAddress, 'Only the task creator can accept the deliverable');
    response.json(store.acceptDeliverable(request.params.id));
  });

  // Production PostgreSQL routes for Deliverables
  app.get('/api/deliverables/pg', requireOperator, async (request, response, next) => {
    try {
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      response.json(await deliverableRepository.findAll());
    } catch(e) { next(e); }
  });

  app.get('/api/deliverables/pg/:id', requireAuth, async (request, response, next) => {
    try {
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const deliverable = await deliverableRepository.findById(text(request.params.id));
      if (!deliverable) throw new ApiProblem(404, 'NOT_FOUND', 'Deliverable not found');
      const task = await taskRepository.findById(deliverable.taskId);
      if (!task) throw new ApiProblem(404, 'TASK_NOT_FOUND', 'The work order for this deliverable no longer exists');
      const identity = requestIdentity(request);
      const participant = identity?.kind === 'operator'
        || (identity?.kind === 'wallet' && identity.subject.toLowerCase() === task.creatorAddress.toLowerCase())
        || ((identity?.kind === 'wallet' || identity?.kind === 'agent') && identity.subject.toLowerCase() === deliverable.agentAddress.toLowerCase());
      if (!participant) throw new ApiProblem(403, 'DELIVERABLE_FORBIDDEN', 'Only work-order participants can view this deliverable');
      response.json(deliverable);
    } catch(e) { next(e); }
  });

  app.post('/api/tasks/pg/:id/deliverables', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');

      const task = await taskRepository.findById(request.params.id);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');

      const agentAddress = text(request.body?.agentAddress);
      authorizeWalletOrAgent(request, agentAddress, 'Only the assigned agent can submit a deliverable');
      if (!agentAddress || task.agentAddress?.toLowerCase() !== agentAddress.toLowerCase()) {
        throw new ApiProblem(403, 'DELIVERABLE_AGENT_MISMATCH', 'Only the assigned agent may submit a deliverable');
      }

      const summary = text(request.body?.summary);
      if (!summary || summary.length < 12) throw new ApiProblem(400, 'INVALID_SUMMARY', 'summary must contain 12+ characters');

      const artifacts = request.body.artifacts || [];
      const evidence = request.body.evidence || [];

      const deliverable = await deliverableRepository.create({
        taskId: task.id,
        agentAddress: agentAddress.toLowerCase(),
        summary,
        artifacts,
        evidence,
        status: 'SUBMITTED'
      });

      response.status(201).json(deliverable);
    } catch(e) { next(e); }
  });

  app.post('/api/deliverables/pg/:id/accept', async (request, response, next) => {
    try {
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { executionTraceRepository } = await import('./repositories/execution-trace.repository.js');

      const deliverable = await deliverableRepository.findById(request.params.id);
      if (!deliverable) throw new ApiProblem(404, 'NOT_FOUND', 'Deliverable not found');
      if (deliverable.status !== 'SUBMITTED') throw new ApiProblem(409, 'INVALID_STATUS', 'Deliverable is not submitted');
      const task = await taskRepository.findById(deliverable.taskId);
      if (!task) throw new ApiProblem(404, 'TASK_NOT_FOUND', 'The work order for this deliverable no longer exists');
      authorizeAddress(request, task.creatorAddress, 'Only the task creator can accept the deliverable');

      let completionTransactionHash: string | null = null;
      if (process.env.PACT_MODE === 'arc') {
        if (!arcSettlement) throw new ApiProblem(503, 'ARC_SETTLEMENT_UNAVAILABLE', 'Arc settlement gateway is unavailable');
        if (!task.chainTaskId) throw new ApiProblem(409, 'TASK_NOT_FUNDED_ONCHAIN', 'Work order has no Arc StreamingVault task');
        completionTransactionHash = text(request.body?.completionTransactionHash).trim().toLowerCase();
        if (!completionTransactionHash) {
          throw new ApiProblem(400, 'COMPLETION_TX_REQUIRED', 'Complete the work order in StreamingVault before accepting the deliverable');
        }
        try {
          await arcSettlement.verifyTaskCompleted({
            chainTaskId: task.chainTaskId,
            creatorAddress: task.creatorAddress,
            transactionHash: completionTransactionHash,
          });
        } catch (error) {
          if (error instanceof ArcSettlementError) throw new ApiProblem(422, error.code, error.message);
          throw error;
        }
      }

      const updatedDeliverable = await deliverableRepository.update(deliverable.id, {
        status: 'ACCEPTED',
        reviewedAt: Math.floor(Date.now() / 1000)
      });

      // Mark task as completed only after the Arc receipt has been verified.
      const updatedTask = await taskRepository.update(deliverable.taskId, {
        status: 'COMPLETED',
        completedAt: Math.floor(Date.now() / 1000),
        completionTransactionHash,
        settlementTransactionHash: completionTransactionHash,
      });
      if (task.agentAddress) {
        const { agentRepository } = await import('./repositories/agent.repository.js');
        await agentRepository.recordCommercialOutcome(task.agentAddress, true, task.totalAmount);
        await executionTraceRepository.markOutcomeByTaskId(deliverable.taskId, 'SUCCESS', task.creatorAddress);
      }

      // Award platform points if it was a training task template.
      if (task.templateId) {
        const template = await taskRepository.findTemplateById(task.templateId);
        if (template && task.agentAddress) {
          const { agentRepository } = await import('./repositories/agent.repository.js');
          await agentRepository.awardPlatformPoints(task.agentAddress, template.rewardPoints);
        }
      }

      response.json({ deliverable: updatedDeliverable, task: updatedTask });
    } catch(e) { next(e); }
  });

  app.post('/api/streams/initiate', (request, response) => {
    authorizeWalletOrAgent(request, text(request.body?.agentAddress), 'Only the selected agent can initiate a stream');
    response.status(201).json(store.initiateStream(request.body));
  });
  app.get('/api/streams/:id/status', (request, response) => response.json(store.streamStatus(request.params.id)));
  app.post('/api/streams/:id/start', (request, response) => {
    const streamId = text(request.params.id);
    const task = store.getTask(streamId);
    if (!task.agentAddress) throw new ApiProblem(409, 'TASK_UNASSIGNED', 'Task has no agent');
    authorizeWalletOrAgent(request, task.agentAddress, 'Only the assigned agent can start the stream');
    response.json(store.startStream(streamId));
  });
  app.post('/api/streams/:id/withdraw', (request, response) => {
    const streamId = text(request.params.id);
    const task = store.getTask(streamId);
    if (!task.agentAddress) throw new ApiProblem(409, 'TASK_UNASSIGNED', 'Task has no agent');
    authorizeWalletOrAgent(request, task.agentAddress, 'Only the assigned agent can withdraw streamed funds');
    response.json(store.withdraw(streamId));
  });
  app.post('/api/streams/:id/complete', (request, response) => {
    const streamId = text(request.params.id);
    authorizeAddress(request, store.getTask(streamId).creatorAddress, 'Only the task creator can accept completion');
    response.json(store.completeTask(streamId));
  });

  app.get('/api/disputes', (request, response) => {
    const disputes = store.listDisputes();
    response.json(canReadSensitive(request) ? disputes : disputes.map(redactDispute));
  });
  app.post('/api/disputes', async (request, response) => {
    const taskId = text(request.body?.taskId);
    const reason = text(request.body?.reason);
    const evidence = text(request.body?.evidence);
    if (!reason.trim()) throw new ApiProblem(400, 'INVALID_REASON', 'reason is required');
    if (!evidence.trim()) throw new ApiProblem(400, 'INVALID_EVIDENCE', 'evidence is required');
    const evidenceLimit = Number(process.env.PACT_EVIDENCE_MAX_CHARS ?? 20_000);
    if (reason.length + evidence.length > evidenceLimit) {
      throw new ApiProblem(413, 'EVIDENCE_TOO_LARGE', `reason and evidence must fit within ${evidenceLimit} characters`);
    }
    const task = store.getTask(taskId);
    const identity = requestIdentity(request);
    const isCreator = identity?.kind === 'wallet' && identity.subject.toLowerCase() === task.creatorAddress.toLowerCase();
    const isAgent = task.agentAddress && (identity?.kind === 'wallet' || identity?.kind === 'agent') && identity.subject.toLowerCase() === task.agentAddress.toLowerCase();
    if (!allowAnonymousTestBypass(request) && identity?.kind !== 'operator' && !isCreator && !isAgent) {
      throw new ApiProblem(403, 'DISPUTE_PARTICIPANT_REQUIRED', 'Only the task creator, assigned agent, or operator can open a dispute');
    }
    const deliverable = store.listDeliverables().find((candidate) => candidate.taskId === taskId && ['SUBMITTED', 'DISPUTED', 'ACCEPTED'].includes(candidate.status)) ?? null;
    const decision = await arbitrator.decide({ task, reason, evidence, deliverable });
    response.status(201).json(store.createDispute(taskId, reason, evidence, decision));
  });
  app.get('/api/disputes/:id', (request, response) => {
    const dispute = store.getDispute(text(request.params.id));
    response.json(canReadSensitive(request) ? dispute : redactDispute(dispute));
  });
  app.post('/api/disputes/:id/human-review', requireOperator, (request, response) => {
    const verdict = text(request.body?.verdict);
    const reasoning = text(request.body?.reasoning);
    if (!['NO_FAULT', 'PARTIAL_FAULT', 'FULL_FAULT'].includes(verdict)) {
      throw new ApiProblem(400, 'INVALID_VERDICT', 'verdict must be NO_FAULT, PARTIAL_FAULT, or FULL_FAULT');
    }
    response.json(store.finalizeHumanReview(
      text(request.params.id),
      verdict as 'NO_FAULT' | 'PARTIAL_FAULT' | 'FULL_FAULT',
      reasoning,
      humanReviewerId
    ));
  });

  // Production PostgreSQL routes for Disputes
  app.get('/api/disputes/pg', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const disputes = await disputeRepository.findAll();
      const tasks = new Map((await taskRepository.findAll()).map((task) => [task.id, task]));
      const identity = requestIdentity(request);
      response.json(disputes.map((dispute) => {
        const task = tasks.get(dispute.taskId);
        const participant = identity?.kind === 'operator' || Boolean(identity && task && (
          (identity.kind === 'wallet' && identity.subject.toLowerCase() === task.creatorAddress.toLowerCase())
          || ((identity.kind === 'wallet' || identity.kind === 'agent') && identity.subject.toLowerCase() === task.agentAddress?.toLowerCase())
        ));
        return participant ? dispute : redactDispute(dispute);
      }));
    } catch(e) { next(e); }
  });

  app.get('/api/disputes/pg/:id', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const dispute = await disputeRepository.findById(text(request.params.id));
      if (!dispute) throw new ApiProblem(404, 'NOT_FOUND', 'Dispute not found');
      const task = await taskRepository.findById(dispute.taskId);
      const identity = requestIdentity(request);
      const participant = identity?.kind === 'operator' || Boolean(identity && task && (
        (identity.kind === 'wallet' && identity.subject.toLowerCase() === task.creatorAddress.toLowerCase())
        || ((identity.kind === 'wallet' || identity.kind === 'agent') && identity.subject.toLowerCase() === task.agentAddress?.toLowerCase())
      ));
      response.json(participant ? dispute : redactDispute(dispute));
    } catch(e) { next(e); }
  });

  app.post('/api/tasks/pg/:id/dispute', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const taskId = text(request.params.id);
      const task = await taskRepository.findById(taskId);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      const identity = requestIdentity(request);
      const isCreator = identity?.kind === 'wallet' && identity.subject.toLowerCase() === task.creatorAddress.toLowerCase();
      const assignedAgent = task.agentAddress ? await agentRepository.findByAddress(task.agentAddress) : null;
      const isAgent = Boolean(task.agentAddress && identity && (
        ((identity.kind === 'wallet' || identity.kind === 'agent') && identity.subject.toLowerCase() === task.agentAddress.toLowerCase())
        || (identity.kind === 'wallet' && assignedAgent?.walletProvider === 'CIRCLE' && identity.subject.toLowerCase() === assignedAgent.controllerAddress.toLowerCase())
      ));
      if (!isCreator && !isAgent) {
        throw new ApiProblem(403, 'DISPUTE_PARTICIPANT_REQUIRED', 'Only the task creator or assigned agent can open a dispute');
      }

      const reason = text(request.body?.reason);
      const evidence = text(request.body?.evidence);
      if (!reason?.trim()) throw new ApiProblem(400, 'INVALID_REASON', 'reason is required');
      if (!evidence?.trim()) throw new ApiProblem(400, 'INVALID_EVIDENCE', 'evidence is required');
      if (task.status !== 'STREAMING' && task.status !== 'PAUSED') {
        throw new ApiProblem(409, 'TASK_NOT_DISPUTABLE', 'Only an active or paused stream can be disputed');
      }
      if (process.env.PACT_MODE === 'arc' && (!arcSettlement || !task.chainTaskId)) {
        throw new ApiProblem(503, 'ARC_SETTLEMENT_UNAVAILABLE', 'Arc settlement is not ready for this work order');
      }

      let pauseTransactionHash: string | null = null;
      if (process.env.PACT_MODE === 'arc' && task.status === 'STREAMING') {
        pauseTransactionHash = text(request.body?.pauseTransactionHash).trim().toLowerCase();
        if (!pauseTransactionHash) throw new ApiProblem(400, 'PAUSE_TX_REQUIRED', 'A participant must sign pauseForDispute before arbitration begins');
        try {
          pauseTransactionHash = await arcSettlement!.verifyTaskPaused({
            chainTaskId: task.chainTaskId!,
            participantAddress: isCreator ? task.creatorAddress : task.agentAddress!,
            transactionHash: pauseTransactionHash,
          });
        } catch (error) {
          if (error instanceof ArcSettlementError) throw new ApiProblem(422, error.code, error.message);
          throw error;
        }
      }

      // The judge returns a fault classification. Settlement remains a separate contract operation.
      const deliverables = await deliverableRepository.findByTaskId(taskId);
      const deliverable = deliverables.find((candidate) => ['SUBMITTED', 'DISPUTED', 'ACCEPTED'].includes(candidate.status)) ?? null;
      const decision = await arbitrator.decide({ task, reason, evidence, deliverable });
      const slashPct = decision.verdict === 'FULL_FAULT' ? 100 : decision.verdict === 'PARTIAL_FAULT' ? 50 : decision.verdict === 'NO_FAULT' ? 0 : null;

      const dispute = await disputeRepository.create({
        taskId,
        reason,
        evidence,
        status: decision.verdict ? 'RESOLVED' : 'NEEDS_HUMAN_REVIEW',
        verdict: decision.verdict ?? null,
        slashPct,
        reasoning: decision.reasoning ?? null,
        arbitratorProvider: decision.provider ?? null,
        decisionConfidence: decision.confidence ?? null,
        arbitrationReceipt: decision.receipt ?? null,
        humanReview: null
      });

      let settlementTransactionHash: string | null = null;
      let nextTaskStatus: 'PAUSED' | 'STREAMING' | 'SLASHED' = 'PAUSED';
      if (process.env.PACT_MODE === 'arc' && decision.verdict && slashPct !== null) {
        const decisionHash = decision.receipt?.decisionHash?.startsWith('0x')
          ? decision.receipt.decisionHash
          : `0x${createHash('sha256').update(JSON.stringify({
            disputeId: dispute.id,
            taskId,
            verdict: decision.verdict,
            slashPct,
            reasoning: decision.reasoning,
            reasonHash: hashSecret(reason),
            evidenceHash: hashSecret(evidence),
          })).digest('hex')}`;
        try {
          settlementTransactionHash = await arcSettlement!.settleDispute(task.chainTaskId!, slashPct, decisionHash);
          nextTaskStatus = decision.verdict === 'NO_FAULT' ? 'STREAMING' : 'SLASHED';
        } catch (error) {
          if (error instanceof ArcSettlementError) throw new ApiProblem(422, error.code, error.message);
          throw error;
        }
      }
      if (decision.verdict && decision.verdict !== 'NO_FAULT' && task.agentAddress) {
        await agentRepository.recordCommercialOutcome(task.agentAddress, false, task.accruedAmount);
      }
      await taskRepository.update(taskId, {
        status: nextTaskStatus,
        settlementTransactionHash: settlementTransactionHash ?? task.settlementTransactionHash,
      });

      response.status(201).json({
        ...dispute,
        pauseTransactionHash,
        settlementTransactionHash,
      });
    } catch(e) { next(e); }
  });

  app.post('/api/disputes/pg/:id/human-review', requireOperator, async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const verdict = text(request.body?.verdict);
      const reasoning = text(request.body?.reasoning);
      if (!['NO_FAULT', 'PARTIAL_FAULT', 'FULL_FAULT'].includes(verdict)) {
        throw new ApiProblem(400, 'INVALID_VERDICT', 'verdict must be NO_FAULT, PARTIAL_FAULT, or FULL_FAULT');
      }
      if (reasoning.trim().length < 12) {
        throw new ApiProblem(400, 'INVALID_REASONING', 'Human review reasoning must contain at least 12 characters');
      }
      const dispute = await disputeRepository.findById(text(request.params.id));
      if (!dispute) throw new ApiProblem(404, 'NOT_FOUND', 'Dispute not found');
      if (dispute.status !== 'NEEDS_HUMAN_REVIEW') {
        throw new ApiProblem(409, 'REVIEW_NOT_REQUIRED', 'This dispute does not require human review');
      }
      const task = await taskRepository.findById(dispute.taskId);
      if (!task) throw new ApiProblem(404, 'TASK_NOT_FOUND', 'The disputed work order no longer exists');
      const reviewedAt = Math.floor(Date.now() / 1000);
      const slashPct = verdict === 'FULL_FAULT' ? 100 : verdict === 'PARTIAL_FAULT' ? 50 : 0;
      const decisionHashHex = createHash('sha256').update(JSON.stringify({
        disputeId: dispute.id,
        taskId: task.id,
        verdict,
        slashPct,
        reviewerId: humanReviewerId,
        reasoning,
        reviewedAt,
      })).digest('hex');
      let settlementTransactionHash: string | null = null;
      let nextTaskStatus: 'STREAMING' | 'SLASHED' = 'STREAMING';
      if (process.env.PACT_MODE === 'arc') {
        if (!arcSettlement || !task.chainTaskId) {
          throw new ApiProblem(503, 'ARC_SETTLEMENT_UNAVAILABLE', 'Arc settlement is not ready for this work order');
        }
        try {
          settlementTransactionHash = await arcSettlement.settleDispute(task.chainTaskId, slashPct, `0x${decisionHashHex}`);
          if (verdict !== 'NO_FAULT') nextTaskStatus = 'SLASHED';
        } catch (error) {
          if (error instanceof ArcSettlementError) throw new ApiProblem(422, error.code, error.message);
          throw error;
        }
      }
      if (verdict !== 'NO_FAULT' && task.agentAddress) {
        await agentRepository.recordCommercialOutcome(task.agentAddress, false, task.accruedAmount);
      }

      const updated = await disputeRepository.update(text(request.params.id), {
        status: 'RESOLVED',
        verdict: verdict as 'NO_FAULT' | 'PARTIAL_FAULT' | 'FULL_FAULT',
        slashPct,
        reasoning,
        humanReview: {
          reviewerId: humanReviewerId,
          reviewedAt,
          verdict: verdict as 'NO_FAULT' | 'PARTIAL_FAULT' | 'FULL_FAULT',
          reasoningHash: `sha256:${hashSecret(reasoning)}`,
          councilDecisionHash: dispute.arbitrationReceipt?.decisionHash ?? `sha256:${'0'.repeat(64)}`,
          decisionHash: `sha256:${decisionHashHex}`,
        },
        resolvedAt: reviewedAt
      });
      await taskRepository.update(task.id, {
        status: nextTaskStatus,
        settlementTransactionHash: settlementTransactionHash ?? task.settlementTransactionHash,
      });

      response.json({ ...updated, settlementTransactionHash });
    } catch(e) { next(e); }
  });

  if (testMode) {
    const requireDemo = (_request: Request, _response: Response, next: NextFunction) => demoEndpointsEnabled
      ? next()
      : next(new ApiProblem(403, 'DEMO_ENDPOINTS_DISABLED', 'Demo mutation endpoints are disabled'));
    app.post('/api/demo/reset', requireOperator, requireDemo, (_request, response) => response.json(store.reset()));
    app.post('/api/demo/seed', requireOperator, requireDemo, (_request, response) => {
      const dashboard = store.seedMarketplace();
      for (const agent of dashboard.agents) arenaAutopilot.enroll(agent.agentAddress);
      response.json({
        ...dashboard,
        agentAutomation: arenaAutopilot.snapshots(dashboard.agents.map((agent) => agent.agentAddress)),
      });
    });
    app.post('/api/demo/scenario', requireOperator, requireDemo, (_request, response) => response.json(store.runScenario()));
    app.post('/api/demo/showcase', requireOperator, requireDemo, async (_request, response) => {
      store.reset();
      const seeded = store.seedMarketplace();
      for (const agent of seeded.agents) arenaAutopilot.enroll(agent.agentAddress);
      const task = store.listTasks('OPEN').find((candidate) => candidate.title === 'Verify the PACT evidence pack');
      if (!task) throw new ApiProblem(500, 'SHOWCASE_TASK_MISSING', 'The guided showcase task was not seeded');
      store.claimTask(task.id, DEMO_ADDRESSES.proofAgent);
      const run = await agentRuntime.run(task.id, DEMO_ADDRESSES.proofAgent);
      if (!run.deliverableId) throw new ApiProblem(500, 'SHOWCASE_DELIVERABLE_MISSING', 'The guided showcase did not produce a deliverable');
      response.status(201).json({
        message: 'Guided showcase is ready for creator review',
        agent: store.reputation(DEMO_ADDRESSES.proofAgent),
        task: store.getTask(task.id),
        run,
        deliverable: store.getDeliverable(run.deliverableId),
        dashboard: store.dashboard()
      });
    });
  }

  app.use((_request, response) => response.status(404).json({ error: 'Route not found', code: 'ROUTE_NOT_FOUND' } satisfies ApiError));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ApiProblem) {
      return response.status(error.status).json({ error: error.message, code: error.code, details: error.details } satisfies ApiError);
    }
    if (error instanceof SyntaxError && 'body' in error) {
      return response.status(400).json({ error: 'Request body is not valid JSON', code: 'INVALID_JSON' } satisfies ApiError);
    }
    console.error(error);
    return response.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' } satisfies ApiError);
  });

  return app;
}
