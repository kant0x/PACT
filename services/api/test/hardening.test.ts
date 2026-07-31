import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_DURATION_SECONDS, DEMO_ADDRESSES } from '@pact/shared';
import { createApp } from '../src/app.js';
import { DemoStore, type PersistedDemoState } from '../src/store.js';
import { PostgresStatePersistence } from '../src/postgres-persistence.js';

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
      walletPolicy: { allowedChains: ['GIWA-SEPOLIA'], allowedActions: ['CLAIM_TASK'], perTaskLimitUsdc: '10', requiresHumanApprovalAboveUsdc: null },
      updatedAt: 0
    };
    await request(app).post('/api/agents').send({
      agentAddress: address,
      displayName: 'Manifest Test Agent',
      capabilityManifest: duplicateCapabilities
    }).expect(400);
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)('persists state in PostgreSQL', async () => {
    const persistence = new PostgresStatePersistence<PersistedDemoState>(process.env.TEST_DATABASE_URL!);
    const store = new DemoStore();
    const task = store.createTask({
      title: 'Persistent task',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '25',
      estimatedDurationSeconds: 60
    });
    const snapshot = (store as unknown as { serialize(): PersistedDemoState }).serialize();
    await persistence.save(snapshot);
    const saved = await persistence.load();
    expect(saved?.tasks.some((candidate) => candidate.id === task.id && candidate.title === 'Persistent task')).toBe(true);
    await persistence.close();
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

});
