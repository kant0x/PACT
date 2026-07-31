import { createPublicClient, formatUnits, getAddress, http, isAddress, parseAbi } from 'viem';
import pg, { type PoolClient } from 'pg';
import dotenv from 'dotenv';
import { createServer } from 'node:http';

dotenv.config();

const { Pool } = pg;
const CHAIN_ID = 5_042_002;
const rpcUrl = process.env.PACT_ARC_RPC_URL ?? process.env.ARC_RPC_URL ?? process.env.RPC_URL ?? 'https://rpc.testnet.arc.network';
const databaseUrl = process.env.PACT_DATABASE_URL ?? process.env.DATABASE_URL;
const configuredVault = process.env.PACT_STREAMING_VAULT_ADDRESS ?? process.env.STREAMING_VAULT_ADDRESS ?? process.env.VAULT_ADDRESS;
const confirmations = BigInt(process.env.PACT_INDEXER_CONFIRMATIONS ?? 5);
const chunkSize = BigInt(process.env.PACT_INDEXER_CHUNK_SIZE ?? 2_000);
const pollIntervalMs = Number(process.env.PACT_INDEXER_POLL_INTERVAL_MS ?? 4_000);

if (!databaseUrl) throw new Error('PACT_DATABASE_URL or DATABASE_URL is required for the indexer');
if (!configuredVault || !isAddress(configuredVault)) throw new Error('PACT_STREAMING_VAULT_ADDRESS must be a valid EVM address');

const vaultAddress = getAddress(configuredVault);
const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 20_000,
  application_name: 'pact-indexer',
});

const arcChain = {
  id: CHAIN_ID,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
} as const;

const publicClient = createPublicClient({ chain: arcChain, transport: http(rpcUrl) });
const events = parseAbi([
  'event TaskCreated(uint256 indexed taskId, address indexed creator, address indexed agent, uint256 totalAmount, uint256 requiredCollateral, uint256 collateralDeadline)',
  'event TaskAssigned(uint256 indexed taskId, address indexed agent, uint256 requiredCollateral, uint256 collateralDeadline)',
  'event CollateralPosted(uint256 indexed taskId, address indexed agent, uint256 amount)',
  'event StreamStarted(uint256 indexed taskId, uint256 ratePerSecond, uint256 timestamp)',
  'event StreamPaused(uint256 indexed taskId, uint256 accruedAmount, uint256 timestamp)',
  'event StreamResumed(uint256 indexed taskId, uint256 timestamp)',
  'event StreamWithdrawn(uint256 indexed taskId, address indexed agent, uint256 amount)',
  'event TaskCompleted(uint256 indexed taskId, uint256 paidToAgent, uint256 collateralReturned)',
  'event CollateralSlashed(uint256 indexed taskId, uint256 slashPct, uint256 collateralSlashed, uint256 earnedByAgent, uint256 refundedToCreator)',
  'event TaskCancelled(uint256 indexed taskId, uint256 refundedToCreator)',
]);

