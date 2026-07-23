import { Pool } from 'pg';
import type { StatePersistence } from './persistence.js';

export class PostgresStatePersistence<T> implements StatePersistence<T> {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PACT_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
    });
    this.ready = this.ensureSchema();
  }

  async load(): Promise<T | null> {
    await this.ready;
    const result = await this.pool.query<{ value: T }>(
      'SELECT value FROM pact_state WHERE key = $1',
      ['main']
    );
    return result.rows[0]?.value ?? null;
  }

  async save(state: T): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO pact_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      ['main', JSON.stringify(state)]
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pact_state (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
}

export function createStatePersistenceFromEnv<T>(): StatePersistence<T> | null {
  const connectionString = process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('PACT persistence: no DATABASE_URL/PACT_DATABASE_URL configured; using in-memory demo state');
    return null;
  }
  return new PostgresStatePersistence<T>(connectionString);
}
