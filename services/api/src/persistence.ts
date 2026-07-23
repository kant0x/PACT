import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface StatePersistence<T> {
  load(): T | null;
  save(state: T): void;
}

export class SqliteStatePersistence<T> implements StatePersistence<T> {
  readonly path: string;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    this.database = new DatabaseSync(this.path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS pact_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  load(): T | null {
    const row = this.database.prepare('SELECT value FROM pact_state WHERE key = ?').get('main') as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) as T : null;
  }

  save(state: T) {
    this.database.prepare(`
      INSERT INTO pact_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run('main', JSON.stringify(state), Date.now());
  }

  close() {
    this.database.close();
  }
}
