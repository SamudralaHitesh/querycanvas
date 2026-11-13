import {
  executeReadOnlyQueryAsync,
  getAllPdfDocumentsFull,
  listUserTablesAsync,
  PdfDocFull,
  saveQueryHistory,
  TableSchema,
} from '../db/database.js';
import { getCachedQuery, setCachedQuery } from './cache.js';
import {
  ChartType,
  GeneratedSqlPlan,
  generateGroundedInsight,
  generateSqlPlan,
  repairSqlPlan,
} from './llm.js';
import { findRelevantPdfExcerpts, summarizePdfAnswer } from './pdfRag.js';
import { retrieveRelevantTablesAsync } from './schemaRag.js';
import { validateAndSanitizeSql } from './sqlGuard.js';

export interface PipelineStepEvent {
  stage:
    | 'guardrail'
    | 'cache'
    | 'schema_rag'
    | 'pdf_rag'
    | 'sql_gen'
    | 'sql_guard'
    | 'execute'
    | 'self_heal'
    | 'insight'
    | 'done'
    | 'error';
  message: string;
}

export interface QueryExecutionResponse {
  question: string;
  sql: string;
  explanation: string;
  insight: string;
  chartType: ChartType;
  xAxis: string | null;
  yAxis: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  followUps: string[];
  metrics: {
    totalLatencyMs: number;
    dbExecutionMs: number;
    cacheHit: boolean;
    retries: number;
    tablesRetrieved: string[];
    provider: string;
  };
}

