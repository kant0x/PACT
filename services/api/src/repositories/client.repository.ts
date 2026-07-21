import { query } from '../db.js';

export interface ClientRecord {
  clientAddress: string;
  displayName: string;
  totalSpent: string;
  tasksCreated: number;
  createdAt: number;
}

export class ClientRepository {
  async create(client: ClientRecord): Promise<void> {
    await query(`
      INSERT INTO clients (
        client_address, display_name, total_spent, tasks_created, created_at
      ) VALUES ($1, $2, $3, $4, $5)
    `, [
      client.clientAddress,
      client.displayName,
      client.totalSpent,
      client.tasksCreated,
      client.createdAt
    ]);
  }

  async findByAddress(address: string): Promise<ClientRecord | null> {
    const res = await query('SELECT * FROM clients WHERE client_address = $1', [address]);
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      clientAddress: row.client_address,
      displayName: row.display_name,
      totalSpent: row.total_spent.toString(),
      tasksCreated: row.tasks_created,
      createdAt: parseInt(row.created_at, 10)
    };
  }

  async findAll(): Promise<ClientRecord[]> {
    const res = await query('SELECT * FROM clients');
    return res.rows.map(row => ({
      clientAddress: row.client_address,
      displayName: row.display_name,
      totalSpent: row.total_spent.toString(),
      tasksCreated: row.tasks_created,
      createdAt: parseInt(row.created_at, 10)
    }));
  }
}

export const clientRepository = new ClientRepository();
