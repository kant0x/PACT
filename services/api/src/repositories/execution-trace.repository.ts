import { query } from '../db.js';
import type { AgentExecutionTrace } from '@pact/shared';
import { randomUUID } from 'node:crypto';

export class ExecutionTraceRepository {
  async create(trace: Omit<AgentExecutionTrace, 'id' | 'createdAt' | 'finalizedAt'>): Promise<AgentExecutionTrace> {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    await query(`
      INSERT INTO execution_traces (
        id, task_id, agent_address, messages, tool_calls, deliverable_summary,
        evidence, consent_to_training, provider, review_status, reviewed_at,
        reviewer_id, outcome, created_at, finalized_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      id, trace.taskId, trace.agentAddress, JSON.stringify(trace.messages),
      JSON.stringify(trace.toolCalls), trace.deliverableSummary,
      JSON.stringify(trace.evidence), trace.consentToTraining, trace.provider,
      trace.reviewStatus, trace.reviewedAt, trace.reviewerId, trace.outcome,
      createdAt, null
    ]);

    return {
      id,
      ...trace,
      createdAt,
      finalizedAt: null
    };
  }

  async findById(id: string): Promise<AgentExecutionTrace | null> {
    const res = await query('SELECT * FROM execution_traces WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToTrace(res.rows[0]);
  }

  async findByTaskId(taskId: string): Promise<AgentExecutionTrace[]> {
    const res = await query('SELECT * FROM execution_traces WHERE task_id = $1 ORDER BY created_at DESC', [taskId]);
    return res.rows.map(this.mapRowToTrace);
  }

  async findAll(): Promise<AgentExecutionTrace[]> {
    const res = await query('SELECT * FROM execution_traces ORDER BY created_at DESC');
    return res.rows.map(this.mapRowToTrace);
  }

  async update(id: string, updates: Partial<AgentExecutionTrace>): Promise<AgentExecutionTrace | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const updated = { ...current, ...updates };

    await query(`
      UPDATE execution_traces SET
        review_status = $1, reviewed_at = $2, reviewer_id = $3,
        outcome = $4, finalized_at = $5
      WHERE id = $6
    `, [
      updated.reviewStatus, updated.reviewedAt, updated.reviewerId,
      updated.outcome, updated.finalizedAt, id
    ]);

    return updated;
  }

  private mapRowToTrace(row: any): AgentExecutionTrace {
    return {
      id: row.id,
      taskId: row.task_id,
      agentAddress: row.agent_address,
      messages: row.messages,
      toolCalls: row.tool_calls,
      deliverableSummary: row.deliverable_summary,
      evidence: row.evidence,
      consentToTraining: row.consent_to_training,
      provider: row.provider,
      reviewStatus: row.review_status as AgentExecutionTrace['reviewStatus'],
      reviewedAt: row.reviewed_at ? parseInt(row.reviewed_at, 10) : null,
      reviewerId: row.reviewer_id,
      outcome: row.outcome as AgentExecutionTrace['outcome'],
      createdAt: parseInt(row.created_at, 10),
      finalizedAt: row.finalized_at ? parseInt(row.finalized_at, 10) : null
    };
  }
}

export const executionTraceRepository = new ExecutionTraceRepository();
