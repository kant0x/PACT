import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_DURATION_SECONDS, DEMO_ADDRESSES } from '@pact/shared';
import { createApp } from '../src/app.js';
import { DemoStore } from '../src/store.js';
import { buildSpendingPolicyArgs } from '../src/integrations/circle.js';
import type { ArcSettlementGateway } from '../src/arc-settlement.js';

const readyArcSettlement: ArcSettlementGateway = {
  verifyOpenTaskFunding: async () => ({
    chainTaskId: '1',
    transactionHash: `0x${'1'.repeat(64)}`,
    blockNumber: '1',
  }),
  verifyAgentClaimed: async () => `0x${'2'.repeat(64)}`,
  verifyCollateralPosted: async () => `0x${'3'.repeat(64)}`,
  verifyTaskCompleted: async () => `0x${'4'.repeat(64)}`,
  verifyTaskCancelled: async () => `0x${'8'.repeat(64)}`,
  verifyTaskPaused: async () => `0x${'5'.repeat(64)}`,
  settleDispute: async () => `0x${'7'.repeat(64)}`,
  readiness: async () => ({
    chainId: 5_042_002,
    vaultAddress: '0xE71D1BAE0732153b70b17144d1b858DB70856572',
    settlementSignerAddress: '0x36392ba753d76c285C32211Ed086eb1b54F83422',
    disputeModuleAddress: '0x1111111111111111111111111111111111111111',
    disputeModuleOwned: true,
    disputeModuleConfigured: true,
    disputeModulePaused: false,
  }),
};

