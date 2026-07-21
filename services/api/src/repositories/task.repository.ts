import { query } from '../db.js';
import type { MarketplaceTask, TaskStatus, StreamTerms, TaskTemplate } from '@pact/shared';
import { randomUUID } from 'node:crypto';

let workOrderColumnReady: Promise<void> | undefined;

/** Keep deployments created from the pre-work-order schema writable. */
function ensureWorkOrderColumn() {
  workOrderColumnReady ??= query(`
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS work_order JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS preferred_agent_address VARCHAR(42);
  `)
    .then(() => undefined)
    .catch((error) => {
      workOrderColumnReady = undefined;
      throw error;
    });
  return workOrderColumnReady;
}

export class TaskRepository {
  async create(task: Omit<MarketplaceTask, 'id' | 'createdAt' | 'chainTaskId'>): Promise<MarketplaceTask> {
    await ensureWorkOrderColumn();
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    
    await query(`
      INSERT INTO tasks (
        id, title, description, success_criteria, creator_address, agent_address,
        total_amount, estimated_duration_seconds, stream_rate_per_second, status,
        collateral_locked, accrued_amount, withdrawn_amount, created_at, started_at, completed_at, template_id, terms, work_order, preferred_agent_address
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    `, [
      id, task.title, task.description, task.successCriteria, task.creatorAddress, task.agentAddress,
      task.totalAmount, task.estimatedDurationSeconds, task.streamRatePerSecond, task.status,
      task.collateralLocked, task.accruedAmount, task.withdrawnAmount, createdAt, task.startedAt, task.completedAt,
      task.templateId || null,
      task.terms ? JSON.stringify(task.terms) : null,
      task.workOrder ? JSON.stringify(task.workOrder) : '{}',
      task.preferredAgentAddress ?? null
    ]);

    return {
      id,
      chainTaskId: null,
      ...task,
      createdAt
    };
  }

  async findById(id: string): Promise<MarketplaceTask | null> {
    const res = await query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToTask(res.rows[0]);
  }

  async findAll(statusFilter?: TaskStatus): Promise<MarketplaceTask[]> {
    let res;
    if (statusFilter) {
      res = await query('SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC', [statusFilter]);
    } else {
      res = await query('SELECT * FROM tasks ORDER BY created_at DESC');
    }
    return res.rows.map(this.mapRowToTask);
  }

  async update(id: string, updates: Partial<MarketplaceTask>): Promise<MarketplaceTask | null> {
    await ensureWorkOrderColumn();
    const current = await this.findById(id);
    if (!current) return null;

    const updated = { ...current, ...updates };

    await query(`
      UPDATE tasks SET
        chain_task_id = $1, title = $2, description = $3, success_criteria = $4,
        agent_address = $5, total_amount = $6, estimated_duration_seconds = $7,
        stream_rate_per_second = $8, status = $9, collateral_locked = $10,
        accrued_amount = $11, withdrawn_amount = $12, started_at = $13,
        completed_at = $14, template_id = $15, terms = $16, work_order = $17, preferred_agent_address = $18
      WHERE id = $19
    `, [
      updated.chainTaskId, updated.title, updated.description, updated.successCriteria,
      updated.agentAddress, updated.totalAmount, updated.estimatedDurationSeconds,
      updated.streamRatePerSecond, updated.status, updated.collateralLocked,
      updated.accruedAmount, updated.withdrawnAmount, updated.startedAt,
      updated.completedAt, updated.templateId || null, updated.terms ? JSON.stringify(updated.terms) : null,
      updated.workOrder ? JSON.stringify(updated.workOrder) : '{}',
      updated.preferredAgentAddress ?? null,
      id
    ]);

    return updated;
  }

  async delete(id: string): Promise<void> {
    await query('DELETE FROM tasks WHERE id = $1', [id]);
  }

  private mapRowToTask(row: any): MarketplaceTask {
    return {
      id: row.id,
      chainTaskId: row.chain_task_id,
      title: row.title,
      description: row.description,
      successCriteria: row.success_criteria,
      creatorAddress: row.creator_address,
      preferredAgentAddress: row.preferred_agent_address || null,
      agentAddress: row.agent_address,
      totalAmount: row.total_amount.toString(),
      estimatedDurationSeconds: row.estimated_duration_seconds,
      streamRatePerSecond: row.stream_rate_per_second.toString(),
      status: row.status as TaskStatus,
      collateralLocked: row.collateral_locked.toString(),
      accruedAmount: row.accrued_amount.toString(),
      withdrawnAmount: row.withdrawn_amount.toString(),
      createdAt: parseInt(row.created_at, 10),
      startedAt: row.started_at ? parseInt(row.started_at, 10) : null,
      completedAt: row.completed_at ? parseInt(row.completed_at, 10) : null,
      templateId: row.template_id || null,
      terms: row.terms as StreamTerms | null,
      workOrder: row.work_order && Object.keys(row.work_order).length ? row.work_order : undefined
    };
  }

  async createTemplate(template: Omit<TaskTemplate, 'id' | 'createdAt' | 'isActive'>): Promise<TaskTemplate> {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    
    await query(`
      INSERT INTO task_templates (
        id, title, description, success_criteria, reward_points, is_active, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      id, template.title, template.description, template.successCriteria,
      template.rewardPoints, true, createdAt
    ]);

    return {
      id,
      ...template,
      isActive: true,
      createdAt
    };
  }

  async findActiveTemplates(): Promise<TaskTemplate[]> {
    const res = await query('SELECT * FROM task_templates WHERE is_active = true ORDER BY created_at DESC');
    return res.rows.map(row => ({
      id: row.id,
      title: row.title,
      description: row.description,
      successCriteria: row.success_criteria,
      rewardPoints: row.reward_points,
      isActive: row.is_active,
      createdAt: parseInt(row.created_at, 10)
    }));
  }

  async findTemplateById(id: string): Promise<TaskTemplate | null> {
    const res = await query('SELECT * FROM task_templates WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      successCriteria: row.success_criteria,
      rewardPoints: row.reward_points,
      isActive: row.is_active,
      createdAt: parseInt(row.created_at, 10)
    };
  }
}

export const taskRepository = new TaskRepository();
