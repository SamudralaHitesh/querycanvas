import pkg from 'node-sql-parser';
import { isPostgresEnabled } from '../db/postgresAdapter.js';

const { Parser } = pkg;
const parser = new Parser();

const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|TRUNCATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|GRANT|REVOKE|COPY)\b/i;
const FORBIDDEN_TABLES =
  /\b(sqlite_master|sqlite_schema|sqlite_temp_master|_qc_history|_qc_dashboards|_qc_schema_embeddings|pg_catalog|information_schema)\b/i;
const MAX_ROWS_LIMIT = 1000;

export interface SqlGuardResult {
  safe: boolean;
  sanitizedSql: string;
  reason?: string;
}

/**
 * Validates AI-generated or user-edited SQL using an AST parser.
 * Guarantees single-statement read-only SELECT queries with bounded rows.
 */
export function validateAndSanitizeSql(rawSql: string): SqlGuardResult {
  const cleaned = rawSql
    .trim()
    .replace(/^```sql\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()
    .replace(/;+$/, '');

  if (!cleaned) {
    return { safe: false, sanitizedSql: '', reason: 'SQL query is empty.' };
  }

  if (FORBIDDEN_KEYWORDS.test(cleaned)) {
    return {
      safe: false,
      sanitizedSql: '',
      reason: 'Blocked: Only read-only SELECT queries are permitted.',
    };
  }

  if (FORBIDDEN_TABLES.test(cleaned)) {
    return {
      safe: false,
      sanitizedSql: '',
      reason: 'Blocked: Access to internal system tables is restricted.',
    };
  }

  try {
    const dialect = isPostgresEnabled() ? 'Postgresql' : 'Sqlite';
    const ast = parser.astify(cleaned, { database: dialect });
    const statements = Array.isArray(ast) ? ast : [ast];

    if (statements.length !== 1) {
      return {
        safe: false,
        sanitizedSql: '',
        reason: 'Blocked: Multiple SQL statements are not allowed.',
      };
    }

    const stmt = statements[0] as { type?: string };

    if (stmt.type !== 'select') {
      return {
        safe: false,
        sanitizedSql: '',
        reason: `Blocked: Statement type "${stmt.type ?? 'unknown'}" is not allowed. Only SELECT is permitted.`,
      };
    }

    const hasLimit = /\bLIMIT\s+\d+/i.test(cleaned);
    let sanitizedSql = cleaned;
    if (!hasLimit) {
      sanitizedSql = `${cleaned} LIMIT ${MAX_ROWS_LIMIT}`;
    } else {
      sanitizedSql = cleaned.replace(/\bLIMIT\s+(\d+)/i, (_, numStr) => {
        const n = Number(numStr);
        return `LIMIT ${Math.min(n, MAX_ROWS_LIMIT)}`;
      });
    }

    return { safe: true, sanitizedSql };
  } catch (err) {
    return {
      safe: false,
      sanitizedSql: '',
      reason: `SQL parse error: ${err instanceof Error ? err.message : 'Invalid SQL syntax'}`,
    };
  }
}