const DOMAIN_KEYWORDS = new Set([
  'revenue',
  'sales',
  'profit',
  'order',
  'orders',
  'customer',
  'customers',
  'user',
  'users',
  'product',
  'products',
  'category',
  'categories',
  'city',
  'cities',
  'region',
  'payment',
  'upi',
  'card',
  'netbanking',
  'month',
  'monthly',
  'trend',
  'stock',
  'inventory',
  'return',
  'returned',
  'refund',
  'segment',
  'count',
  'total',
  'sum',
  'average',
  'avg',
  'top',
  'highest',
  'lowest',
  'compare',
  'breakdown',
  'summarize',
  'summary',
  'rows',
  'table',
  'tables',
  'data',
  'dataset',
  'csv',
  'excel',
  'pdf',
  'report',
  'document',
  'wise',
  'spend',
  'budget',
  'mrr',
  'churn',
  'headcount',
  'department',
  'country',
  'plan',
  'quarter',
  'sql',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

export function isQuestionInScope(
  question: string,
  tables: TableSchema[],
  pdfs: PdfDocFull[]
): boolean {
  const tokens = tokenize(question);
  if (tokens.length === 0) return false;

  const schemaTokens = new Set<string>();
  for (const t of tables) {
    schemaTokens.add(t.name.toLowerCase());
    t.name.toLowerCase().split('_').forEach((p) => schemaTokens.add(p));
    for (const c of t.columns) {
      schemaTokens.add(c.name.toLowerCase());
      c.name.toLowerCase().split('_').forEach((p) => schemaTokens.add(p));
    }
  }

  for (const tok of tokens) {
    if (DOMAIN_KEYWORDS.has(tok) || schemaTokens.has(tok)) {
      return true;
    }
  }

  // Also check if question matches uploaded PDF filenames or content tokens (>3 chars)
  const pdfExcerpts = pdfs.length > 0 ? findRelevantPdfExcerpts(question, pdfs, 1) : [];
  if (pdfExcerpts.length > 0 && pdfExcerpts[0].score >= 2) {
    return true;
  }

  return false;
}

function shouldRouteToPdf(
  question: string,
  tables: TableSchema[],
  pdfs: PdfDocFull[]
): boolean {
  if (pdfs.length === 0) return false;
  const qLower = question.toLowerCase();

  if (/\b(pdf|document|doc|report)\b/i.test(qLower)) return true;
  for (const doc of pdfs) {
    const base = doc.filename.toLowerCase().replace(/\.pdf$/i, '');
    if (base.length > 2 && qLower.includes(base)) return true;
  }

  // If no SQL table/column explicitly matched, check if PDF content matches strongly
  const qTokens = tokenize(question);
  const schemaHits = tables.some(
    (t) =>
      qLower.includes(t.name.toLowerCase()) ||
      t.columns.some((c) => qTokens.includes(c.name.toLowerCase()))
  );
  if (!schemaHits) {
    const excerpts = findRelevantPdfExcerpts(question, pdfs, 1);
    if (excerpts.length > 0 && excerpts[0].score >= 4) {
      return true;
    }
  }
  return false;
}

export async function runNlToSqlPipeline(
  question: string,
  onStep?: (event: PipelineStepEvent) => void,
  options?: { bypassCache?: boolean }
): Promise<QueryExecutionResponse> {
  const totalStart = performance.now();
  const allTables = await listUserTablesAsync();
  const allPdfs = getAllPdfDocumentsFull();

  onStep?.({ stage: 'guardrail', message: 'Checking domain scope guardrail...' });
  if (!isQuestionInScope(question, allTables, allPdfs)) {
    throw new Error(
      'Out-of-scope: Please ask a question about your database tables, uploaded CSV/Excel datasets, or uploaded PDF documents.'
    );
  }

  // Route to PDF Document Q&A when appropriate
  if (shouldRouteToPdf(question, allTables, allPdfs)) {
    onStep?.({ stage: 'pdf_rag', message: 'Searching uploaded PDF documents...' });
    const excerpts = findRelevantPdfExcerpts(question, allPdfs, 5);
    const insight = await summarizePdfAnswer(question, excerpts);
    const totalLatencyMs = Math.round((performance.now() - totalStart) * 100) / 100;

    const rows = excerpts.map((e) => ({
      filename: e.filename,
      pages: e.page_count,
      relevance: e.score,
      excerpt: e.excerpt,
    }));

    return {
      question,
      sql: '-- Answered from uploaded PDF documents (_qc_pdf_docs)',
      explanation: `Retrieved ${excerpts.length} relevant excerpt(s) across ${allPdfs.length} saved PDF document(s).`,
      insight,
      chartType: 'table',
      xAxis: null,
      yAxis: null,
      columns: rows.length > 0 ? Object.keys(rows[0]) : ['filename', 'excerpt'],
      rows,
      followUps: allPdfs.slice(0, 2).map((p) => `Summarize ${p.filename}`),
      metrics: {
        totalLatencyMs,
        dbExecutionMs: 0,
        cacheHit: false,
        retries: 0,
        tablesRetrieved: allPdfs.map((p) => p.filename),
        provider: 'pdf-rag',
      },
    };
  }

  onStep?.({ stage: 'schema_rag', message: 'Indexing & matching relevant tables...' });
  const { selected, schemaVersion } = await retrieveRelevantTablesAsync(question, 6);
  const tablesRetrieved = selected.map((t) => t.name);

  onStep?.({ stage: 'cache', message: 'Checking semantic query cache...' });
  const cached = options?.bypassCache ? null : await getCachedQuery(question, schemaVersion);

  let plan: GeneratedSqlPlan;
  let cacheHit = false;

  if (cached) {
    cacheHit = true;
    plan = { ...cached, providerUsed: 'query-cache' };
    onStep?.({ stage: 'cache', message: 'Cache hit! Skipping LLM generation.' });
  } else {
    onStep?.({
      stage: 'sql_gen',
      message: `Generating SQL using ${tablesRetrieved.join(', ')}...`,
    });
    plan = await generateSqlPlan(question, selected);
  }

  let retries = 0;
  const maxRetries = 2;
  let finalSql = '';
  let execResult: { columns: string[]; rows: Record<string, unknown>[]; executionMs: number } | null = null;
  let lastError = '';

  while (retries <= maxRetries) {
    onStep?.({ stage: 'sql_guard', message: 'Validating SQL AST (read-only firewall)...' });
    const guard = validateAndSanitizeSql(plan.sql);

    if (!guard.safe) {
      lastError = guard.reason || 'Unsafe SQL rejected.';
      if (retries < maxRetries && !cacheHit) {
        retries++;
        onStep?.({
          stage: 'self_heal',
          message: `Self-healing retry ${retries}/${maxRetries}: fixing SQL validation issue...`,
        });
        plan = await repairSqlPlan(question, plan.sql, lastError, selected);
        continue;
      }
      throw new Error(lastError);
    }

    finalSql = guard.sanitizedSql;
    onStep?.({ stage: 'execute', message: 'Executing read-only SQL query...' });

    try {
      execResult = await executeReadOnlyQueryAsync(finalSql);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'Database execution failed';
      if (retries < maxRetries && !cacheHit) {
        retries++;
        onStep?.({
          stage: 'self_heal',
          message: `Self-healing retry ${retries}/${maxRetries}: ${lastError}`,
        });
        plan = await repairSqlPlan(question, finalSql, lastError, selected);
        continue;
      }
      throw new Error(lastError);
    }
  }

  if (!execResult) {
    throw new Error(lastError || 'Query execution failed.');
  }

  const isFallbackOrDemo =
    plan.providerUsed.includes('fallback') ||
    plan.providerUsed.includes('demo') ||
    plan.explanation.includes('Cloud LLM temporarily busy');

  if (!cacheHit && !isFallbackOrDemo) {
    await setCachedQuery(question, schemaVersion, {
      sql: finalSql,
      explanation: plan.explanation,
      chartType: plan.chartType,
      xAxis: plan.xAxis,
      yAxis: plan.yAxis,
      followUps: plan.followUps,
    });
  }

  onStep?.({ stage: 'insight', message: 'Summarizing verified results...' });
  const insight = await generateGroundedInsight(
    question,
    execResult.rows,
    plan.xAxis,
    plan.yAxis
  );

  const totalLatencyMs = Math.round((performance.now() - totalStart) * 100) / 100;

  saveQueryHistory({
    question,
    sql: finalSql,
    chartType: plan.chartType,
    rowCount: execResult.rows.length,
    latencyMs: totalLatencyMs,
    cacheHit,
    retries,
  });

  return {
    question,
    sql: finalSql,
    explanation: plan.explanation,
    insight,
    chartType: plan.chartType,
    xAxis: plan.xAxis,
    yAxis: plan.yAxis,
    columns: execResult.columns,
    rows: execResult.rows,
    followUps: plan.followUps,
    metrics: {
      totalLatencyMs,
      dbExecutionMs: execResult.executionMs,
      cacheHit,
      retries,
      tablesRetrieved,
      provider: plan.providerUsed,
    },
  };
}
