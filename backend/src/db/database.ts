import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  executePostgresReadOnly,
  initPostgresDatabase,
  isPostgresEnabled,
  listPostgresTables,
} from './postgresAdapter.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'querycanvas.db');

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
}

export interface TableSchema {
  name: string;
  rowCount: number;
  columns: ColumnInfo[];
  sampleRows: Record<string, unknown>[];
}

export interface ColumnProfile {
  name: string;
  type: string;
  nullCount: number;
  distinctCount: number;
  min?: number | string | null;
  max?: number | string | null;
  avg?: number | null;
}

export interface TableProfile {
  tableName: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnProfile[];
}

export interface PinnedChart {
  id: number;
  title: string;
  question: string;
  sql_query: string;
  chart_type: string;
  x_axis: string | null;
  y_axis: string | null;
  created_at: string;
}

export interface PdfDocSummary {
  id: number;
  filename: string;
  page_count: number;
  char_count: number;
  preview: string;
  created_at: string;
}

export interface PdfDocFull extends PdfDocSummary {
  extracted_text: string;
}

let writeDb: DatabaseSync | null = null;

export function getDbEngineInfo() {
  return isPostgresEnabled()
    ? { engine: 'postgres-pgvector', readOnlyEnforced: true }
    : { engine: 'sqlite-wal', readOnlyEnforced: true };
}

export function getWriteDb(): DatabaseSync {
  if (!writeDb) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeDb = new DatabaseSync(DB_PATH);
    writeDb.exec('PRAGMA journal_mode = WAL;');
    writeDb.exec('PRAGMA foreign_keys = ON;');
  }
  return writeDb;
}

/**
 * Opens a dedicated read-only SQLite handle for executing AI-generated SQL.
 * When DATABASE_URL is configured, delegates to Postgres BEGIN READ ONLY.
 */
export async function executeReadOnlyQueryAsync(sql: string): Promise<{
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs: number;
}> {
  if (isPostgresEnabled()) {
    return executePostgresReadOnly(sql);
  }
  return executeReadOnlyQuery(sql);
}

export function executeReadOnlyQuery(sql: string): {
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs: number;
} {
  getWriteDb();
  const start = performance.now();
  const roDb = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const stmt = roDb.prepare(sql);
    const rows = stmt.all() as Record<string, unknown>[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return {
      columns,
      rows,
      executionMs: Math.round((performance.now() - start) * 100) / 100,
    };
  } finally {
    roDb.close();
  }
}

export async function listUserTablesAsync(): Promise<TableSchema[]> {
  if (isPostgresEnabled()) {
    return listPostgresTables();
  }
  return listUserTables();
}

