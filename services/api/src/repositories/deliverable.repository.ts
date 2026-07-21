import { query } from '../db.js';
import type { AgentDeliverable } from '@pact/shared';
import { randomUUID } from 'node:crypto';

export class DeliverableRepository {
  async create(deliverable: Omit<AgentDeliverable, 'id' | 'createdAt' | 'reviewedAt'>): Promise<AgentDeliverable> {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    await query(`
      INSERT INTO deliverables (
        id, task_id, agent_address, summary, artifacts, evidence, status, created_at, reviewed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      id, deliverable.taskId, deliverable.agentAddress, deliverable.summary,
      JSON.stringify(deliverable.artifacts), JSON.stringify(deliverable.evidence),
      deliverable.status, createdAt, null
    ]);

    return {
      id,
      ...deliverable,
      createdAt,
      reviewedAt: null
    };
  }

  async findById(id: string): Promise<AgentDeliverable | null> {
    const res = await query('SELECT * FROM deliverables WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToDeliverable(res.rows[0]);
  }

  async findByTaskId(taskId: string): Promise<AgentDeliverable[]> {
    const res = await query('SELECT * FROM deliverables WHERE task_id = $1 ORDER BY created_at DESC', [taskId]);
    return res.rows.map(this.mapRowToDeliverable);
  }

  async findAll(): Promise<AgentDeliverable[]> {
    const res = await query('SELECT * FROM deliverables ORDER BY created_at DESC');
    return res.rows.map((row) => this.mapRowToDeliverable(row));
  }

  async update(id: string, updates: Partial<AgentDeliverable>): Promise<AgentDeliverable | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const updated = { ...current, ...updates };

    await query(`
      UPDATE deliverables SET
        status = $1, reviewed_at = $2
      WHERE id = $3
    `, [
      updated.status, updated.reviewedAt, id
    ]);

    return updated;
  }

  private mapRowToDeliverable(row: any): AgentDeliverable {
    return {
      id: row.id,
      taskId: row.task_id,
      agentAddress: row.agent_address,
      summary: row.summary,
      artifacts: row.artifacts,
      evidence: row.evidence,
      status: row.status as AgentDeliverable['status'],
      createdAt: parseInt(row.created_at, 10),
      reviewedAt: row.reviewed_at ? parseInt(row.reviewed_at, 10) : null
    };
  }
}

export const deliverableRepository = new DeliverableRepository();
