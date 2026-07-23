import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { DEFAULT_TASK_DURATION_SECONDS, DEMO_ADDRESSES, inferTaskCategory, manifestSupportsTaskCategory, manifestSupportsWorkOrder, normalizeWorkOrderSpec, type ApiError, type WorkOrderSpec } from '@pact/shared';
import { ApiProblem } from './errors.js';
import { DemoStore, demoStore } from './store.js';
import { SCORE } from './config.js';
import { createArbitratorFromEnv, DeterministicArbitrator, type Arbitrator } from './arbitration.js';
import { authGuard, hasValidBearerToken, parseCorsOrigins } from './security.js';
import { AgentRuntime, DeterministicAgentProvider, OpenAIAgentProvider, type AgentModelProvider } from './agent-runtime.js';
import { createArcDeveloperWallet } from './integrations/circle.js';
import { verifyMessage } from 'viem';
import { defaultExternalManifest, validateCapabilityManifest } from './capability-validation.js';
import { defaultWorkOrderForTask, validateWorkOrderSpec } from './work-order-validation.js';
import { createX402RuntimeIntegration } from './integrations/x402.js';
import { DockerArenaCodeRunner, type ArenaCodeRunner } from './arena-code-runner.js';
import { createArenaQualityJudgeFromEnv, type ArenaQualityJudge } from './arena-quality-judge.js';
import { createPlatformPointsFromEnv, type PlatformPointsService } from './platform-points.js';

const text = (value: unknown) => typeof value === 'string' ? value : '';
const ETHEREUM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

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
  corsOrigins?: string[];
  enableDemoEndpoints?: boolean;
  humanReviewerId?: string;
  agentProvider?: AgentModelProvider;
  arenaCodeRunner?: ArenaCodeRunner;
  arenaQualityJudge?: ArenaQualityJudge;
  platformPoints?: PlatformPointsService;
}

