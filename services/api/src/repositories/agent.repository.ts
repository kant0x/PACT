import { query } from '../db.js';
import type { AgentCapabilityManifest } from '@pact/shared';

export interface AgentRecord {
  agentAddress: string;
  displayName: string;
  score: number;
  completedTasks: number;
  failedTasks: number;
  totalVolumeStreamed: string;
  platformPoints: number;
  lastUpdated: number;
  capabilityManifest: AgentCapabilityManifest;
  walletProvider: 'CIRCLE' | 'EXTERNAL';
  walletAccountType: 'SCA' | 'EOA';
  controllerAddress: string;
  circleWalletId: string | null;
  circleWalletSetId: string | null;
}

export class AgentRepository {
  async create(agent: AgentRecord): Promise<void> {
    await query(`
      INSERT INTO agents (
        agent_address, display_name, score, completed_tasks, failed_tasks,
        total_volume_streamed, platform_points, last_updated, capability_manifest,
        wallet_provider, wallet_account_type, controller_address, circle_wallet_id, circle_wallet_set_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      agent.agentAddress,
      agent.displayName,
      agent.score,
      agent.completedTasks,
      agent.failedTasks,
      agent.totalVolumeStreamed,
      agent.platformPoints,
      agent.lastUpdated,
      JSON.stringify(agent.capabilityManifest),
      agent.walletProvider,
      agent.walletAccountType,
      agent.controllerAddress,
      agent.circleWalletId,
      agent.circleWalletSetId
    ]);
  }

  async findByAddress(address: string): Promise<AgentRecord | null> {
    const res = await query('SELECT * FROM agents WHERE agent_address = $1', [address]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      agentAddress: row.agent_address,
      displayName: row.display_name,
      score: row.score,
      completedTasks: row.completed_tasks,
      failedTasks: row.failed_tasks,
      totalVolumeStreamed: row.total_volume_streamed.toString(),
      platformPoints: parseInt(row.platform_points, 10),
      lastUpdated: parseInt(row.last_updated, 10),
      capabilityManifest: typeof row.capability_manifest === 'string' ? JSON.parse(row.capability_manifest) : row.capability_manifest,
      walletProvider: row.wallet_provider ?? 'EXTERNAL',
      walletAccountType: row.wallet_account_type ?? 'EOA',
      controllerAddress: row.controller_address ?? row.agent_address,
      circleWalletId: row.circle_wallet_id ?? null,
      circleWalletSetId: row.circle_wallet_set_id ?? null
    };
  }

  async findAll(): Promise<AgentRecord[]> {
    const res = await query('SELECT * FROM agents');
    return res.rows.map(row => ({
      agentAddress: row.agent_address,
      displayName: row.display_name,
      score: row.score,
      completedTasks: row.completed_tasks,
      failedTasks: row.failed_tasks,
      totalVolumeStreamed: row.total_volume_streamed.toString(),
      platformPoints: parseInt(row.platform_points, 10),
      lastUpdated: parseInt(row.last_updated, 10),
      capabilityManifest: typeof row.capability_manifest === 'string' ? JSON.parse(row.capability_manifest) : row.capability_manifest,
      walletProvider: row.wallet_provider ?? 'EXTERNAL',
      walletAccountType: row.wallet_account_type ?? 'EOA',
      controllerAddress: row.controller_address ?? row.agent_address,
      circleWalletId: row.circle_wallet_id ?? null,
      circleWalletSetId: row.circle_wallet_set_id ?? null
    }));
  }

  async countByController(controllerAddress: string): Promise<number> {
    const res = await query(
      `SELECT COUNT(*)::int AS count
       FROM agents
       WHERE wallet_provider = 'CIRCLE' AND lower(controller_address) = lower($1)`,
      [controllerAddress],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  async awardPlatformPoints(address: string, points: number): Promise<void> {
    await query(`
      UPDATE agents
      SET platform_points = platform_points + $1
      WHERE agent_address = $2
    `, [points, address]);
  }

  async recordCommercialOutcome(address: string, success: boolean, volumeStreamed: string): Promise<void> {
    await query(`
      UPDATE agents
      SET completed_tasks = completed_tasks + CASE WHEN $1 THEN 1 ELSE 0 END,
          failed_tasks = failed_tasks + CASE WHEN $1 THEN 0 ELSE 1 END,
          total_volume_streamed = total_volume_streamed + $2::numeric,
          score = CASE WHEN $1 THEN LEAST(1000, score + 5) ELSE GREATEST(0, score - 25) END,
          last_updated = $3
      WHERE agent_address = $4
    `, [success, volumeStreamed, Math.floor(Date.now() / 1000), address.toLowerCase()]);
  }

  async updateCapabilities(address: string, manifest: AgentCapabilityManifest): Promise<AgentRecord | null> {
    await query(`
      UPDATE agents
      SET capability_manifest = $1, last_updated = $2
      WHERE agent_address = $3
    `, [JSON.stringify(manifest), Math.floor(Date.now() / 1000), address.toLowerCase()]);
    return this.findByAddress(address.toLowerCase());
  }
}

export const agentRepository = new AgentRepository();
