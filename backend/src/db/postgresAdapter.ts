import { Pool } from 'pg';
import type { TableSchema } from './database.js';

let pool: Pool | null = null;

export function isPostgresEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0);
}

export function getPgPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
    });
  }
  return pool;
}

export async function initPostgresDatabase(): Promise<void> {
  const pg = getPgPool();
  await pg.query(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS _qc_history (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      sql_query TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
      retries INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS _qc_dashboards (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      sql_query TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      x_axis TEXT,
      y_axis TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS _qc_schema_embeddings (
      table_name TEXT PRIMARY KEY,
      schema_text TEXT NOT NULL,
      embedding vector(1536),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function executePostgresReadOnly(sql: string): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs: number;
}> {
  const pg = getPgPool();
  const client = await pg.connect();
  const start = performance.now();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    const result = await client.query(sql);
    await client.query('COMMIT');
    const rows = (result.rows || []) as Record<string, unknown>[];
    const columns =
      rows.length > 0
        ? Object.keys(rows[0])
        : (result.fields || []).map((f) => f.name);
    return {
      columns,
      rows,
      executionMs: Math.round((performance.now() - start) * 100) / 100,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listPostgresTables(): Promise<TableSchema[]> {
  const pg = getPgPool();
  const { rows: tableRows } = await pg.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '_qc_%'
    ORDER BY table_name;
  `);

  const schemas: TableSchema[] = [];
  for (const { table_name } of tableRows) {
    const safeIdent = `"${table_name.replace(/"/g, '""')}"`;
    const colRes = await pg.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position;`,
      [table_name]
    );
    const countRes = await pg.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM ${safeIdent};`
    );
    const sampleRes = await pg.query<Record<string, unknown>>(
      `SELECT * FROM ${safeIdent} LIMIT 3;`
    );

    schemas.push({
      name: table_name,
      rowCount: Number(countRes.rows[0]?.cnt || 0),
      columns: colRes.rows.map((c) => ({
        name: c.column_name,
        type: c.data_type.toUpperCase(),
        notnull: c.is_nullable === 'NO',
        pk: c.column_name === 'id',
      })),
      sampleRows: sampleRes.rows,
    });
  }
  return schemas;
}
