import { query } from '../db.js';
import type { Dispute, DisputeVerdict, ArbitrationReceipt, HumanReviewReceipt } from '@pact/shared';
import { randomUUID } from 'node:crypto';

export class DisputeRepository {
  async create(dispute: Omit<Dispute, 'id' | 'createdAt' | 'resolvedAt'>): Promise<Dispute> {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);

    await query(`
      INSERT INTO disputes (
        id, task_id, reason, evidence, status, verdict, slash_pct, reasoning,
        arbitrator_provider, decision_confidence, arbitration_receipt, human_review,
        created_at, resolved_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      id, dispute.taskId, dispute.reason, dispute.evidence, dispute.status,
      dispute.verdict, dispute.slashPct, dispute.reasoning, dispute.arbitratorProvider,
      dispute.decisionConfidence, dispute.arbitrationReceipt ? JSON.stringify(dispute.arbitrationReceipt) : null,
      dispute.humanReview ? JSON.stringify(dispute.humanReview) : null,
      createdAt, null
    ]);

    return {
      id,
      ...dispute,
      createdAt,
      resolvedAt: null
    };
  }

  async findById(id: string): Promise<Dispute | null> {
    const res = await query('SELECT * FROM disputes WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToDispute(res.rows[0]);
  }

  async findByTaskId(taskId: string): Promise<Dispute[]> {
    const res = await query('SELECT * FROM disputes WHERE task_id = $1 ORDER BY created_at DESC', [taskId]);
    return res.rows.map(this.mapRowToDispute);
  }

  async findAll(): Promise<Dispute[]> {
    const res = await query('SELECT * FROM disputes ORDER BY created_at DESC');
    return res.rows.map(this.mapRowToDispute);
  }

  async update(id: string, updates: Partial<Dispute>): Promise<Dispute | null> {
    const current = await this.findById(id);
    if (!current) return null;

    const updated = { ...current, ...updates };

    await query(`
      UPDATE disputes SET
        status = $1, verdict = $2, slash_pct = $3, reasoning = $4,
        arbitrator_provider = $5, decision_confidence = $6,
        arbitration_receipt = $7, human_review = $8, resolved_at = $9
      WHERE id = $10
    `, [
      updated.status, updated.verdict, updated.slashPct, updated.reasoning,
      updated.arbitratorProvider, updated.decisionConfidence,
      updated.arbitrationReceipt ? JSON.stringify(updated.arbitrationReceipt) : null,
      updated.humanReview ? JSON.stringify(updated.humanReview) : null,
      updated.resolvedAt, id
    ]);

    return updated;
  }

  private mapRowToDispute(row: any): Dispute {
    return {
      id: row.id,
      taskId: row.task_id,
      reason: row.reason,
      evidence: row.evidence,
      status: row.status as Dispute['status'],
      verdict: row.verdict as DisputeVerdict | null,
      slashPct: row.slash_pct,
      reasoning: row.reasoning,
      arbitratorProvider: row.arbitrator_provider,
      decisionConfidence: row.decision_confidence,
      arbitrationReceipt: row.arbitration_receipt as ArbitrationReceipt | null,
      humanReview: row.human_review as HumanReviewReceipt | null,
      createdAt: parseInt(row.created_at, 10),
      resolvedAt: row.resolved_at ? parseInt(row.resolved_at, 10) : null
    };
  }
}

export const disputeRepository = new DisputeRepository();