export function listUserTables(): TableSchema[] {
  const db = getWriteDb();
  const tableRows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_qc_%'
       ORDER BY name;`
    )
    .all() as { name: string }[];

  return tableRows.map(({ name }) => {
    const safeIdent = `"${name.replace(/"/g, '""')}"`;
    const colsRaw = db.prepare(`PRAGMA table_info(${safeIdent});`).all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    const countRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM ${safeIdent};`)
      .get() as { cnt: number };
    const sampleRows = db
      .prepare(`SELECT * FROM ${safeIdent} LIMIT 3;`)
      .all() as Record<string, unknown>[];

    return {
      name,
      rowCount: countRow.cnt,
      columns: colsRaw.map((c) => ({
        name: c.name,
        type: c.type || 'TEXT',
        notnull: Boolean(c.notnull),
        pk: Boolean(c.pk),
      })),
      sampleRows,
    };
  });
}

export function getKpiSummary(): {
  totalRevenue: number;
  completedOrders: number;
  avgOrderValue: number;
  topCategory: string;
} {
  const db = getWriteDb();
  const orderStats = db
    .prepare(
      `SELECT
        ROUND(COALESCE(SUM(total_amount), 0), 2) AS total_revenue,
        COUNT(*) AS completed_orders,
        ROUND(COALESCE(AVG(total_amount), 0), 2) AS avg_order_value
       FROM orders
       WHERE status = 'completed';`
    )
    .get() as {
    total_revenue: number;
    completed_orders: number;
    avg_order_value: number;
  };

  const topCatRow = db
    .prepare(
      `SELECT p.category
       FROM order_items oi
       JOIN products p ON oi.product_id = p.id
       JOIN orders o ON oi.order_id = o.id
       WHERE o.status = 'completed'
       GROUP BY p.category
       ORDER BY SUM(oi.line_total) DESC
       LIMIT 1;`
    )
    .get() as { category?: string } | undefined;

  return {
    totalRevenue: Number(orderStats?.total_revenue || 0),
    completedOrders: Number(orderStats?.completed_orders || 0),
    avgOrderValue: Number(orderStats?.avg_order_value || 0),
    topCategory: topCatRow?.category || 'N/A',
  };
}

export function getTableProfile(tableName: string): TableProfile {
  const tables = listUserTables();
  const target = tables.find((t) => t.name === tableName);
  if (!target) {
    throw new Error(`Table "${tableName}" not found.`);
  }

  const db = getWriteDb();
  const safeTable = `"${target.name.replace(/"/g, '""')}"`;

  const columns: ColumnProfile[] = target.columns.map((col) => {
    const safeCol = `"${col.name.replace(/"/g, '""')}"`;
    const isNumeric = /INT|REAL|FLOAT|NUM|DOUBLE|DECIMAL/i.test(col.type);

    if (isNumeric) {
      const stats = db
        .prepare(
          `SELECT
            SUM(CASE WHEN ${safeCol} IS NULL THEN 1 ELSE 0 END) AS null_cnt,
            COUNT(DISTINCT ${safeCol}) AS distinct_cnt,
            MIN(${safeCol}) AS min_val,
            MAX(${safeCol}) AS max_val,
            ROUND(AVG(${safeCol}), 2) AS avg_val
           FROM ${safeTable};`
        )
        .get() as {
        null_cnt: number;
        distinct_cnt: number;
        min_val: number | null;
        max_val: number | null;
        avg_val: number | null;
      };

      return {
        name: col.name,
        type: col.type,
        nullCount: Number(stats.null_cnt || 0),
        distinctCount: Number(stats.distinct_cnt || 0),
        min: stats.min_val,
        max: stats.max_val,
        avg: stats.avg_val,
      };
    }

    const stats = db
      .prepare(
        `SELECT
          SUM(CASE WHEN ${safeCol} IS NULL OR ${safeCol} = '' THEN 1 ELSE 0 END) AS null_cnt,
          COUNT(DISTINCT ${safeCol}) AS distinct_cnt
         FROM ${safeTable};`
      )
      .get() as { null_cnt: number; distinct_cnt: number };

    return {
      name: col.name,
      type: col.type,
      nullCount: Number(stats.null_cnt || 0),
      distinctCount: Number(stats.distinct_cnt || 0),
    };
  });

  return {
    tableName: target.name,
    rowCount: target.rowCount,
    columnCount: target.columns.length,
    columns,
  };
}

