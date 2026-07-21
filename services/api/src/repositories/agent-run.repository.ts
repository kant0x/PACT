import { query } from '../db.js';
import type { AgentRun } from '@pact/shared';
import { randomUUID } from 'node:crypto';

export class AgentRunRepository {
  async create(run: Omit<AgentRun, 'id' | 'startedAt' | 'completedAt'>): Promise<AgentRun> {
    const id = randomUUID();
    const startedAt = Math.floor(Date.now() / 1000);

    await query(`
      INSERT INTO agent_runs (
        id, task_id, agent_address, provider, status, plan, steps, deliverable_id, error, started_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `, [
      id, run.taskId, run.agentAddress, run.provider, run.status,
      run.plan ? JSON.stringify(run.plan) : null,
      JSON.stringify(run.steps), run.deliverableId, run.error,
      startedAt, null
    ]);

    return {
      id,
      ...run,
      startedAt,
      completedAt: null
    };
  }

  async findById(id: string): Promise<AgentRun | null> {
    const res = await query('SELECT * FROM agent_runs WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToAgentRun(res.rows[0]);
  }

  async findByTaskId(taskId: string): Promise<AgentRun[]> {
    const res = await query('SELECT * FROM agent_runs WHERE task_id = $1 ORDER BY started_at DESC', [taskId]);
    return res.rows.map(this.mapRowToAgentRun);
  }

  async findAll(): Promise<AgentRun[]> {
    const res = await query('SELECT * FROM agent_runs ORDER BY started_at DESC');
    return res.rows.map(this.mapRowToAgentRun);
  }

  async update(id: string, updates: Partial<AgentRun>): Promise<AgentRun | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const updated = { ...current, ...updates };

    await query(`
      UPDATE agent_runs SET
        status = $1, plan = $2, steps = $3, deliverable_id = $4, error = $5, completed_at = $6
      WHERE id = $7
    `, [
      updated.status,
      updated.plan ? JSON.stringify(updated.plan) : null,
      JSON.stringify(updated.steps),
      updated.deliverableId,
      updated.error,
      updated.completedAt,
      id
    ]);

    return updated;
  }

  private mapRowToAgentRun(row: any): AgentRun {
    return {
      id: row.id,
      taskId: row.task_id,
      agentAddress: row.agent_address,
      provider: row.provider,
      status: row.status as AgentRun['status'],
      plan: row.plan,
      steps: row.steps || [],
      deliverableId: row.deliverable_id,
      error: row.error,
      startedAt: parseInt(row.started_at, 10),
      completedAt: row.completed_at ? parseInt(row.completed_at, 10) : null
    };
  }
}

export const agentRunRepository = new AgentRunRepository();
