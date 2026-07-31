import { createPublicClient, defineChain, http, parseAbiItem, type Address } from 'viem';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the GIWA indexer');

const rpcUrl = process.env.GIWA_RPC_URL || process.env.GIWA_SEPOLIA_RPC_URL || 'https://sepolia-rpc.giwa.io';
const vaultAddress = process.env.STREAMING_VAULT_ADDRESS || process.env.VAULT_ADDRESS;
if (!vaultAddress || !/^0x[0-9a-fA-F]{40}$/.test(vaultAddress)) {
  throw new Error('STREAMING_VAULT_ADDRESS must be a valid GIWA contract address');
}

const giwaSepolia = defineChain({
  id: 91_342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: 'GIWA Sepolia Explorer', url: 'https://sepolia-explorer.giwa.io' } },
});

const client = createPublicClient({ chain: giwaSepolia, transport: http(rpcUrl) });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: process.env.PACT_DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

async function updateTask(status: string, taskId: bigint) {
  await pool.query('UPDATE tasks SET status = $1 WHERE chain_task_id = $2', [status, taskId.toString()]);
}

async function main() {
  const actualChainId = await client.getChainId();
  if (actualChainId !== giwaSepolia.id) {
    throw new Error(`GIWA chain mismatch: expected ${giwaSepolia.id}, received ${actualChainId}`);
  }
  console.log(`PACT GIWA indexer listening to ${vaultAddress} on chain ${actualChainId}`);

  client.watchEvent({
    address: vaultAddress as Address,
    event: parseAbiItem('event TaskCreated(uint256 indexed taskId, address indexed creator, address indexed agent, uint256 totalAmount, uint256 requiredCollateral, uint256 collateralDeadline)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const { taskId, creator, agent } = log.args;
        if (taskId === undefined || !creator || !agent) continue;
        try {
          await pool.query(
            'UPDATE tasks SET status = $1, chain_task_id = $2 WHERE creator_address = $3 AND agent_address = $4 AND status = $5',
            ['OPEN', taskId.toString(), creator.toLowerCase(), agent.toLowerCase(), 'ASSIGNED'],
          );
        } catch (error) {
          console.error('PostgreSQL sync error (TaskCreated):', error);
        }
      }
    },
  });

  client.watchEvent({
    address: vaultAddress as Address,
    event: parseAbiItem('event StreamStarted(uint256 indexed taskId, uint256 ratePerSecond, uint256 timestamp)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        if (log.args.taskId === undefined) continue;
        try { await updateTask('STREAMING', log.args.taskId); }
        catch (error) { console.error('PostgreSQL sync error (StreamStarted):', error); }
      }
    },
  });

  client.watchEvent({
    address: vaultAddress as Address,
    event: parseAbiItem('event StreamPaused(uint256 indexed taskId, uint256 accruedAmount, uint256 timestamp)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        if (log.args.taskId === undefined) continue;
        try { await updateTask('PAUSED', log.args.taskId); }
        catch (error) { console.error('PostgreSQL sync error (StreamPaused):', error); }
      }
    },
  });

  client.watchEvent({
    address: vaultAddress as Address,
    event: parseAbiItem('event TaskCompleted(uint256 indexed taskId, uint256 paidToAgent, uint256 collateralReturned)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        if (log.args.taskId === undefined) continue;
        try { await updateTask('COMPLETED', log.args.taskId); }
        catch (error) { console.error('PostgreSQL sync error (TaskCompleted):', error); }
      }
    },
  });

  client.watchEvent({
    address: vaultAddress as Address,
    event: parseAbiItem('event CollateralSlashed(uint256 indexed taskId, uint256 slashPct, uint256 collateralSlashed, uint256 earnedByAgent, uint256 refundedToCreator)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        if (log.args.taskId === undefined) continue;
        try { await updateTask('SLASHED', log.args.taskId); }
        catch (error) { console.error('PostgreSQL sync error (CollateralSlashed):', error); }
      }
    },
  });
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exitCode = 1;
});