export function createApp(store: DemoStore = demoStore, options: AppOptions = {}) {
  const app = express();
  const openaiKey = process.env.OPENAI_API_KEY;
  const deterministicProvidersAllowed = process.env.NODE_ENV !== 'production'
    || process.env.PACT_ALLOW_DETERMINISTIC_PROVIDERS === 'true';
  if (process.env.NODE_ENV === 'production' && !openaiKey && !deterministicProvidersAllowed) {
    throw new Error('OPENAI_API_KEY is required in production; set PACT_ALLOW_DETERMINISTIC_PROVIDERS=true only for an explicitly labelled controlled demo');
  }
  if (process.env.NODE_ENV === 'production' && !deterministicProvidersAllowed
    && (process.env.ARENA_JUDGE_PROVIDER === 'deterministic' || process.env.ARBITRATOR_PROVIDER === 'deterministic')) {
    throw new Error('Deterministic judges are disabled in production');
  }
  const defaultAgentProvider = openaiKey ? new OpenAIAgentProvider(openaiKey) : new DeterministicAgentProvider();
  const agentRuntime = new AgentRuntime(options.agentProvider ?? defaultAgentProvider, store);
  const arenaCodeRunner = options.arenaCodeRunner ?? new DockerArenaCodeRunner();
  const arenaQualityJudge = options.arenaQualityJudge ?? createArenaQualityJudgeFromEnv();
  const platformPoints = options.platformPoints ?? createPlatformPointsFromEnv();
  if (process.env.PACT_MODE === 'arc' && process.env.PLATFORM_POINTS_REQUIRED === 'true' && !platformPoints) {
    throw new Error('PLATFORM_POINTS_REQUIRED=true but no Arc PlatformPoints adapter is configured');
  }
  const x402Integration = createX402RuntimeIntegration();
  const arbitrator = options.arbitrator ?? (process.env.NODE_ENV === 'test' ? new DeterministicArbitrator() : createArbitratorFromEnv());
  const authToken = options.authToken ?? process.env.PACT_AUTH_TOKEN;
  if (process.env.NODE_ENV === 'production' && !authToken) throw new Error('PACT_AUTH_TOKEN is required in production');
  const demoEndpointsEnabled = options.enableDemoEndpoints
    ?? (process.env.PACT_ENABLE_DEMO_ENDPOINTS === undefined
      ? process.env.NODE_ENV !== 'production'
      : process.env.PACT_ENABLE_DEMO_ENDPOINTS === 'true');
  // A funded work order must be explicitly approved by the creator wallet. Tests can
  // use the in-memory store without a Web3 signature; every real/dev HTTP request is
  // protected unless an operator deliberately opts into the legacy bypass.
  const creatorSignatureRequired = process.env.NODE_ENV === 'production'
    || (process.env.NODE_ENV !== 'test' && process.env.PACT_ALLOW_UNSIGNED_TASKS !== 'true');
  // Demo mode keeps the local showcase frictionless. Arc/production registration
  // must still prove wallet ownership over the exact capability JSON that is
  // persisted; a bearer token alone is not an agent identity proof.
  const agentSignatureRequired = process.env.NODE_ENV === 'production'
    || process.env.PACT_MODE === 'arc'
    || (process.env.NODE_ENV !== 'test' && process.env.PACT_REQUIRE_AGENT_SIGNATURES === 'true');
  const arenaSignatureRequired = process.env.NODE_ENV === 'production'
    || process.env.PACT_MODE === 'arc'
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
  const requireAuth = authGuard(authToken);
  const humanReviewerId = (options.humanReviewerId ?? process.env.PACT_HUMAN_REVIEWER_ID ?? 'authorized-human-reviewer').trim()
    || 'authorized-human-reviewer';
  const redactDispute = (dispute: ReturnType<DemoStore['getDispute']>) => ({
    ...dispute,
    reason: '[restricted: authenticate to view dispute details]',
    evidence: '[restricted: evidence hash remains available in the decision receipt]'
  });
  const canReadSensitive = (request: Request) => hasValidBearerToken(request, authToken);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: options.corsOrigins ?? parseCorsOrigins() }));
  app.use('/api', rateLimit({
    windowMs: Number(process.env.PACT_RATE_LIMIT_WINDOW_MS ?? 60_000),
    limit: Number(process.env.PACT_RATE_LIMIT_MAX ?? 300),
    standardHeaders: 'draft-8',
    legacyHeaders: false
  }));
  app.use(express.json({ limit: process.env.PACT_JSON_LIMIT ?? '64kb' }));
  app.use('/api', (request, response, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
    // Attempt-scoped arena mutations authenticate with the private attempt
    // token, so an MCP client never needs the platform-wide operator token.
    if (request.path.startsWith('/arena/attempts/')) return next();
    if (/^\/arena\/templates\/[^/]+\/start$/.test(request.path)) return next();
    if (request.method === 'POST' && request.path === '/agents') return next();
    return requireAuth(request, response, next);
  });

  const health = (_request: Request, response: Response) => response.json({
    status: 'ok',
    service: 'pact-api',
    mode: process.env.PACT_MODE === 'arc' ? 'arc' : 'demo',
    persistence: process.env.PACT_MODE === 'arc' ? 'postgres-adapter' : 'sqlite',
    timestamp: new Date().toISOString()
  });
  app.get('/health', health);
  app.get('/api/health', health);

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
    response.json(canReadSensitive(request)
      ? dashboard
      : { ...dashboard, disputes: dashboard.disputes.map(redactDispute) });
  });
  app.get('/api/leaderboard', (_request, response) => response.json(store.leaderboard()));
  app.get('/api/agents', (_request, response) => response.json(store.leaderboard()));
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
    if (arenaSignatureRequired) {
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
        disputes,
        agentRuns,
        deliverables,
        metrics: {
          totalVolume: money(totalVolume),
          activeStreams,
          completedTasks: completedTasksCount,
          protectedValue: money(protectedValue)
        },
        mode: 'arc'
      };

      response.json(canReadSensitive(request) ? dashboard : { ...dashboard, disputes: disputes.map(redactDispute) });
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
    const manifest = body.capabilityManifest === undefined ? undefined : validateCapabilityManifest(body.capabilityManifest);
    await assertAgentSignature(body, address, manifest);
    response.status(201).json(store.registerAgent({
      agentAddress: address,
      displayName,
      capabilityManifest: manifest
    }));
  });

  // Production PostgreSQL registration for Agents (Third-Party Registration)
  app.post('/api/agents/pg', async (request, response, next) => {
    try {
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const { verifyMessage } = await import('viem');

      const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {};
      const { address, displayName, capabilityManifest, provisionWallet } = body;
      const requestedName = text(displayName).trim() || 'New AI Agent';
      if (requestedName.length < 2 || requestedName.length > 80) throw new ApiProblem(400, 'INVALID_AGENT_NAME', 'displayName must contain 2..80 characters');
      const submittedManifest = capabilityManifest === undefined ? undefined : validateCapabilityManifest(capabilityManifest);
      const manifest = submittedManifest ?? defaultExternalManifest();

      let finalAddress = text(address).trim();

      if (provisionWallet === true) {
        const provisioned = await createArcDeveloperWallet();
        finalAddress = provisioned.wallet.address;
        if (!finalAddress) throw new ApiProblem(502, 'CIRCLE_WALLET_ADDRESS_MISSING', 'Circle did not return an Arc wallet address');
      } else {
        if (!ETHEREUM_ADDRESS.test(finalAddress)) throw new ApiProblem(400, 'INVALID_AGENT_ADDRESS', 'address must be a 20-byte hex address');

        // Verify that the third-party agent actually owns this Ethereum address
        const signature = text(body.signature).trim();
        if (!signature) throw new ApiProblem(401, 'AGENT_SIGNATURE_REQUIRED', 'Web3 signature is required to prove ownership of the agent address');
        try {
          const isValid = await verifyMessage({
            address: finalAddress as `0x${string}`,
            message: agentRegistrationMessage({ displayName: requestedName, capabilityManifest: submittedManifest }),
            signature: signature as `0x${string}`
          });
          if (!isValid) throw new ApiProblem(403, 'INVALID_AGENT_SIGNATURE', 'The connected wallet did not approve this agent profile');
        } catch (error) {
          if (error instanceof ApiProblem) throw error;
          throw new ApiProblem(403, 'INVALID_AGENT_SIGNATURE', 'The connected wallet did not approve this agent profile');
        }
      }

      if (!ETHEREUM_ADDRESS.test(finalAddress)) throw new ApiProblem(502, 'INVALID_PROVISIONED_ADDRESS', 'Circle did not return a valid agent wallet address');

      const agent = {
        agentAddress: finalAddress.toLowerCase(),
        displayName: requestedName,
        score: SCORE.base,
        completedTasks: 0,
        failedTasks: 0,
        totalVolumeStreamed: '0',
        platformPoints: 0,
        lastUpdated: Math.floor(Date.now() / 1000),
        capabilityManifest: manifest
      };
      await agentRepository.create(agent);
      response.status(201).json({ message: 'Agent registered in PostgreSQL', agent });
    } catch (e) { next(e); }
  });

  // Production PostgreSQL registration for Clients (Заказчики)
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

      const taskData = {
        title: input.title.trim(),
        description: input.description?.trim() ?? '',
        successCriteria: input.successCriteria?.trim() ?? '',
        creatorAddress: input.creatorAddress.trim().toLowerCase(),
        preferredAgentAddress,
        agentAddress: null,
        totalAmount: money(total),
        estimatedDurationSeconds,
        streamRatePerSecond: money(total / estimatedDurationSeconds),
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

      const task = await taskRepository.create(taskData);
      response.status(201).json(task);
    } catch(e) { next(e); }
  });
  app.get('/api/tasks/:id', (request, response) => response.json(store.getTask(request.params.id)));
  app.patch('/api/tasks/:id', (request, response) => response.json(store.updateTask(request.params.id, request.body)));
  app.put('/api/tasks/:id', (request, response) => response.json(store.updateTask(request.params.id, request.body)));
  app.delete('/api/tasks/:id', (request, response) => {
    store.deleteTask(request.params.id);
    response.status(204).end();
  });
  app.post('/api/tasks/:id/claim', (request, response) => response.json(store.claimTask(request.params.id, text(request.body?.agentAddress))));

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
      const task = await taskRepository.update(request.params.id, request.body);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');
      response.json(task);
    } catch(e) { next(e); }
  });

  app.delete('/api/tasks/pg/:id', async (request, response, next) => {
    try {
      const { taskRepository } = await import('./repositories/task.repository.js');
      await taskRepository.delete(request.params.id);
      response.status(204).end();
    } catch(e) { next(e); }
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

      const updated = await taskRepository.update(request.params.id, {
        status: 'ASSIGNED',
        agentAddress: agentAddress.toLowerCase(),
        collateralLocked: (Number(task.totalAmount) * reputation.terms.collateralPct / 100).toFixed(6).replace(/\.?0+$/, '') || '0',
        terms: reputation.terms
      });
      response.json(updated);
    } catch(e) { next(e); }
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

  // PostgreSQL streaming lifecycle. The contract-backed vault remains the
  // source of truth in production; these routes persist the same state while
  // the Arc adapter is being used in local/dev deployments.
  app.post('/api/streams/pg/:id/withdraw', async (request, response, next) => {
    try {
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
      const { agentRepository } = await import('./repositories/agent.repository.js');
      const manifest = validateCapabilityManifest(request.body);
      const agent = await agentRepository.updateCapabilities(request.params.agentAddress, manifest);
      if (!agent) throw new ApiProblem(404, 'AGENT_NOT_FOUND', 'Agent not found');
      response.json(agent.capabilityManifest);
    } catch (e) { next(e); }
  });

  app.get('/api/reputation/:agentAddress', (request, response) => response.json(store.reputation(request.params.agentAddress)));
  app.post('/api/reputation/recalculate/:agentAddress', (request, response) => response.json(store.recalculate(request.params.agentAddress)));
  app.get('/api/agents/:agentAddress/capabilities', (request, response) => response.json(store.capabilities(request.params.agentAddress)));
  app.put('/api/agents/:agentAddress/capabilities', (request, response) => response.json(store.updateCapabilities(request.params.agentAddress, request.body)));
  app.post('/api/agents/:agentAddress/traces', (request, response) => response.status(201).json(store.addExecutionTrace(request.params.agentAddress, request.body)));
  app.get('/api/training/status', (_request, response) => response.json(store.trainingStatus()));
  app.get('/api/training/traces', requireAuth, (_request, response) => response.json(store.trainingTraces()));
  app.get('/api/training/review-queue', requireAuth, (_request, response) => response.json(store.trainingReviewQueue()));
  app.post('/api/training/traces/:id/review', requireAuth, (request, response) => {
    const status = text(request.body?.status);
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      throw new ApiProblem(400, 'INVALID_TRACE_REVIEW', 'status must be APPROVED or REJECTED');
    }
    response.json(store.reviewTrainingTrace(text(request.params.id), status as 'APPROVED' | 'REJECTED', humanReviewerId));
  });

  app.get('/api/agent-runtime', (_request, response) => response.json(agentRuntime.describe()));
  app.get('/api/agent-runs', (_request, response) => response.json(store.listAgentRuns()));
  app.get('/api/agent-runs/:id', (request, response) => response.json(store.getAgentRun(request.params.id)));
  app.post('/api/agent-runs', async (request, response) => {
    const taskId = text(request.body?.taskId);
    const agentAddress = text(request.body?.agentAddress);
    if (!taskId || !agentAddress) throw new ApiProblem(400, 'INVALID_AGENT_RUN', 'taskId and agentAddress are required');
    response.status(201).json(await agentRuntime.run(taskId, agentAddress));
  });

  // Production PostgreSQL routes for Agent Runs
  app.get('/api/agent-runs/pg', async (request, response, next) => {
    try {
      const { agentRunRepository } = await import('./repositories/agent-run.repository.js');
      response.json(await agentRunRepository.findAll());
    } catch(e) { next(e); }
  });

  app.get('/api/agent-runs/pg/:id', async (request, response, next) => {
    try {
      const { agentRunRepository } = await import('./repositories/agent-run.repository.js');
      const run = await agentRunRepository.findById(request.params.id);
      if (!run) throw new ApiProblem(404, 'NOT_FOUND', 'Agent run not found');
      response.json(run);
    } catch(e) { next(e); }
  });

  app.post('/api/agent-runs/pg', async (request, response, next) => {
    try {
      // Logic for triggering OpenAIAgentProvider but saving to postgres instead of store
      // Since OpenAIAgentProvider heavily depends on store right now, we will create the DB record
      // and queue the run. Full rewrite of AgentRuntime to PG is part of Epic 5.
      const taskId = text(request.body?.taskId);
      const agentAddress = text(request.body?.agentAddress);
      if (!taskId || !agentAddress) throw new ApiProblem(400, 'INVALID_AGENT_RUN', 'taskId and agentAddress are required');

      const { agentRunRepository } = await import('./repositories/agent-run.repository.js');
      const run = await agentRunRepository.create({
        taskId,
        agentAddress: agentAddress.toLowerCase(),
        provider: 'OpenAI',
        status: 'QUEUED',
        plan: null,
        steps: [],
        deliverableId: null,
        error: null
      });

      // We trigger the legacy runtime asynchronously for now
      agentRuntime.run(taskId, agentAddress, true).catch(async (error) => {
        console.error(error);
        const current = await agentRunRepository.findById(run.id);
        if (current) await agentRunRepository.update(run.id, {
          status: 'FAILED',
          error: error instanceof Error ? error.message.slice(0, 2000) : 'Agent runtime failed',
          completedAt: Math.floor(Date.now() / 1000)
        });
      });

      response.status(201).json(run);
    } catch(e) { next(e); }
  });

  app.get('/api/deliverables', (_request, response) => response.json(store.listDeliverables()));
  app.get('/api/deliverables/:id', (request, response) => response.json(store.getDeliverable(request.params.id)));
  app.post('/api/tasks/:id/deliverables', (request, response) => {
    const agentAddress = text(request.body?.agentAddress);
    response.status(201).json(store.submitDeliverable(request.params.id, agentAddress, request.body));
  });
  app.post('/api/deliverables/:id/accept', (request, response) => response.json(store.acceptDeliverable(request.params.id)));

  // Production PostgreSQL routes for Deliverables
  app.get('/api/deliverables/pg', async (request, response, next) => {
    try {
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      response.json(await deliverableRepository.findAll());
    } catch(e) { next(e); }
  });

  app.get('/api/deliverables/pg/:id', async (request, response, next) => {
    try {
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const deliverable = await deliverableRepository.findById(request.params.id);
      if (!deliverable) throw new ApiProblem(404, 'NOT_FOUND', 'Deliverable not found');
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

      const deliverable = await deliverableRepository.findById(request.params.id);
      if (!deliverable) throw new ApiProblem(404, 'NOT_FOUND', 'Deliverable not found');
      if (deliverable.status !== 'SUBMITTED') throw new ApiProblem(409, 'INVALID_STATUS', 'Deliverable is not submitted');

      const updatedDeliverable = await deliverableRepository.update(deliverable.id, {
        status: 'ACCEPTED',
        reviewedAt: Math.floor(Date.now() / 1000)
      });

      const task = await taskRepository.findById(deliverable.taskId);
      if (task) {
        // Mark task as completed
        await taskRepository.update(deliverable.taskId, {
          status: 'COMPLETED',
          completedAt: Math.floor(Date.now() / 1000)
        });

        // Award platform points if it was a training task template
        if (task.templateId) {
          const template = await taskRepository.findTemplateById(task.templateId);
          if (template && task.agentAddress) {
            const { agentRepository } = await import('./repositories/agent.repository.js');
            await agentRepository.awardPlatformPoints(task.agentAddress, template.rewardPoints);
          }
        }
      }

      response.json({ deliverable: updatedDeliverable });
    } catch(e) { next(e); }
  });

  app.post('/api/streams/initiate', (request, response) => response.status(201).json(store.initiateStream(request.body)));
  app.get('/api/streams/:id/status', (request, response) => response.json(store.streamStatus(request.params.id)));
  app.post('/api/streams/:id/start', (request, response) => response.json(store.startStream(request.params.id)));
  app.post('/api/streams/:id/withdraw', (request, response) => response.json(store.withdraw(request.params.id)));
  app.post('/api/streams/:id/complete', (request, response) => response.json(store.completeTask(request.params.id)));

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
    const deliverable = store.listDeliverables().find((candidate) => candidate.taskId === taskId && ['SUBMITTED', 'DISPUTED', 'ACCEPTED'].includes(candidate.status)) ?? null;
    const decision = await arbitrator.decide({ task, reason, evidence, deliverable });
    response.status(201).json(store.createDispute(taskId, reason, evidence, decision));
  });
  app.get('/api/disputes/:id', (request, response) => {
    const dispute = store.getDispute(request.params.id);
    response.json(canReadSensitive(request) ? dispute : redactDispute(dispute));
  });
  app.post('/api/disputes/:id/human-review', (request, response) => {
    const verdict = text(request.body?.verdict);
    const reasoning = text(request.body?.reasoning);
    if (!['NO_FAULT', 'PARTIAL_FAULT', 'FULL_FAULT'].includes(verdict)) {
      throw new ApiProblem(400, 'INVALID_VERDICT', 'verdict must be NO_FAULT, PARTIAL_FAULT, or FULL_FAULT');
    }
    response.json(store.finalizeHumanReview(
      request.params.id,
      verdict as 'NO_FAULT' | 'PARTIAL_FAULT' | 'FULL_FAULT',
      reasoning,
      humanReviewerId
    ));
  });

  // Production PostgreSQL routes for Disputes
  app.get('/api/disputes/pg', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      let disputes = await disputeRepository.findAll();
      if (!canReadSensitive(request)) disputes = disputes.map(redactDispute);
      response.json(disputes);
    } catch(e) { next(e); }
  });

  app.get('/api/disputes/pg/:id', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const dispute = await disputeRepository.findById(request.params.id);
      if (!dispute) throw new ApiProblem(404, 'NOT_FOUND', 'Dispute not found');
      response.json(canReadSensitive(request) ? dispute : redactDispute(dispute));
    } catch(e) { next(e); }
  });

  app.post('/api/tasks/pg/:id/dispute', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const { deliverableRepository } = await import('./repositories/deliverable.repository.js');
      const { taskRepository } = await import('./repositories/task.repository.js');
      const taskId = request.params.id;
      const task = await taskRepository.findById(taskId);
      if (!task) throw new ApiProblem(404, 'NOT_FOUND', 'Task not found');

      const reason = text(request.body?.reason);
      const evidence = text(request.body?.evidence);
      if (!reason?.trim()) throw new ApiProblem(400, 'INVALID_REASON', 'reason is required');
      if (!evidence?.trim()) throw new ApiProblem(400, 'INVALID_EVIDENCE', 'evidence is required');

      // Call AI Arbitrator
      const deliverables = await deliverableRepository.findByTaskId(taskId);
      const deliverable = deliverables.find((candidate) => ['SUBMITTED', 'DISPUTED', 'ACCEPTED'].includes(candidate.status)) ?? null;
      const decision = await arbitrator.decide({ task, reason, evidence, deliverable });

      const dispute = await disputeRepository.create({
        taskId,
        reason,
        evidence,
        status: decision.verdict ? 'RESOLVED' : 'NEEDS_HUMAN_REVIEW',
        verdict: decision.verdict ?? null,
        slashPct: decision.verdict === 'FULL_FAULT' ? 100 : decision.verdict === 'PARTIAL_FAULT' ? 50 : decision.verdict === 'NO_FAULT' ? 0 : null,
        reasoning: decision.reasoning ?? null,
        arbitratorProvider: decision.provider ?? null,
        decisionConfidence: decision.confidence ?? null,
        arbitrationReceipt: null,
        humanReview: null
      });

      // Pause the stream in DB
      await taskRepository.update(taskId, { status: 'DISPUTED' });

      response.status(201).json(dispute);
    } catch(e) { next(e); }
  });

  app.post('/api/disputes/pg/:id/human-review', async (request, response, next) => {
    try {
      const { disputeRepository } = await import('./repositories/dispute.repository.js');
      const verdict = text(request.body?.verdict);
      const reasoning = text(request.body?.reasoning);
      if (!['NO_FAULT', 'PARTIAL_FAULT', 'FULL_FAULT'].includes(verdict)) {
        throw new ApiProblem(400, 'INVALID_VERDICT', 'verdict must be NO_FAULT, PARTIAL_FAULT, or FULL_FAULT');
      }

      const updated = await disputeRepository.update(request.params.id, {
        status: 'RESOLVED',
        verdict: verdict as any,
        reasoning,
        resolvedAt: Math.floor(Date.now() / 1000)
      });

      response.json(updated);
    } catch(e) { next(e); }
  });

  const requireDemo = (_request: Request, _response: Response, next: NextFunction) => demoEndpointsEnabled
    ? next()
    : next(new ApiProblem(403, 'DEMO_ENDPOINTS_DISABLED', 'Demo mutation endpoints are disabled'));
  app.post('/api/demo/reset', requireDemo, (_request, response) => response.json(store.reset()));
  app.post('/api/demo/seed', requireDemo, (_request, response) => response.json(store.seedMarketplace()));
  app.post('/api/demo/scenario', requireDemo, (_request, response) => response.json(store.runScenario()));
  app.post('/api/demo/showcase', requireDemo, async (_request, response) => {
    store.reset();
    store.seedMarketplace();
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
