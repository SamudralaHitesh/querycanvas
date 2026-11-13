import { TableSchema } from '../db/database.js';
import { formatSchemaForPrompt } from './schemaRag.js';

export type ChartType = 'bar' | 'line' | 'pie' | 'kpi' | 'table';

export interface GeneratedSqlPlan {
  sql: string;
  explanation: string;
  chartType: ChartType;
  xAxis: string | null;
  yAxis: string | null;
  followUps: string[];
  providerUsed: string;
}

function getProvider(): 'gemini' | 'openai' | 'ollama' | 'demo' {
  const configured = (process.env.AI_PROVIDER || '').toLowerCase();
  if (configured === 'gemini' && process.env.GEMINI_API_KEY) return 'gemini';
  if (configured === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (configured === 'ollama') return 'ollama';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'demo';
}

export function getActiveProviderInfo() {
  const provider = getProvider();
  return {
    provider,
    model:
      provider === 'gemini'
        ? process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'
        : provider === 'openai'
          ? process.env.OPENAI_MODEL || 'gpt-4o-mini'
          : provider === 'ollama'
            ? process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'
            : 'local-demo-engine',
  };
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model response did not contain a valid JSON object.');
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
}

async function callLlmJson(systemPrompt: string, userPrompt: string): Promise<Record<string, unknown>> {
  const provider = getProvider();

  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY!;
    const primary = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
    const candidates = Array.from(new Set([primary, 'gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-flash-latest']));

    let lastErr = '';
    for (const model of candidates) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
          return extractJsonObject(text);
        }
        lastErr = `Gemini API error (${res.status}) on ${model}: ${await res.text()}`;
        if (![404, 429, 500, 503].includes(res.status)) {
          throw new Error(lastErr);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timeout|aborted|fetch failed|ECONNREFUSED|ENOTFOUND|503|429|UNAVAILABLE/i.test(msg)) {
          lastErr = `503 ${msg}`;
          continue;
        }
        throw err;
      }
    }
    throw new Error(lastErr);
  }

  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY!;
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI API error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content || '';
    return extractJsonObject(text);
  }

  if (provider === 'ollama') {
    const baseUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`Ollama API error (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { message?: { content?: string } };
    return extractJsonObject(data.message?.content || '');
  }

  throw new Error('No live LLM provider configured.');
}

function buildDemoSqlPlan(question: string, tables: TableSchema[]): GeneratedSqlPlan {
  const q = question.toLowerCase();

  // Check if user uploaded a custom CSV table and is asking about its name or unique columns
  const coreColNames = new Set(
    tables
      .filter((t) => ['users', 'products', 'orders', 'order_items'].includes(t.name))
      .flatMap((t) => t.columns.map((c) => c.name.toLowerCase()))
  );
  const customTables = tables.filter(
    (t) => !['users', 'products', 'orders', 'order_items'].includes(t.name)
  );
  let targetCustom: TableSchema | undefined;
  let bestScore = 0;

  const isCoreEcommerceQuestion =
    /\b(payment|upi|card|netbanking|city|cities|customer|customers|user|users|segment|order|orders|return|returned|refund|stock|inventory|product|products|monthly revenue trend)\b/i.test(
      q
    );

  for (const t of customTables) {
    let score = 0;
    const tName = t.name.toLowerCase();
    const mentionsTableName = q.includes(tName);
    if (mentionsTableName) score += 10;
    const hasMatchingCol = t.columns.some((col) => q.includes(col.name.toLowerCase()));
    if (isCoreEcommerceQuestion && !mentionsTableName && !hasMatchingCol) continue;
    for (const part of tName.split('_')) {
      if (part.length > 3 && !['data', 'table', 'sample'].includes(part) && q.includes(part)) {
        score += 3;
      }
    }
    for (const col of t.columns) {
      const cName = col.name.toLowerCase();
      const isUniqueToCustom = !coreColNames.has(cName);
      if (isUniqueToCustom && q.includes(cName)) {
        score += 5;
      } else if (q.includes(cName)) {
        score += 3;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      targetCustom = t;
    }
  }

  if (targetCustom) {
    const numericCols = targetCustom.columns.filter(
      (c) => /INT|REAL|FLOAT|NUM/i.test(c.type) && !/id$/i.test(c.name)
    );
    const textCols = targetCustom.columns.filter((c) => /TEXT|CHAR/i.test(c.type));

    const numCol =
      numericCols.find((c) => q.includes(c.name.toLowerCase())) ||
      (q.includes('sales')
        ? numericCols.find((c) => /revenue|sales|amount/i.test(c.name))
        : undefined) ||
      numericCols[0];

    const catCol =
      textCols.find((c) => q.includes(c.name.toLowerCase())) || textCols[0];

    const wantsTopN = /\b(highest|max|maximum|most|top|greatest|lowest|min|minimum|least|best|worst)\b/i.test(q);
    const isDesc = !/\b(lowest|min|minimum|least|worst)\b/i.test(q);

    if (numCol && wantsTopN) {
      const idOrLabelCol = targetCustom.columns.find((c) => /id$|name$|code$/i.test(c.name)) || catCol;
      const displayCols = Array.from(new Set([idOrLabelCol.name, numCol.name, catCol?.name].filter(Boolean)));
      return {
        sql: `SELECT ${displayCols.map((c) => `"${c}"`).join(', ')} FROM "${targetCustom.name}" ORDER BY "${numCol.name}" ${isDesc ? 'DESC' : 'ASC'} LIMIT 10`,
        explanation: `Finds records from ${targetCustom.name} with the ${isDesc ? 'highest' : 'lowest'} ${numCol.name}.`,
        chartType: 'bar',
        xAxis: idOrLabelCol.name,
        yAxis: numCol.name,
        followUps: [
          `Show summary from ${targetCustom.name}`,
          `Compare ${numCol.name} by ${catCol?.name || idOrLabelCol.name} in ${targetCustom.name}`,
        ],
        providerUsed: 'demo-engine',
      };
    }

    const wantsAggregation =
      /\b(by|wise|per|top|sum|avg|average|total|compare|breakdown|trend|monthly)\b/i.test(q) ||
      (Boolean(numCol) && Boolean(catCol) && q.includes(catCol.name.toLowerCase()));

    if (numCol && catCol && wantsAggregation) {
      const isTime = /month|date|year|week/i.test(catCol.name);
      const orderClause = isTime
        ? `ORDER BY "${catCol.name}" ASC`
        : `ORDER BY total_${numCol.name} DESC`;
      return {
        sql: `SELECT "${catCol.name}" AS "${catCol.name}", ROUND(SUM("${numCol.name}"), 2) AS total_${numCol.name}, COUNT(*) AS records FROM "${targetCustom.name}" GROUP BY "${catCol.name}" ${orderClause} LIMIT 12`,
        explanation: `Aggregates ${numCol.name} grouped by ${catCol.name} from your uploaded ${targetCustom.name} dataset.`,
        chartType: isTime ? 'line' : 'bar',
        xAxis: catCol.name,
        yAxis: `total_${numCol.name}`,
        followUps: [
          `Show top 5 rows in ${targetCustom.name}`,
          ...numericCols
            .filter((c) => c.name !== numCol.name)
            .slice(0, 1)
            .map((c) => `${catCol.name} wise ${c.name} in ${targetCustom.name}`),
        ],
        providerUsed: 'demo-engine',
      };
    }

    return {
      sql: `SELECT * FROM "${targetCustom.name}" LIMIT 50`,
      explanation: `Displays the first 50 rows from your uploaded ${targetCustom.name} table.`,
      chartType: 'table',
      xAxis: null,
      yAxis: null,
      followUps: catCol
        ? [`Summarize ${targetCustom.name} by ${catCol.name}`]
        : [`Show total row count in ${targetCustom.name}`],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('month') || q.includes('trend') || q.includes('over time')) {
    return {
      sql: `SELECT substr(order_date, 1, 7) AS month, ROUND(SUM(total_amount), 2) AS revenue, COUNT(*) AS orders FROM orders WHERE status = 'completed' GROUP BY month ORDER BY month ASC`,
      explanation: 'Calculates monthly completed order revenue and order volume chronologically.',
      chartType: 'line',
      xAxis: 'month',
      yAxis: 'revenue',
      followUps: [
        'Compare revenue by product category',
        'Show revenue by city',
        'Which payment method has the highest revenue?',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('category') || q.includes('categories')) {
    return {
      sql: `SELECT p.category, ROUND(SUM(oi.line_total), 2) AS revenue, SUM(oi.quantity) AS units_sold FROM order_items oi JOIN products p ON oi.product_id = p.id JOIN orders o ON oi.order_id = o.id WHERE o.status = 'completed' GROUP BY p.category ORDER BY revenue DESC`,
      explanation: 'Joins order items, products, and completed orders to calculate revenue and units sold per category.',
      chartType: 'bar',
      xAxis: 'category',
      yAxis: 'revenue',
      followUps: [
        'Show top 5 products by revenue',
        'Show monthly revenue trend',
        'What is the return rate by product?',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('city') || q.includes('cities') || q.includes('region')) {
    return {
      sql: `SELECT u.city, ROUND(SUM(o.total_amount), 2) AS revenue, COUNT(DISTINCT o.id) AS total_orders FROM orders o JOIN users u ON o.user_id = u.id WHERE o.status = 'completed' GROUP BY u.city ORDER BY revenue DESC`,
      explanation: 'Joins orders with users to aggregate completed sales revenue and order counts by city.',
      chartType: 'bar',
      xAxis: 'city',
      yAxis: 'revenue',
      followUps: [
        'Show revenue by customer segment',
        'Show monthly revenue trend',
        'Top 5 customers by total spend',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('payment') || q.includes('upi') || q.includes('card')) {
    return {
      sql: `SELECT payment_method, COUNT(*) AS order_count, ROUND(SUM(total_amount), 2) AS total_revenue FROM orders WHERE status = 'completed' GROUP BY payment_method ORDER BY total_revenue DESC`,
      explanation: 'Breaks down completed orders and revenue across UPI, Card, and NetBanking.',
      chartType: 'pie',
      xAxis: 'payment_method',
      yAxis: 'total_revenue',
      followUps: [
        'Show monthly revenue trend',
        'Show revenue by city',
        'Show failed or returned orders',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('return') || q.includes('refund')) {
    return {
      sql: `SELECT p.name AS product, COUNT(*) AS returned_orders, ROUND(SUM(oi.line_total), 2) AS returned_value FROM orders o JOIN order_items oi ON o.id = oi.order_id JOIN products p ON oi.product_id = p.id WHERE o.status = 'returned' GROUP BY p.id, p.name ORDER BY returned_value DESC`,
      explanation: 'Identifies products associated with returned orders ranked by total returned value.',
      chartType: 'bar',
      xAxis: 'product',
      yAxis: 'returned_value',
      followUps: [
        'Compare revenue by product category',
        'Show order count by status',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('customer') || q.includes('user') || q.includes('segment')) {
    return {
      sql: `SELECT u.name, u.city, u.segment, COUNT(o.id) AS orders_count, ROUND(SUM(o.total_amount), 2) AS lifetime_spend FROM users u JOIN orders o ON u.id = o.user_id WHERE o.status = 'completed' GROUP BY u.id, u.name, u.city, u.segment ORDER BY lifetime_spend DESC LIMIT 10`,
      explanation: 'Ranks the top 10 customers by total completed spend along with city and segment.',
      chartType: 'bar',
      xAxis: 'name',
      yAxis: 'lifetime_spend',
      followUps: [
        'Show revenue by city',
        'Show monthly revenue trend',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('stock') || q.includes('inventory') || q.includes('low')) {
    return {
      sql: `SELECT name AS product, category, stock_qty, unit_price FROM products ORDER BY stock_qty ASC LIMIT 10`,
      explanation: 'Lists products sorted from lowest to highest remaining inventory.',
      chartType: 'bar',
      xAxis: 'product',
      yAxis: 'stock_qty',
      followUps: [
        'Show top 5 products by revenue',
        'Compare revenue by product category',
      ],
      providerUsed: 'demo-engine',
    };
  }

  if (q.includes('quantity') || (q.includes('order') && /highest|most|top|max|largest/i.test(q))) {
    return {
      sql: `SELECT o.id AS order_id, o.order_date, SUM(oi.quantity) AS total_quantity, ROUND(SUM(oi.line_total), 2) AS total_amount FROM orders o JOIN order_items oi ON o.id = oi.order_id GROUP BY o.id, o.order_date ORDER BY total_quantity DESC LIMIT 8`,
      explanation: 'Finds completed orders with the highest total item quantity.',
      chartType: 'bar',
      xAxis: 'order_id',
      yAxis: 'total_quantity',
      followUps: [
        'Top 5 products by revenue',
        'Show monthly revenue trend',
      ],
      providerUsed: 'demo-engine',
    };
  }

  // Default: Top products by revenue
  return {
    sql: `SELECT p.name AS product, p.category, SUM(oi.quantity) AS units_sold, ROUND(SUM(oi.line_total), 2) AS revenue FROM order_items oi JOIN products p ON oi.product_id = p.id JOIN orders o ON oi.order_id = o.id WHERE o.status = 'completed' GROUP BY p.id, p.name, p.category ORDER BY revenue DESC LIMIT 8`,
    explanation: 'Ranks the top-performing products by completed sales revenue and units sold.',
    chartType: 'bar',
    xAxis: 'product',
    yAxis: 'revenue',
    followUps: [
      'Show monthly revenue trend',
      'Compare revenue by product category',
      'Show revenue by city',
    ],
    providerUsed: 'demo-engine',
  };
}

export async function generateSqlPlan(
  question: string,
  tables: TableSchema[]
): Promise<GeneratedSqlPlan> {
  const provider = getProvider();
  if (provider === 'demo') {
    return buildDemoSqlPlan(question, tables);
  }

  const schemaText = formatSchemaForPrompt(tables);
  const systemPrompt = `You are a senior SQL data analyst for SQLite.
Given the database schema and a user question, generate ONE safe, read-only SELECT query.
Rules:
1. Only output valid JSON matching this exact shape:
{
  "sql": "SELECT ...",
  "explanation": "1 concise sentence explaining what the query calculates.",
  "chartType": "bar" | "line" | "pie" | "kpi" | "table",
  "xAxis": "column_name_or_null",
  "yAxis": "numeric_column_name_or_null",
  "followUps": ["question 1", "question 2"]
}
2. Use ONLY SQLite-compatible syntax (e.g., substr(date_col, 1, 7) for YYYY-MM, ROUND(val, 2)).
3. Never use INSERT, UPDATE, DELETE, DROP, ALTER, or PRAGMA.
4. Always give aggregated columns clear aliases (e.g., AS revenue).
5. Ensure xAxis and yAxis match exact column names returned by your SELECT clause.`;

  const userPrompt = `DATABASE SCHEMA:\n${schemaText}\n\nUSER QUESTION: ${question}`;
  try {
    const raw = await callLlmJson(systemPrompt, userPrompt);
    return {
      sql: String(raw.sql || ''),
      explanation: String(raw.explanation || 'Generated SQL query from your question.'),
      chartType: (['bar', 'line', 'pie', 'kpi', 'table'].includes(String(raw.chartType))
        ? raw.chartType
        : 'table') as ChartType,
      xAxis: raw.xAxis ? String(raw.xAxis) : null,
      yAxis: raw.yAxis ? String(raw.yAxis) : null,
      followUps: Array.isArray(raw.followUps) ? raw.followUps.slice(0, 3).map(String) : [],
      providerUsed: provider,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/(503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|timeout|aborted)/i.test(msg)) {
      const fallback = buildDemoSqlPlan(question, tables);
      return {
        ...fallback,
        explanation: `${fallback.explanation} (Cloud LLM temporarily busy — served via local fallback engine.)`,
        providerUsed: `${provider}-fallback-demo`,
      };
    }
    throw err;
  }
}

export async function repairSqlPlan(
  question: string,
  failedSql: string,
  errorMessage: string,
  tables: TableSchema[]
): Promise<GeneratedSqlPlan> {
  const provider = getProvider();
  if (provider === 'demo') {
    return buildDemoSqlPlan(question, tables);
  }

  const schemaText = formatSchemaForPrompt(tables);
  const systemPrompt = `You are fixing a failed SQLite SELECT query.
Return valid JSON with keys: "sql", "explanation", "chartType", "xAxis", "yAxis", "followUps".
Only output read-only SQLite SELECT queries using exact column names from the schema.`;

  const userPrompt = `SCHEMA:\n${schemaText}\n\nQUESTION: ${question}\nFAILED SQL: ${failedSql}\nSQLITE ERROR: ${errorMessage}\n\nReturn the fixed query JSON.`;
  const raw = await callLlmJson(systemPrompt, userPrompt);

  return {
    sql: String(raw.sql || ''),
    explanation: String(raw.explanation || 'Repaired SQL query after execution error.'),
    chartType: (['bar', 'line', 'pie', 'kpi', 'table'].includes(String(raw.chartType))
      ? raw.chartType
      : 'table') as ChartType,
    xAxis: raw.xAxis ? String(raw.xAxis) : null,
    yAxis: raw.yAxis ? String(raw.yAxis) : null,
    followUps: Array.isArray(raw.followUps) ? raw.followUps.slice(0, 3).map(String) : [],
    providerUsed: provider,
  };
}

function summarizeRowsDeterministically(
  rows: Record<string, unknown>[],
  xAxis: string | null,
  yAxis: string | null
): string {
  if (rows.length === 1) {
    const summaryPairs = Object.entries(rows[0])
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    return `Single record returned — ${summaryPairs}.`;
  }
  const labelKey = xAxis && xAxis in rows[0] ? xAxis : Object.keys(rows[0])[0];
  const valueKey =
    yAxis && yAxis in rows[0]
      ? yAxis
      : Object.keys(rows[0]).find((k) => typeof rows[0][k] === 'number');

  if (valueKey) {
    const sorted = [...rows].sort(
      (a, b) => Number(b[valueKey] ?? 0) - Number(a[valueKey] ?? 0)
    );
    const top = sorted[0];
    const total = rows.reduce((acc, r) => acc + Number(r[valueKey] ?? 0), 0);
    return `Returned ${rows.length} rows. Top performer is "${top[labelKey]}" with ${valueKey} = ${Number(top[valueKey]).toLocaleString()} (aggregate ${valueKey} across results: ${Math.round(total).toLocaleString()}).`;
  }
  return `Returned ${rows.length} matching records across ${Object.keys(rows[0]).length} columns.`;
}

export async function generateGroundedInsight(
  question: string,
  rows: Record<string, unknown>[],
  xAxis: string | null,
  yAxis: string | null
): Promise<string> {
  if (rows.length === 0) {
    return 'No matching rows were returned for this query.';
  }

  const provider = getProvider();
  if (provider === 'demo') {
    return summarizeRowsDeterministically(rows, xAxis, yAxis);
  }

  try {
    const preview = rows.slice(0, 12);
    const raw = await callLlmJson(
      `You are a data analyst summarizing real SQL query results.
Return JSON: { "insight": "1-2 crisp sentences citing exact numbers from the rows." }.
Never invent numbers not present in the rows.`,
      `Question: ${question}\nReturned Rows (${rows.length} total, showing top ${preview.length}):\n${JSON.stringify(preview)}`
    );
    return String(raw.insight || summarizeRowsDeterministically(rows, xAxis, yAxis));
  } catch {
    return summarizeRowsDeterministically(rows, xAxis, yAxis);
  }
}
