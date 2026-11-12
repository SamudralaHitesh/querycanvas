export type ChartType = 'bar' | 'line' | 'pie' | 'kpi' | 'table';

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

export interface PdfDocSummary {
  id: number;
  filename: string;
  page_count: number;
  char_count: number;
  preview: string;
  created_at: string;
}

export interface PipelineStep {
  stage: string;
  message: string;
}

export interface QueryResult {
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

export interface HistoryItem {
  id: number;
  question: string;
  sql_query: string;
  chart_type: string;
  row_count: number;
  latency_ms: number;
  cache_hit: number;
  retries: number;
  created_at: string;
}

export interface DashboardCard {
  id: number;
  title: string;
  question: string;
  sql_query: string;
  chart_type: ChartType;
  x_axis: string | null;
  y_axis: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs?: number;
  error?: string;
}

export interface EvalSuiteReport {
  executionAccuracy: number;
  passedAccuracy: number;
  totalAccuracy: number;
  securityPassRate: number;
  passedSecurity: number;
  totalSecurity: number;
  avgLatencyMs: number;
  accuracyCases: Array<{
    question: string;
    passed: boolean;
    rowCount: number;
    latencyMs: number;
    retries: number;
    error?: string;
  }>;
  securityCases: Array<{
    name: string;
    sql: string;
    passed: boolean;
    reason?: string;
  }>;
}
