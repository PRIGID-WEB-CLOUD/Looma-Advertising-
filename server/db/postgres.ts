import crypto from 'node:crypto';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';
import { POSTGRES_SCHEMA_DDL } from './drizzle-schema';

// Parse PostgreSQL BIGINT (int8) as JS number so micros/counts behave identically to SQLite numbers
pg.types.setTypeParser(20, (val: string) => Number(val));
// Parse PostgreSQL DATE and TIMESTAMPTZ as deterministic UTC strings
pg.types.setTypeParser(1082, (val: string) => val);
pg.types.setTypeParser(1114, (val: string) => new Date(`${val}Z`).toISOString());
pg.types.setTypeParser(1184, (val: string) => new Date(val).toISOString());

export interface DbClient {
  dialect: 'postgres' | 'sqlite';
  drizzle?: NodePgDatabase<typeof schema>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Translates positional `?` SQL placeholders into PostgreSQL `$1, $2, ...`
 * while skipping `?` characters inside string literals, identifiers, or comments.
 */
export function convertPlaceholdersToPg(sql: string): string {
  let out = '';
  let paramIndex = 1;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      out += ch;
      if (ch === '*' && next === '/') {
        out += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"' && next === '"') {
        out += next;
        i += 1;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      out += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      out += `$${paramIndex}`;
      paramIndex += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

export function shouldUsePostgresSsl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    const sslMode = parsed.searchParams.get('sslmode')?.toLowerCase();
    if (sslMode === 'disable' || sslMode === 'false') return false;
    if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full' || sslMode === 'no-verify') {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && !host.endsWith('.hyperdrive.local');
  } catch {
    return false;
  }
}

export function createPgQueryClient(
  runner: pg.Pool | pg.PoolClient | pg.Client,
  drizzleDb: NodePgDatabase<typeof schema>,
  parentPool?: pg.Pool,
  inTransaction = false,
  dedicatedClient?: pg.Client
): DbClient {
  const client: DbClient = {
    dialect: 'postgres',
    drizzle: drizzleDb,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await runner.query(convertPlaceholdersToPg(sql), params);
      return res.rows as T[];
    },
    async queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
      const res = await runner.query(convertPlaceholdersToPg(sql), params);
      return (res.rows[0] as T | undefined) ?? undefined;
    },
    async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
      const res = await runner.query(convertPlaceholdersToPg(sql), params);
      return { rowCount: res.rowCount ?? 0 };
    },
    async exec(sql: string): Promise<void> {
      await runner.query(sql);
    },
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      if (inTransaction) {
        const sp = `sp_${crypto.randomBytes(6).toString('hex')}`;
        await runner.query(`SAVEPOINT ${sp}`);
        try {
          const result = await fn(client);
          await runner.query(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          await runner.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
          throw err;
        }
      }

      if (dedicatedClient) {
        await dedicatedClient.query('BEGIN');
        await dedicatedClient.query("SET TIME ZONE 'UTC'");
        const txClient = createPgQueryClient(dedicatedClient, drizzleDb, undefined, true, dedicatedClient);
        try {
          const result = await fn(txClient);
          await dedicatedClient.query('COMMIT');
          return result;
        } catch (err) {
          await dedicatedClient.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }

      const poolRef = parentPool ?? (runner as pg.Pool);
      const poolClient = await poolRef.connect();
      try {
        await poolClient.query('BEGIN');
        await poolClient.query("SET TIME ZONE 'UTC'");
        const txClient = createPgQueryClient(
          poolClient,
          drizzle(poolClient, { schema }),
          poolRef,
          true
        );
        const result = await fn(txClient);
        await poolClient.query('COMMIT');
        return result;
      } catch (err) {
        await poolClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        poolClient.release();
      }
    },
    async close(): Promise<void> {
      if (!inTransaction && dedicatedClient) {
        await dedicatedClient.end().catch(() => {});
      } else if (!inTransaction && parentPool) {
        await parentPool.end();
      }
    },
  };

  return client;
}

export async function createPostgresClientDb(
  connectionString: string,
  options?: { ensureSchema?: boolean }
): Promise<DbClient> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: 15_000,
    ssl: shouldUsePostgresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  await client.query("SET TIME ZONE 'UTC'");
  const db = createPgQueryClient(client, drizzle(client, { schema }), undefined, false, client);
  if (options?.ensureSchema) {
    await db.exec(POSTGRES_SCHEMA_DDL);
  }
  return db;
}

export async function createPostgresDb(connectionString: string, maxConnections = 8): Promise<DbClient> {
  const pool = new pg.Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl: shouldUsePostgresSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  pool.on('connect', (client) => {
    void client.query("SET TIME ZONE 'UTC'").catch(() => {});
  });
  pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
  });
  const db = createPgQueryClient(pool, drizzle(pool, { schema }), pool);
  await db.exec(POSTGRES_SCHEMA_DDL);
  return db;
}

export async function withTransaction<T>(db: DbClient, fn: (tx: DbClient) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
