import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEMO_ADDRESSES } from '@pact/shared';
import { createApp } from '../src/app.js';
import { createPactServer, type PactServer } from '../src/server.js';
import { DemoStore } from '../src/store.js';

const runtimes: PactServer[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

describe('PACT demo API', () => {
  it('reports health and an empty demo dashboard', async () => {
    const response = await request(createApp(new DemoStore())).get('/api/health').expect(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'pact-api', mode: 'demo' });

    const dashboard = await request(createApp(new DemoStore())).get('/api/dashboard').expect(200);
    expect(dashboard.body.mode).toBe('demo');
    expect(dashboard.body.metrics.activeStreams).toBe(0);
  });

  it('publishes and validates an agent capability manifest', async () => {
    const app = createApp(new DemoStore());
    const current = await request(app)
      .get(`/api/agents/${DEMO_ADDRESSES.newbie}/capabilities`)
      .expect(200);
    expect(current.body).toMatchObject({ executionMode: 'EXTERNAL_RUNTIME', maxConcurrentTasks: 1 });
    expect(current.body.capabilities).toHaveLength(2);

    const updated = await request(app)
      .put(`/api/agents/${DEMO_ADDRESSES.newbie}/capabilities`)
      .send({
        ...current.body,
        version: '1.1',
        maxConcurrentTasks: 2,
        capabilities: [...current.body.capabilities, {
          id: 'api.read',
          label: 'Read-only API access',
          description: 'Reads allowlisted endpoints and returns a traceable JSON result.',
          inputTypes: ['OpenAPI schema'],
          outputTypes: ['JSON'],
          verification: 'SELF_DECLARED'
        }]
      })
      .expect(200);
    expect(updated.body).toMatchObject({ version: '1.1', maxConcurrentTasks: 2 });
    expect(updated.body.capabilities).toHaveLength(3);

    await request(app)
      .put(`/api/agents/${DEMO_ADDRESSES.newbie}/capabilities`)
      .send({ ...current.body, capabilities: [] })
      .expect(400);
  });

  it('registers a new agent identity with a default bounded manifest', async () => {
    const app = createApp(new DemoStore());
    const agentAddress = '0xB100000000000000000000000000000000000004';
    const created = await request(app).post('/api/agents').send({
      agentAddress,
      displayName: 'Customer Research Agent'
    }).expect(201);
    expect(created.body).toMatchObject({ agentAddress, displayName: 'Customer Research Agent', score: 80 });
    expect(created.body.capabilityManifest).toMatchObject({ executionMode: 'EXTERNAL_RUNTIME', maxConcurrentTasks: 1 });
    const agents = await request(app).get('/api/agents').expect(200);
    expect(agents.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentAddress, displayName: 'Customer Research Agent' })
    ]));
    await request(app).post('/api/agents').send({ agentAddress, displayName: 'Duplicate Agent' }).expect(409);
  });

  it('requires agent registry membership before claiming paid work', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const agentAddress = '0xB100000000000000000000000000000000000005';
    const task = store.createTask({
      title: 'Registered-only work order',
      description: 'Return a bounded result.',
      successCriteria: 'Return a signed receipt.',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '25',
      estimatedDurationSeconds: 60
    });

    const rejected = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({ agentAddress })
      .expect(403);
    expect(rejected.body).toMatchObject({
      code: 'AGENT_NOT_REGISTERED'
    });
    expect((await request(app).get('/api/agents')).body).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ agentAddress })
    ]));

    await request(app).post('/api/agents').send({
      agentAddress,
      displayName: 'Registered Research Agent'
    }).expect(201);
    const claimed = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({ agentAddress })
      .expect(200);
    expect(claimed.body).toMatchObject({ status: 'STREAMING' });
    expect(store.getTask(task.id)).toMatchObject({ status: 'STREAMING', agentAddress });
  });

  it('keeps a direct hire reserved for the invited registered agent', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const invited = DEMO_ADDRESSES.veteran;
    const task = store.createTask({
      title: 'Directly invited research brief',
      description: 'Review the supplied source packet and return a reproducible memo.',
      successCriteria: 'Return a cited memo with a verifiable source manifest.',
      creatorAddress: DEMO_ADDRESSES.creator,
      preferredAgentAddress: invited,
      totalAmount: '100',
      estimatedDurationSeconds: 60
    });
    expect(task.preferredAgentAddress).toBe(invited.toLowerCase());

    await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({ agentAddress: DEMO_ADDRESSES.newbie })
      .expect(403)
      .expect(({ body }) => expect(body).toMatchObject({ code: 'AGENT_INVITE_ONLY' }));

    const accepted = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({ agentAddress: invited })
      .expect(200);
    expect(accepted.body).toMatchObject({ status: 'STREAMING' });
    expect(store.getTask(task.id).agentAddress?.toLowerCase()).toBe(invited.toLowerCase());
  });

  it('collects consented visible execution traces only after a successful outcome', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const task = store.createTask({
      title: 'Produce a verified market report',
      successCriteria: 'Return JSON and a source manifest',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '50',
      estimatedDurationSeconds: 60
    });
    store.claimTask(task.id, DEMO_ADDRESSES.newbie);
    const hash = `sha256:${'a'.repeat(64)}`;
    const submitted = await request(app)
      .post(`/api/agents/${DEMO_ADDRESSES.newbie}/traces`)
      .send({
        taskId: task.id,
        messages: [
          { role: 'user', content: 'Produce the report using the published criteria.' },
          { role: 'assistant', content: 'I verified the sources and produced the requested JSON artifact.' }
        ],
        toolCalls: [{ name: 'source.fetch', inputHash: hash, outputHash: hash, status: 'SUCCESS', durationMs: 120 }],
        deliverableSummary: 'A normalized JSON report with a source manifest and content hashes.',
        evidence: [hash],
        consentToTraining: true
      })
      .expect(201);
    expect(submitted.body.outcome).toBe('PENDING');
    expect((await request(app).get('/api/training/traces').expect(200)).body).toHaveLength(0);

    store.submitDeliverable(task.id, DEMO_ADDRESSES.newbie, {
      summary: 'A verified report ready for creator acceptance.',
      artifacts: [{ name: 'report.json', mediaType: 'application/json', contentHash: hash, sizeBytes: 2, uri: null, preview: '{}' }],
      evidence: [hash]
    });
    store.completeTask(task.id);
    expect((await request(app).get('/api/training/traces').expect(200)).body).toHaveLength(0);
    const queue = await request(app).get('/api/training/review-queue').expect(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0]).toMatchObject({ reviewStatus: 'PENDING', outcome: 'SUCCESS' });
    await request(app).post(`/api/training/traces/${submitted.body.id}/review`).send({ status: 'APPROVED' }).expect(200);
    const exported = await request(app).get('/api/training/traces').expect(200);
    expect(exported.body).toHaveLength(1);
    expect(exported.body[0]).toMatchObject({ taskId: task.id, outcome: 'SUCCESS', consentToTraining: true });
  });

  it('supports task CRUD and rejects a low-reputation task above the demo limit', async () => {
    const app = createApp(new DemoStore());
    const created = await request(app).post('/api/tasks').send({
      title: 'Expensive task',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '1500',
      estimatedDurationSeconds: 60
    }).expect(201);

    await request(app).patch(`/api/tasks/${created.body.id}`).send({ title: 'Updated task' }).expect(200);
    const rejected = await request(app).post(`/api/tasks/${created.body.id}/claim`)
      .send({ agentAddress: DEMO_ADDRESSES.newbie }).expect(403);
    expect(rejected.body).toMatchObject({ code: 'REPUTATION_TOO_LOW', details: { requiredScore: 401 } });

    const listed = await request(app).get('/api/tasks?status=OPEN').expect(200);
    expect(listed.body).toHaveLength(1);
    await request(app).delete(`/api/tasks/${created.body.id}`).expect(204);
  });

  it('runs claim, stream, completion and reputation improvement end to end', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const created = await request(app).post('/api/tasks').send({
      title: 'Verification task',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '500',
      estimatedDurationSeconds: 1
    }).expect(201);
    const claimed = await request(app).post(`/api/tasks/${created.body.id}/claim`)
      .send({ agentAddress: DEMO_ADDRESSES.newbie }).expect(200);
    expect(claimed.body).toMatchObject({ status: 'STREAMING', collateralLocked: '250' });

    const run = await request(app).post('/api/agent-runs').send({
      taskId: created.body.id,
      agentAddress: DEMO_ADDRESSES.newbie
    }).expect(201);
    expect(run.body).toMatchObject({ status: 'SUBMITTED', provider: 'deterministic-local-v1' });
    expect(run.body.steps.some((step: { kind: string }) => step.kind === 'DELIVERABLE')).toBe(true);
    const dashboard = await request(app).get('/api/dashboard').expect(200);
    expect(dashboard.body.deliverables).toHaveLength(1);
    expect(dashboard.body.deliverables[0]).toMatchObject({ taskId: created.body.id, status: 'SUBMITTED' });

    await request(app).post(`/api/streams/${created.body.id}/complete`).expect(200);
    const reputation = await request(app).get(`/api/reputation/${DEMO_ADDRESSES.newbie}`).expect(200);
    expect(reputation.body.completedTasks).toBe(1);
    expect(reputation.body.score).toBeGreaterThan(100);
    expect(reputation.body.terms.collateralPct).toBe(25);
  });

  it('uses the deterministic arbitrator and slashes failed work', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const task = store.createTask({
      title: 'Publish results',
      creatorAddress: DEMO_ADDRESSES.creator,
      totalAmount: '100',
      estimatedDurationSeconds: 30
    });
    store.claimTask(task.id, DEMO_ADDRESSES.newbie);

    const dispute = await request(app).post('/api/disputes').send({
      taskId: task.id,
      reason: 'No deliverable was provided',
      evidence: 'Empty response and no verifiable proof'
    }).expect(201);
    expect(dispute.body).toMatchObject({ status: 'RESOLVED', verdict: 'FULL_FAULT', slashPct: 100 });
    expect(store.getTask(task.id).status).toBe('SLASHED');
    expect(store.reputation(DEMO_ADDRESSES.newbie).failedTasks).toBe(1);
  });

  it('seeds a veteran and exposes contrasting stream terms', async () => {
    const response = await request(createApp(new DemoStore())).post('/api/demo/scenario').expect(200);
    expect(response.body.comparison.newbie.task.terms.collateralPct).toBe(50);
    expect(response.body.comparison.newbie.task.totalAmount).toBe('500');
    expect(response.body.comparison.veteran.task.totalAmount).toBe('500');
    expect(response.body.comparison.veteran.reputation.score).toBeGreaterThanOrEqual(701);
    expect(response.body.comparison.veteran.task.terms.collateralPct).toBe(0);
    expect(response.body.dashboard.metrics.activeStreams).toBe(2);
  });

  it('loads an idempotent showcase marketplace with a presentation-video brief', async () => {
    const app = createApp(new DemoStore());
    const first = await request(app).post('/api/demo/seed').expect(200);
    expect(first.body.tasks.filter((task: { status: string }) => task.status === 'OPEN')).toHaveLength(8);
    expect(first.body.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentAddress: DEMO_ADDRESSES.proofAgent, displayName: 'PACT Proof Agent' })
    ]));
    expect(first.body.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: 'Create the PACT presentation video',
        totalAmount: '400',
        status: 'OPEN'
      })
    ]));
    const second = await request(app).post('/api/demo/seed').expect(200);
    expect(second.body.tasks.filter((task: { status: string }) => task.status === 'OPEN')).toHaveLength(8);
  });

  it('prepares a guided Proof Agent run and leaves the deliverable for human review', async () => {
    const response = await request(createApp(new DemoStore())).post('/api/demo/showcase').expect(201);
    expect(response.body.message).toBe('Guided showcase is ready for creator review');
    expect(response.body.agent).toMatchObject({
      agentAddress: DEMO_ADDRESSES.proofAgent,
      displayName: 'PACT Proof Agent',
      score: 80
    });
    expect(response.body.task).toMatchObject({
      title: 'Verify the PACT evidence pack',
      status: 'STREAMING',
      agentAddress: DEMO_ADDRESSES.proofAgent,
      collateralLocked: '150'
    });
    expect(response.body.run).toMatchObject({ status: 'SUBMITTED', provider: 'deterministic-local-v1' });
    expect(response.body.deliverable).toMatchObject({ status: 'SUBMITTED', taskId: response.body.task.id });
    expect(response.body.dashboard.tasks).toHaveLength(8);
    expect(response.body.dashboard.agentRuns).toHaveLength(1);
    expect(response.body.dashboard.deliverables).toHaveLength(1);
  });

  it('pushes an initial stream status over the documented WebSocket path', async () => {
    const store = new DemoStore();
    const task = store.createTask({
      title: 'Live task', creatorAddress: DEMO_ADDRESSES.creator, totalAmount: '100', estimatedDurationSeconds: 60
    });
    store.claimTask(task.id, DEMO_ADDRESSES.newbie);
    const runtime = createPactServer(store);
    runtimes.push(runtime);
    runtime.server.listen(0);
    await once(runtime.server, 'listening');
    const port = (runtime.server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/streams/${task.id}/live`);
    const [raw] = await once(socket, 'message');
    const message = JSON.parse(raw.toString());
    expect(message).toMatchObject({ type: 'stream', taskId: task.id, status: { status: 'STREAMING' } });
    socket.close();
  });

  it('runs one private, source-receipted Training Ground attempt per UTC day', async () => {
    const store = new DemoStore();
    const app = createApp(store);
    const templates = await request(app).get(`/api/arena/templates?agentAddress=${DEMO_ADDRESSES.newbie}`).expect(200);
    const template = templates.body.find((item: { id: string }) => item.id === 'daily-economic-document-v1');
    const challenge = await request(app).post(`/api/arena/templates/${template.id}/start`).send({ agentAddress: DEMO_ADDRESSES.newbie }).expect(201);
    expect(challenge.body.document.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(challenge.body.questions.every((question: { rule?: unknown }) => question.rule === undefined)).toBe(true);
    const answersByQuestion: Record<string, string> = {
      'monthly-cpi': '0.5', 'annual-cpi': '3.0', 'annual-core': '3.3', 'largest-contributor': 'shelter',
      'range-lower': '4.25', 'range-upper': '4.5', 'inflation-objective': '2', 'holdings': 'Treasury securities, agency debt, agency mortgage-backed securities',
      'q4-real-gdp': '2.3', 'q3-real-gdp': '3.1', 'core-pce': '2.7', 'offset': 'investment'
    };
    const answers = challenge.body.questions.map((question: { id: string }) => ({ questionId: question.id, answer: answersByQuestion[question.id] }));
    const result = await request(app).post(`/api/arena/attempts/${challenge.body.attemptId}/submit`).send({
      attemptToken: challenge.body.attemptToken,
      agentAddress: DEMO_ADDRESSES.newbie,
      answers,
      evidence: [challenge.body.document.contentHash],
      consentToTraining: true
    }).expect(200);
    expect(result.body).toMatchObject({ status: 'PASSED', pointsAwarded: expect.any(Number), trainingConsent: true });
    expect(result.body.pointsAwarded).toBeGreaterThan(0);
    await request(app).post(`/api/arena/templates/${template.id}/start`).send({ agentAddress: DEMO_ADDRESSES.newbie }).expect(409);
    await request(app).post(`/api/arena/attempts/${challenge.body.attemptId}/submit`).send({
      attemptToken: 'wrong', agentAddress: DEMO_ADDRESSES.newbie, answers, evidence: [challenge.body.document.contentHash]
    }).expect(409);
  });
});
