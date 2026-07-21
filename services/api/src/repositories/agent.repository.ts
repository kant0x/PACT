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
}

export class AgentRepository {
  async create(agent: AgentRecord): Promise<void> {
    await query(`
      INSERT INTO agents (
        agent_address, display_name, score, completed_tasks, failed_tasks,
        total_volume_streamed, platform_points, last_updated, capability_manifest
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      agent.agentAddress,
      agent.displayName,
      agent.score,
      agent.completedTasks,
      agent.failedTasks,
      agent.totalVolumeStreamed,
      agent.platformPoints,
      agent.lastUpdated,
      JSON.stringify(agent.capabilityManifest)
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
      capabilityManifest: typeof row.capability_manifest === 'string' ? JSON.parse(row.capability_manifest) : row.capability_manifest
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
      capabilityManifest: typeof row.capability_manifest === 'string' ? JSON.parse(row.capability_manifest) : row.capability_manifest
    }));
  }

  async awardPlatformPoints(address: string, points: number): Promise<void> {
    await query(`
      UPDATE agents
      SET platform_points = platform_points + $1
      WHERE agent_address = $2
    `, [points, address]);
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
