import { createPublicClient, http, parseAbiItem } from 'viem';
import { mainnet } from 'viem/chains'; // Replace with Arc chain when deploying
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// PostgreSQL connection
const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
const pool = new Pool({
  ...(databaseUrl ? { connectionString: databaseUrl } : {})
});

// Configure Viem client for Arc Testnet (or local anvil)
const arcChain = {
  id: 5042002, // Example Arc Chain ID
  name: 'Arc Testnet',
  network: 'arc-testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls: {
    default: { http: [process.env.RPC_URL || 'http://127.0.0.1:8545'] },
    public: { http: [process.env.RPC_URL || 'http://127.0.0.1:8545'] },
  },
};

const client = createPublicClient({
  chain: arcChain as any,
  transport: http(),
});

const VAULT_ADDRESS = process.env.VAULT_ADDRESS || '0x0000000000000000000000000000000000000000';

async function main() {
  console.log('🚀 Starting PACT Blockchain Indexer...');
  console.log(`📡 Listening to StreamingVault at ${VAULT_ADDRESS}`);

  // Event: StreamCreated
  client.watchEvent({
    address: VAULT_ADDRESS as `0x${string}`,
    event: parseAbiItem('event StreamCreated(uint256 indexed streamId, address indexed creator, address indexed agent, uint256 totalAmount)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const { streamId, creator, agent, totalAmount } = log.args as any;
        console.log(`[Event] StreamCreated: ${streamId} by ${creator} for ${agent}`);

        // Update PostgreSQL
        try {
          await pool.query(
            'UPDATE tasks SET status = $1, chain_task_id = $2 WHERE creator_address = $3 AND agent_address = $4 AND status = $5',
            ['STREAMING', streamId.toString(), creator.toLowerCase(), agent.toLowerCase(), 'ASSIGNED']
          );
          console.log(`✅ Synced StreamCreated to DB for streamId: ${streamId}`);
        } catch (err) {
          console.error(`❌ DB Sync Error (StreamCreated):`, err);
        }
      }
    }
  });

  // Event: StreamPaused (Dispute triggered)
  client.watchEvent({
    address: VAULT_ADDRESS as `0x${string}`,
    event: parseAbiItem('event StreamPaused(uint256 indexed streamId)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const { streamId } = log.args as any;
        console.log(`[Event] StreamPaused: ${streamId}`);

        // Update PostgreSQL
        try {
          await pool.query(
            'UPDATE tasks SET status = $1 WHERE chain_task_id = $2',
            ['PAUSED', streamId.toString()]
          );
          console.log(`✅ Synced StreamPaused to DB for streamId: ${streamId}`);
        } catch (err) {
          console.error(`❌ DB Sync Error (StreamPaused):`, err);
        }
      }
    }
  });

  // Event: CollateralSlashed
  client.watchEvent({
    address: VAULT_ADDRESS as `0x${string}`,
    event: parseAbiItem('event CollateralSlashed(uint256 indexed streamId, uint256 slashAmount)'),
    onLogs: async (logs) => {
      for (const log of logs) {
        const { streamId, slashAmount } = log.args as any;
        console.log(`[Event] CollateralSlashed: ${streamId} for amount ${slashAmount}`);

        try {
          await pool.query(
            'UPDATE tasks SET status = $1 WHERE chain_task_id = $2',
            ['SLASHED', streamId.toString()]
          );
          console.log(`✅ Synced CollateralSlashed to DB for streamId: ${streamId}`);
        } catch (err) {
          console.error(`❌ DB Sync Error (CollateralSlashed):`, err);
        }
      }
    }
  });
}

main().catch(console.error);
