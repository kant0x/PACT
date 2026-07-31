import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { query } from './db.js';

export interface AgentApiKeyRecord {
  id: string;
  agentAddress: string;
  label: string;
  tokenHash: string;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  nextPollAt: number | null;
}

const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');

export class AgentKeyStore {
  private readonly memory = new Map<string, AgentApiKeyRecord>();
  private readonly databaseEnabled = Boolean(process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL);
  private schemaReady: Promise<void> | null = null;

  async issue(agentAddress: string, label: string) {
    const token = `pact_agent_${randomBytes(32).toString('base64url')}`;
    const record: AgentApiKeyRecord = {
      id: randomUUID(),
      agentAddress: agentAddress.toLowerCase(),
      label: label.trim().slice(0, 80) || 'Runtime key',
      tokenHash: tokenHash(token),
      createdAt: Math.floor(Date.now() / 1_000),
      revokedAt: null,
      lastUsedAt: null,
      nextPollAt: null,
    };
    if (this.databaseEnabled) {
      await this.ensureSchema();
      await query(
        `INSERT INTO agent_api_keys
         (id, agent_address, label, token_hash, created_at, revoked_at, last_used_at, next_poll_at)
         VALUES ($1,$2,$3,$4,$5,NULL,NULL,NULL)`,
        [record.id, record.agentAddress, record.label, record.tokenHash, record.createdAt],
      );
    } else {
      this.memory.set(record.id, record);
    }
    return { ...record, token };
  }

  async list(agentAddress: string): Promise<AgentApiKeyRecord[]> {
    if (!this.databaseEnabled) return [...this.memory.values()].filter((record) => record.agentAddress === agentAddress.toLowerCase());
    await this.ensureSchema();
    const result = await query('SELECT * FROM agent_api_keys WHERE agent_address = $1 ORDER BY created_at DESC', [agentAddress.toLowerCase()]);
    return result.rows.map(mapRow);
  }

  async revoke(id: string, agentAddress: string): Promise<AgentApiKeyRecord | null> {
    const now = Math.floor(Date.now() / 1_000);
    if (!this.databaseEnabled) {
      const record = this.memory.get(id);
      if (!record || record.agentAddress !== agentAddress.toLowerCase()) return null;
      record.revokedAt = now;
      return record;
    }
    await this.ensureSchema();
    const result = await query(
      `UPDATE agent_api_keys SET revoked_at = $1
       WHERE id = $2 AND agent_address = $3
       RETURNING *`,
      [now, id, agentAddress.toLowerCase()],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async verify(token: string): Promise<{ agentAddress: string; keyId: string } | null> {
    if (!token.startsWith('pact_agent_')) return null;
    const hash = tokenHash(token);
    const now = Math.floor(Date.now() / 1_000);
    if (!this.databaseEnabled) {
      const record = [...this.memory.values()].find((candidate) => candidate.revokedAt === null && candidate.tokenHash === hash);
      if (!record) return null;
      record.lastUsedAt = now;
      return { agentAddress: record.agentAddress, keyId: record.id };
    }
    await this.ensureSchema();
    const result = await query(
      `UPDATE agent_api_keys SET last_used_at = $1
       WHERE token_hash = $2 AND revoked_at IS NULL
       RETURNING id, agent_address`,
      [now, hash],
    );
    return result.rows[0] ? { agentAddress: result.rows[0].agent_address, keyId: result.rows[0].id } : null;
  }

  async reservePoll(id: string, intervalSeconds: number): Promise<{ allowed: boolean; nextPollAt: number | null }> {
    const now = Math.floor(Date.now() / 1_000);
    if (!this.databaseEnabled) {
      const record = this.memory.get(id);
      if (!record) return { allowed: false, nextPollAt: null };
      if (record.nextPollAt && record.nextPollAt > now) return { allowed: false, nextPollAt: record.nextPollAt };
      record.nextPollAt = now + intervalSeconds;
      return { allowed: true, nextPollAt: record.nextPollAt };
    }
    await this.ensureSchema();
    const result = await query(
      `UPDATE agent_api_keys SET next_poll_at = $1
       WHERE id = $2 AND revoked_at IS NULL AND (next_poll_at IS NULL OR next_poll_at <= $3)
       RETURNING next_poll_at`,
      [now + intervalSeconds, id, now],
    );
    if (result.rows[0]) return { allowed: true, nextPollAt: Number(result.rows[0].next_poll_at) };
    const existing = await query('SELECT next_poll_at FROM agent_api_keys WHERE id = $1 AND revoked_at IS NULL', [id]);
    return { allowed: false, nextPollAt: existing.rows[0]?.next_poll_at ? Number(existing.rows[0].next_poll_at) : null };
  }

  private ensureSchema() {
    this.schemaReady ??= query(`
      CREATE TABLE IF NOT EXISTS agent_api_keys (
        id UUID PRIMARY KEY,
        agent_address VARCHAR(42) NOT NULL REFERENCES agents(agent_address) ON DELETE CASCADE,
        label VARCHAR(80) NOT NULL,
        token_hash VARCHAR(64) NOT NULL UNIQUE,
        created_at BIGINT NOT NULL,
        revoked_at BIGINT,
        last_used_at BIGINT,
        next_poll_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_api_keys_agent ON agent_api_keys(agent_address);
    `).then(() => undefined);
    return this.schemaReady;
  }
}

function mapRow(row: Record<string, unknown>): AgentApiKeyRecord {
  return {
    id: String(row.id),
    agentAddress: String(row.agent_address),
    label: String(row.label),
    tokenHash: String(row.token_hash),
    createdAt: Number(row.created_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
    nextPollAt: row.next_poll_at === null ? null : Number(row.next_poll_at),
  };
}
