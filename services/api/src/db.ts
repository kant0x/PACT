import pg from 'pg';
import { config } from 'dotenv';

config(); // Load environment variables from .env

const { Pool } = pg;

// Durable state uses PostgreSQL. Supply DATABASE_URL through the deployment
// secret manager instead of relying on checked-in developer credentials.
const databaseUrl = process.env.DATABASE_URL;

export const pool = new Pool({
  ...(databaseUrl ? { connectionString: databaseUrl } : {}),
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export const query = async (text: string, params?: any[]) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  // console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
};
