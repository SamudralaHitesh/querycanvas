import { getAllPdfDocumentsFull, listUserTablesAsync } from '../db/database.js';
import { isQuestionInScope, runNlToSqlPipeline } from './queryEngine.js';
import { validateAndSanitizeSql } from './sqlGuard.js';

export interface AccuracyEvalCaseResult {
  question: string;
  passed: boolean;
  rowCount: number;
  latencyMs: number;
  retries: number;
  error?: string;
}

export interface SecurityEvalCaseResult {
  name: string;
  sql: string;
  passed: boolean;
  reason?: string;
}

export interface EvalSuiteReport {
  executionAccuracy: number;
  passedAccuracy: number;
  totalAccuracy: number;
  securityPassRate: number;
  passedSecurity: number;
  totalSecurity: number;
  avgLatencyMs: number;
  accuracyCases: AccuracyEvalCaseResult[];
  securityCases: SecurityEvalCaseResult[];
}

const GOLDEN_QUESTIONS = [
  { q: 'Show monthly revenue trend', expectedMinRows: 5 },
  { q: 'Compare revenue by product category', expectedMinRows: 3 },
  { q: 'Show revenue by city', expectedMinRows: 4 },
  { q: 'Which payment method has the highest revenue?', expectedMinRows: 2 },
  { q: 'Top 5 customers by total spend', expectedMinRows: 5 },
  { q: 'Show returned orders by product', expectedMinRows: 1 },
  { q: 'List low stock products', expectedMinRows: 5 },
  { q: 'Top 5 products by revenue', expectedMinRows: 5 },
];

const SECURITY_CASES = [
  { name: 'Block DROP TABLE', sql: 'DROP TABLE users', expectSafe: false },
  {
    name: 'Block Stacked Injection',
    sql: 'SELECT * FROM users; DELETE FROM orders;',
    expectSafe: false,
  },
  {
    name: 'Block System Catalog Access',
    sql: 'SELECT name FROM sqlite_master',
    expectSafe: false,
  },
  {
    name: 'Cap Excessive LIMIT',
    sql: 'SELECT * FROM orders LIMIT 50000',
    expectSafe: true,
    expectedSuffix: 'LIMIT 1000',
  },
];

export async function runFullEvalSuite(): Promise<EvalSuiteReport> {
  const accuracyCases: AccuracyEvalCaseResult[] = [];
  let passedAccuracy = 0;
  const latencies: number[] = [];

  for (const item of GOLDEN_QUESTIONS) {
    try {
      const res = await runNlToSqlPipeline(item.q);
      latencies.push(res.metrics.totalLatencyMs);
      const passed = res.rows.length >= item.expectedMinRows;
      if (passed) passedAccuracy++;
      accuracyCases.push({
        question: item.q,
        passed,
        rowCount: res.rows.length,
        latencyMs: res.metrics.totalLatencyMs,
        retries: res.metrics.retries,
      });
    } catch (err) {
      accuracyCases.push({
        question: item.q,
        passed: false,
        rowCount: 0,
        latencyMs: 0,
        retries: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const securityCases: SecurityEvalCaseResult[] = SECURITY_CASES.map((sc) => {
    const res = validateAndSanitizeSql(sc.sql);
    const passed =
      res.safe === sc.expectSafe &&
      (!sc.expectedSuffix || res.sanitizedSql.endsWith(sc.expectedSuffix));
    return {
      name: sc.name,
      sql: sc.sql,
      passed,
      reason: res.reason || res.sanitizedSql,
    };
  });

  const passedSqlSecurity = securityCases.filter((s) => s.passed).length;
  const tables = await listUserTablesAsync();
  const pdfs = getAllPdfDocumentsFull();
  const offTopicBlocked = !isQuestionInScope(
    'Who is the Prime Minister of India?',
    tables,
    pdfs
  );
  securityCases.push({
    name: 'Out-of-Scope Domain Guardrail',
    sql: 'Question: "Who is the Prime Minister of India?"',
    passed: offTopicBlocked,
    reason: offTopicBlocked ? 'Blocked off-topic trivia question' : 'Allowed off-topic query',
  });

  const passedSecurity = passedSqlSecurity + (offTopicBlocked ? 1 : 0);
  const totalSecurity = SECURITY_CASES.length + 1;
  const avgLatencyMs =
    latencies.length > 0
      ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 100) / 100
      : 0;

  return {
    executionAccuracy: Math.round((passedAccuracy / GOLDEN_QUESTIONS.length) * 100),
    passedAccuracy,
    totalAccuracy: GOLDEN_QUESTIONS.length,
    securityPassRate: Math.round((passedSecurity / totalSecurity) * 100),
    passedSecurity,
    totalSecurity,
    avgLatencyMs,
    accuracyCases,
    securityCases,
  };
}
