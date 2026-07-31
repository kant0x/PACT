import { readFile } from 'node:fs/promises';
import { pool } from './db.js';

const MIGRATION_LOCK_ID = 5042002;

export async function initializeDatabase(): Promise<void> {
  if (!(process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL)) return;

  const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