let stopping = false;
let lastIndexedBlock: bigint | null = null;
let lastSuccessfulCycleAt: number | null = null;
let lastError: string | null = null;
const healthPort = Number(process.env.PACT_INDEXER_HEALTH_PORT ?? 9090);
const healthServer = createServer((request, response) => {
  if (request.url !== '/health' && request.url !== '/ready') {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
    return;
  }
  const fresh = lastSuccessfulCycleAt !== null && Date.now() - lastSuccessfulCycleAt < Math.max(30_000, pollIntervalMs * 5);
  const ready = fresh && lastError === null;
  response.writeHead(request.url === '/ready' && !ready ? 503 : 200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({
    status: ready ? 'ok' : 'degraded',
    chainId: CHAIN_ID,
    vaultAddress,
    lastIndexedBlock: lastIndexedBlock?.toString() ?? null,
    lastSuccessfulCycleAt: lastSuccessfulCycleAt ? new Date(lastSuccessfulCycleAt).toISOString() : null,
    error: lastError,
  }));
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chain_events (
      chain_id INTEGER NOT NULL,
      contract_address VARCHAR(42) NOT NULL,
      transaction_hash VARCHAR(66) NOT NULL,
      log_index INTEGER NOT NULL,
      block_number BIGINT NOT NULL,
      event_name VARCHAR(64) NOT NULL,
      chain_task_id VARCHAR(255),
      payload JSONB NOT NULL,
      indexed_at BIGINT NOT NULL,
      PRIMARY KEY (chain_id, transaction_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_chain_events_task ON chain_events(chain_task_id, block_number);
    CREATE TABLE IF NOT EXISTS indexer_checkpoints (
      chain_id INTEGER NOT NULL,
      contract_address VARCHAR(42) NOT NULL,
      last_finalized_block BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (chain_id, contract_address)
    );
  `);
}

async function checkpoint(): Promise<bigint | null> {
  const result = await pool.query(
    'SELECT last_finalized_block FROM indexer_checkpoints WHERE chain_id = $1 AND contract_address = $2',
    [CHAIN_ID, vaultAddress.toLowerCase()],
  );
  return result.rows[0] ? BigInt(result.rows[0].last_finalized_block) : null;
}

async function initialBlock(latestFinalized: bigint): Promise<bigint> {
  const saved = await checkpoint();
  if (saved !== null) return saved + 1n;
  const configured = process.env.PACT_VAULT_DEPLOYMENT_BLOCK;
  if (configured && /^[0-9]+$/.test(configured)) return BigInt(configured);
  const lookback = BigInt(process.env.PACT_INDEXER_INITIAL_LOOKBACK_BLOCKS ?? 10_000);
  return latestFinalized > lookback ? latestFinalized - lookback : 0n;
}

const jsonSafe = (value: unknown) => JSON.stringify(value, (_key, item) => (
  typeof item === 'bigint' ? item.toString() : item
));

interface IndexedLog {
  transactionHash: `0x${string}` | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  eventName?: string;
  args: Record<string, unknown>;
}

async function applyEvent(db: PoolClient, log: IndexedLog) {
  if (!log.transactionHash || log.logIndex === null || log.blockNumber === null || !log.eventName) return;
  const args = log.args as Record<string, unknown>;
  const chainTaskId = typeof args.taskId === 'bigint' ? args.taskId.toString() : null;
  const inserted = await db.query(
    `INSERT INTO chain_events (
       chain_id, contract_address, transaction_hash, log_index, block_number,
       event_name, chain_task_id, payload, indexed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING
     RETURNING transaction_hash`,
    [
      CHAIN_ID,
      vaultAddress.toLowerCase(),
      log.transactionHash.toLowerCase(),
      log.logIndex,
      log.blockNumber.toString(),
      log.eventName,
      chainTaskId,
      jsonSafe(args),
      Math.floor(Date.now() / 1_000),
    ],
  );
  if (!inserted.rowCount || !chainTaskId) return;

  const txHash = log.transactionHash.toLowerCase();
  if (log.eventName === 'TaskCreated') {
    await db.query(
      `UPDATE tasks SET chain_task_id = COALESCE(chain_task_id, $1)
       WHERE funding_tx_hash = $2`,
      [chainTaskId, txHash],
    );
  } else if (log.eventName === 'TaskAssigned') {
    await db.query(
      `UPDATE tasks SET status = 'ASSIGNED', agent_address = $1, collateral_locked = $2,
       assignment_tx_hash = COALESCE(assignment_tx_hash, $3)
       WHERE chain_task_id = $4`,
      [String(args.agent).toLowerCase(), formatUnits(args.requiredCollateral as bigint, 6), txHash, chainTaskId],
    );
  } else if (log.eventName === 'CollateralPosted') {
    await db.query(
      `UPDATE tasks SET status = 'ASSIGNED', collateral_tx_hash = COALESCE(collateral_tx_hash, $1)
       WHERE chain_task_id = $2`,
      [txHash, chainTaskId],
    );
  } else if (log.eventName === 'StreamStarted') {
    await db.query(
      `UPDATE tasks SET status = 'STREAMING', stream_start_tx_hash = COALESCE(stream_start_tx_hash, $1),
       stream_rate_per_second = $2, started_at = COALESCE(started_at, $3)
       WHERE chain_task_id = $4`,
      [txHash, formatUnits(args.ratePerSecond as bigint, 6), Number(args.timestamp), chainTaskId],
    );
  } else if (log.eventName === 'StreamPaused') {
    await db.query(
      `UPDATE tasks SET status = 'PAUSED', accrued_amount = $1 WHERE chain_task_id = $2`,
      [formatUnits(args.accruedAmount as bigint, 6), chainTaskId],
    );
  } else if (log.eventName === 'StreamResumed') {
    await db.query(`UPDATE tasks SET status = 'STREAMING' WHERE chain_task_id = $1`, [chainTaskId]);
  } else if (log.eventName === 'StreamWithdrawn') {
    await db.query(
      `UPDATE tasks SET withdrawn_amount = withdrawn_amount + $1::numeric WHERE chain_task_id = $2`,
      [formatUnits(args.amount as bigint, 6), chainTaskId],
    );
  } else if (log.eventName === 'TaskCompleted') {
    await db.query(
      `UPDATE tasks SET status = 'COMPLETED', completion_tx_hash = COALESCE(completion_tx_hash, $1),
       settlement_tx_hash = COALESCE(settlement_tx_hash, $1), completed_at = COALESCE(completed_at, $2)
       WHERE chain_task_id = $3`,
      [txHash, Number(args.timestamp ?? Math.floor(Date.now() / 1_000)), chainTaskId],
    );
  } else if (log.eventName === 'CollateralSlashed') {
    await db.query(
      `UPDATE tasks SET status = 'SLASHED', collateral_locked = '0',
       settlement_tx_hash = COALESCE(settlement_tx_hash, $1) WHERE chain_task_id = $2`,
      [txHash, chainTaskId],
    );
  } else if (log.eventName === 'TaskCancelled') {
    await db.query(`UPDATE tasks SET status = 'CANCELLED' WHERE chain_task_id = $1`, [chainTaskId]);
  }
}

async function processRange(fromBlock: bigint, toBlock: bigint) {
  const logs = await publicClient.getLogs({
    address: vaultAddress,
    events,
    fromBlock,
    toBlock,
    strict: true,
  }) as unknown as IndexedLog[];
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    for (const log of logs) await applyEvent(db, log);
    await db.query(
      `INSERT INTO indexer_checkpoints (chain_id, contract_address, last_finalized_block, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain_id, contract_address) DO UPDATE
       SET last_finalized_block = EXCLUDED.last_finalized_block, updated_at = EXCLUDED.updated_at`,
      [CHAIN_ID, vaultAddress.toLowerCase(), toBlock.toString(), Math.floor(Date.now() / 1_000)],
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  if (logs.length) console.log(`Indexed ${logs.length} event(s) from blocks ${fromBlock}-${toBlock}`);
  lastIndexedBlock = toBlock;
}

async function main() {
  await ensureSchema();
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== CHAIN_ID) throw new Error(`Expected Arc Testnet chain ${CHAIN_ID}, received ${actualChainId}`);
  console.log(`PACT indexer connected to Arc Testnet; vault ${vaultAddress}`);
  healthServer.listen(healthPort, '0.0.0.0', () => console.log(`Indexer health endpoint listening on ${healthPort}`));

  let cursor: bigint | null = null;
  while (!stopping) {
    try {
      const head = await publicClient.getBlockNumber();
      const latestFinalized = head > confirmations ? head - confirmations : 0n;
      if (cursor === null) cursor = await initialBlock(latestFinalized);
      while (!stopping && cursor !== null && cursor <= latestFinalized) {
        const from = cursor;
        const candidateEnd = from + chunkSize - 1n;
        const end: bigint = candidateEnd < latestFinalized ? candidateEnd : latestFinalized;
        await processRange(from, end);
        cursor = end + 1n;
      }
      lastSuccessfulCycleAt = Date.now();
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error('Indexer polling cycle failed:', error);
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

main()
  .then(async () => {
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