export function saveQueryHistory(entry: {
  question: string;
  sql: string;
  chartType: string;
  rowCount: number;
  latencyMs: number;
  cacheHit: boolean;
  retries: number;
}): void {
  const db = getWriteDb();
  db.prepare(
    `INSERT INTO _qc_history (question, sql_query, chart_type, row_count, latency_ms, cache_hit, retries)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.question,
    entry.sql,
    entry.chartType,
    entry.rowCount,
    entry.latencyMs,
    entry.cacheHit ? 1 : 0,
    entry.retries
  );
}

export function getQueryHistory(limit = 25): Record<string, unknown>[] {
  const db = getWriteDb();
  return db
    .prepare(
      `SELECT id, question, sql_query, chart_type, row_count, latency_ms, cache_hit, retries, created_at
       FROM _qc_history
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
}

export function savePinnedChart(entry: {
  title: string;
  question: string;
  sql: string;
  chartType: string;
  xAxis: string | null;
  yAxis: string | null;
}): PinnedChart {
  const db = getWriteDb();
  const res = db
    .prepare(
      `INSERT INTO _qc_dashboards (title, question, sql_query, chart_type, x_axis, y_axis)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.title,
      entry.question,
      entry.sql,
      entry.chartType,
      entry.xAxis,
      entry.yAxis
    );

  return db
    .prepare('SELECT * FROM _qc_dashboards WHERE id = ?')
    .get(Number(res.lastInsertRowid)) as unknown as PinnedChart;
}

export function listPinnedCharts(): PinnedChart[] {
  const db = getWriteDb();
  return db
    .prepare('SELECT * FROM _qc_dashboards ORDER BY id DESC')
    .all() as unknown as PinnedChart[];
}

export function deletePinnedChart(id: number): void {
  const db = getWriteDb();
  db.prepare('DELETE FROM _qc_dashboards WHERE id = ?').run(id);
}

export function tableExists(tableName: string): boolean {
  const db = getWriteDb();
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

export function savePdfDocument(entry: {
  filename: string;
  pageCount: number;
  extractedText: string;
}): PdfDocSummary {
  const db = getWriteDb();
  const preview = entry.extractedText.replace(/\s+/g, ' ').trim().slice(0, 180);
  const res = db
    .prepare(
      `INSERT INTO _qc_pdf_docs (filename, page_count, char_count, preview, extracted_text)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      entry.filename,
      entry.pageCount,
      entry.extractedText.length,
      preview,
      entry.extractedText
    );
  return db
    .prepare(
      `SELECT id, filename, page_count, char_count, preview, created_at FROM _qc_pdf_docs WHERE id = ?`
    )
    .get(Number(res.lastInsertRowid)) as unknown as PdfDocSummary;
}

export function listPdfDocuments(): PdfDocSummary[] {
  const db = getWriteDb();
  return db
    .prepare(
      `SELECT id, filename, page_count, char_count, preview, created_at
       FROM _qc_pdf_docs
       ORDER BY id DESC`
    )
    .all() as unknown as PdfDocSummary[];
}

export function getAllPdfDocumentsFull(): PdfDocFull[] {
  const db = getWriteDb();
  return db
    .prepare(
      `SELECT id, filename, page_count, char_count, preview, extracted_text, created_at
       FROM _qc_pdf_docs
       ORDER BY id DESC`
    )
    .all() as unknown as PdfDocFull[];
}

export function deletePdfDocument(id: number): void {
  const db = getWriteDb();
  db.prepare('DELETE FROM _qc_pdf_docs WHERE id = ?').run(id);
}

export async function initAndSeedDatabaseAsync(): Promise<void> {
  initAndSeedDatabase();
  if (isPostgresEnabled()) {
    await initPostgresDatabase();
  }
}

export function initAndSeedDatabase(): void {
  const db = getWriteDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS _qc_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      sql_query TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      retries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS _qc_dashboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      question TEXT NOT NULL,
      sql_query TEXT NOT NULL,
      chart_type TEXT NOT NULL,
      x_axis TEXT,
      y_axis TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS _qc_pdf_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      char_count INTEGER NOT NULL,
      preview TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      city TEXT NOT NULL,
      segment TEXT NOT NULL,
      signup_date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL,
      cost_price REAL NOT NULL,
      stock_qty INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      order_date TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      total_amount REAL NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      line_total REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );
  `);

  const existing = db.prepare('SELECT COUNT(*) as cnt FROM users;').get() as { cnt: number };
  if (existing.cnt > 0) return;

  const cities = ['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Hyderabad', 'Chennai'];
  const segments = ['Enterprise', 'Pro', 'Standard'];
  const firstNames = ['Aarav', 'Diya', 'Rohan', 'Meera', 'Kabir', 'Ananya', 'Vikram', 'Neha', 'Arjun', 'Priya'];
  const lastNames = ['Sharma', 'Patel', 'Nair', 'Verma', 'Iyer', 'Reddy', 'Mehta', 'Kapoor'];

  const insertUser = db.prepare(
    'INSERT INTO users (id, name, email, city, segment, signup_date) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (let i = 1; i <= 40; i++) {
    const fn = firstNames[i % firstNames.length];
    const ln = lastNames[(i * 3) % lastNames.length];
    const month = String(((i - 1) % 9) + 1).padStart(2, '0');
    const day = String(((i * 7) % 27) + 1).padStart(2, '0');
    insertUser.run(
      i,
      `${fn} ${ln}`,
      `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@example.com`,
      cities[i % cities.length],
      segments[i % segments.length],
      `2026-${month}-${day}`
    );
  }

  const catalog: [string, string, number, number, number][] = [
    ['Noise-Canceling Headphones', 'Electronics', 249, 130, 42],
    ['Mechanical Keyboard Pro', 'Electronics', 149, 75, 65],
    ['4K USB-C Monitor', 'Electronics', 429, 260, 18],
    ['Ergonomic Mesh Chair', 'Home & Office', 319, 175, 24],
    ['Standing Desk Converter', 'Home & Office', 219, 115, 31],
    ['Smart Desk Lamp', 'Home & Office', 69, 32, 95],
    ['Merino Travel Hoodie', 'Apparel', 119, 48, 80],
    ['Everyday Tech Backpack', 'Apparel', 139, 60, 54],
    ['Carbon Running Shoes', 'Fitness', 179, 82, 37],
    ['Smart Fitness Band', 'Fitness', 99, 45, 72],
    ['Insulated Steel Bottle', 'Fitness', 39, 14, 150],
    ['Wireless Studio Mic', 'Electronics', 189, 95, 29],
  ];

  const insertProduct = db.prepare(
    'INSERT INTO products (id, name, category, unit_price, cost_price, stock_qty) VALUES (?, ?, ?, ?, ?, ?)'
  );
  catalog.forEach((p, idx) => {
    insertProduct.run(idx + 1, p[0], p[1], p[2], p[3], p[4]);
  });

  const paymentMethods = ['UPI', 'Card', 'NetBanking'];
  const insertOrder = db.prepare(
    'INSERT INTO orders (id, user_id, order_date, status, payment_method, total_amount) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertItem = db.prepare(
    'INSERT INTO order_items (id, order_id, product_id, quantity, line_total) VALUES (?, ?, ?, ?, ?)'
  );

  let itemId = 1;
  const pick = (seed: number, mod: number) => ((seed * 9301 + 49297) % 233280) % mod;

  for (let orderId = 1; orderId <= 180; orderId++) {
    const userId = (pick(orderId, 40) % 40) + 1;
    const monthNum = ((orderId - 1) % 10) + 1;
    const dayNum = ((orderId * 5) % 27) + 1;
    const orderDate = `2026-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
    const statusRoll = orderId % 15;
    const status = statusRoll === 0 ? 'returned' : statusRoll === 7 ? 'pending' : 'completed';
    const paymentMethod = paymentMethods[pick(orderId + 3, paymentMethods.length)];

    const itemsInOrder = (orderId % 2) + 1;
    let totalAmount = 0;

    insertOrder.run(orderId, userId, orderDate, status, paymentMethod, 0);

    for (let k = 0; k < itemsInOrder; k++) {
      const productIdx = (orderId + k * 5) % catalog.length;
      const productId = productIdx + 1;
      const qty = ((orderId + k) % 3) + 1;
      const lineTotal = catalog[productIdx][2] * qty;
      totalAmount += lineTotal;
      insertItem.run(itemId++, orderId, productId, qty, lineTotal);
    }

    db.prepare('UPDATE orders SET total_amount = ? WHERE id = ?').run(totalAmount, orderId);
  }
}