describe('production hardening', () => {
  it('allows a work order without a creator-specified delivery window', () => {
    const task = new DemoStore().createTask({
      title: 'Open-ended research brief',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '10'
    });
    expect(task.estimatedDurationSeconds).toBe(DEFAULT_TASK_DURATION_SECONDS);
    expect(Number(task.streamRatePerSecond)).toBeGreaterThan(0);
  });

  it('does not let an unregistered wallet claim paid work', async () => {
    const store = new DemoStore();
    const task = store.createTask({
      title: 'Registry gate',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '10',
      estimatedDurationSeconds: 60
    });
    const app = createApp(store);
    await request(app).post(`/api/tasks/${task.id}/claim`)
      .send({ agentAddress: '0xB100000000000000000000000000000000000099' })
      .expect(403);
    await request(app).post(`/api/tasks/${task.id}/claim`)
      .send({ agentAddress: 'not-an-address' })
      .expect(400);
  });

  it('keeps public reputation reads read-only for unknown wallets', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const unknown = '0xB100000000000000000000000000000000000097';
    await request(app).get(`/api/reputation/${unknown}`).expect(404);
    await request(app).get(`/api/agents/${unknown}/capabilities`).expect(404);
    await request(app).put(`/api/agents/${unknown}/capabilities`).send({}).expect(400);
    expect((await request(app).get('/api/agents').expect(200)).body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agentAddress: unknown })
    ]));
  });

  it('rejects ambiguous capability manifests at the API boundary', async () => {
    const app = createApp(new DemoStore());
    const address = '0xB100000000000000000000000000000000000098';
    const duplicateCapabilities = {
      version: '1.0',
      executionMode: 'EXTERNAL_RUNTIME',
      capabilities: [
        { id: 'research.basic', label: 'Research', description: 'Produces a bounded report.', inputTypes: ['brief'], outputTypes: ['report'], verification: 'SELF_DECLARED' },
        { id: 'RESEARCH.BASIC', label: 'Research again', description: 'Creates a second declaration with the same identity.', inputTypes: ['brief'], outputTypes: ['report'], verification: 'SELF_DECLARED' }
      ],
      tools: [],
      evidenceMethods: ['creator review'],
      maxConcurrentTasks: 1,
      walletPolicy: { allowedChains: ['ARC-TESTNET'], allowedActions: ['CLAIM_TASK'], perTaskLimitUsdc: '10', requiresHumanApprovalAboveUsdc: null },
      updatedAt: 0
    };
    await request(app).post('/api/agents').send({
      agentAddress: address,
      displayName: 'Manifest Test Agent',
      capabilityManifest: duplicateCapabilities
    }).expect(400);
  });

  it('requires a production database configuration in Arc mode', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousMode = process.env.PACT_MODE;
    const previousDatabaseUrl = process.env.PACT_DATABASE_URL;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PACT_MODE = 'arc';
      delete process.env.PACT_DATABASE_URL;
      process.env.OPENAI_API_KEY = 'test-only-openai-key';
      expect(() => createApp(new DemoStore(), {
        authToken: 'correct-secret',
        sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
        authAudience: 'pact-protocol.pages.dev'
      })).toThrow(/DATABASE_URL/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousMode === undefined) delete process.env.PACT_MODE;
      else process.env.PACT_MODE = previousMode;
      if (previousDatabaseUrl === undefined) delete process.env.PACT_DATABASE_URL;
      else process.env.PACT_DATABASE_URL = previousDatabaseUrl;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
  });

  it('reports hardened readiness only when durable persistence is configured', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousMode = process.env.PACT_MODE;
    const previousDatabaseUrl = process.env.PACT_DATABASE_URL;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCorsOrigins = process.env.PACT_CORS_ORIGINS;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PACT_MODE = 'arc';
      process.env.PACT_DATABASE_URL = 'postgres://pact:pact@localhost:5432/pact_test';
      process.env.OPENAI_API_KEY = 'test-only-openai-key';
      process.env.PACT_CORS_ORIGINS = 'https://pact-protocol.pages.dev';
      const app = createApp(new DemoStore(), {
        authToken: 'correct-secret',
        sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
        authAudience: 'pact-protocol.pages.dev',
        arcSettlement: readyArcSettlement,
      });
      const response = await request(app).get('/api/health').expect(200);
      expect(response.body).toMatchObject({
        mode: 'arc',
        persistence: 'postgres',
        readiness: {
          productionReady: true,
          auth: 'required',
          cors: 'allowlist',
          data: 'durable'
        },
        boundaries: {
          judge: 'verdict-only',
          settlement: 'separate collateral policy',
          reputation: 'updates after accepted work or finalized dispute'
        }
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousMode === undefined) delete process.env.PACT_MODE;
      else process.env.PACT_MODE = previousMode;
      if (previousDatabaseUrl === undefined) delete process.env.PACT_DATABASE_URL;
      else process.env.PACT_DATABASE_URL = previousDatabaseUrl;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCorsOrigins === undefined) delete process.env.PACT_CORS_ORIGINS;
      else process.env.PACT_CORS_ORIGINS = previousCorsOrigins;
    }
  });

  it('blocks legacy in-memory and demo routes in Arc mode', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousMode = process.env.PACT_MODE;
    const previousDatabaseUrl = process.env.PACT_DATABASE_URL;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousCorsOrigins = process.env.PACT_CORS_ORIGINS;
    try {
      process.env.NODE_ENV = 'production';
      process.env.PACT_MODE = 'arc';
      process.env.PACT_DATABASE_URL = 'postgres://pact:pact@localhost:5432/pact_test';
      process.env.OPENAI_API_KEY = 'test-only-openai-key';
      process.env.PACT_CORS_ORIGINS = 'https://pact-protocol.pages.dev';
      const store = new DemoStore();
      store.registerAgent({ agentAddress: DEMO_ADDRESSES.newbie, displayName: 'Production Report Agent' });
      const app = createApp(store, {
        authToken: 'correct-secret',
        sessionSecret: 'test-session-secret-with-more-than-thirty-two-characters',
        authAudience: 'pact-protocol.pages.dev',
        arcSettlement: readyArcSettlement,
      });
      await request(app).get('/api/dashboard').expect(410).expect(({ body }) => {
        expect(body).toMatchObject({ code: 'DEMO_RUNTIME_REMOVED' });
      });
      await request(app).get('/api/arena/templates').expect(410);
      await request(app).get('/api/training/catalog').expect(200).expect(({ body }) => {
        expect(body).toHaveLength(11);
        expect(body[0]).toMatchObject({ ownerType: 'PLATFORM', ownerName: 'PACT Platform' });
      });
      await request(app).get(`/api/training/agents/${DEMO_ADDRESSES.newbie}/reports`).expect(200).expect(({ body }) => {
        expect(body).toEqual([]);
      });
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousMode === undefined) delete process.env.PACT_MODE;
      else process.env.PACT_MODE = previousMode;
      if (previousDatabaseUrl === undefined) delete process.env.PACT_DATABASE_URL;
      else process.env.PACT_DATABASE_URL = previousDatabaseUrl;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousCorsOrigins === undefined) delete process.env.PACT_CORS_ORIGINS;
      else process.env.PACT_CORS_ORIGINS = previousCorsOrigins;
    }
  });

  it('protects mutations with a bearer token while keeping reads available', async () => {
    const app = createApp(new DemoStore(), { authToken: 'correct-secret' });
    await request(app).get('/api/dashboard').expect(200);
    await request(app).post('/api/demo/reset').expect(401);
    await request(app).post('/api/demo/reset').set('Authorization', 'Bearer wrong').expect(401);
    await request(app).post('/api/demo/reset').set('Authorization', 'Bearer correct-secret').expect(200);
  });

  it('redacts raw dispute evidence from unauthenticated public reads', async () => {
    const store = new DemoStore();
    const task = store.createTask({
      title: 'Sensitive evidence task',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '25',
      estimatedDurationSeconds: 60
    });
    store.claimTask(task.id, DEMO_ADDRESSES.newbie);
    store.createDispute(task.id, 'Private customer context', 'secret-evidence-payload', {
      verdict: 'FULL_FAULT',
      reasoning: 'Missing proof',
      provider: 'deterministic',
      confidence: 0.65
    });
    const app = createApp(store, { authToken: 'read-secret' });

    const publicRead = await request(app).get('/api/disputes').expect(200);
    expect(publicRead.body[0].evidence).not.toContain('secret-evidence-payload');

    const privateRead = await request(app).get('/api/disputes')
      .set('Authorization', 'Bearer read-secret').expect(200);
    expect(privateRead.body[0].evidence).toBe('secret-evidence-payload');
  });

  it('keeps demo reputation seeding idempotent', () => {
    const store = new DemoStore();
    const first = store.seedVeteran(8);
    const second = store.seedVeteran(8);
    expect(second.score).toBe(first.score);
    expect(second.completedTasks).toBe(8);
    expect(second.history.events).toHaveLength(8);
  });

  it('uses a supplied real-arbitrator adapter decision', async () => {
    const store = new DemoStore();
    const task = store.createTask({
      title: 'Arbitrated task',
      successCriteria: 'Return signed proof',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '100',
      estimatedDurationSeconds: 60
    });
    store.claimTask(task.id, DEMO_ADDRESSES.newbie);
    const app = createApp(store, {
      arbitrator: {
        provider: 'openai',
        decide: async () => ({ verdict: 'PARTIAL_FAULT', reasoning: 'Only one of two proofs was supplied.' })
      }
    });
    const response = await request(app).post('/api/disputes').send({
      taskId: task.id,
      reason: 'Incomplete proof',
      evidence: 'One signed proof is present'
    }).expect(201);
    expect(response.body).toMatchObject({ verdict: 'PARTIAL_FAULT', slashPct: 50, reasoning: 'Only one of two proofs was supplied.' });
  });

  it('builds a mainnet policy and rejects testnet policies', () => {
    const policy = {
      address: '0x1111111111111111111111111111111111111111',
      chain: 'BASE',
      perTransaction: 25,
      daily: 100,
      weekly: 500,
      monthly: 1500
    };
    expect(buildSpendingPolicyArgs(policy)).toContain('--per-tx');
    expect(() => buildSpendingPolicyArgs({ ...policy, chain: 'ARC-TESTNET' })).toThrow('mainnet-only');
  });
});
