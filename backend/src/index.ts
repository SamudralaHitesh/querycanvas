import 'dotenv/config';
import cors from 'cors';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import {
  deletePdfDocument,
  deletePinnedChart,
  executeReadOnlyQueryAsync,
  getDbEngineInfo,
  getKpiSummary,
  getQueryHistory,
  getTableProfile,
  initAndSeedDatabaseAsync,
  listPdfDocuments,
  listPinnedCharts,
  listUserTablesAsync,
  savePinnedChart,
} from './db/database.js';
import { clearQueryCache, getCacheStats, initCache } from './services/cache.js';
import {
  deleteCustomTable,
  ingestDatasetBuffer,
  ingestPdfBuffer,
} from './services/csvIngest.js';
import { runFullEvalSuite } from './services/evalRunner.js';
import { suggestInsightQuestions } from './services/insightSuggester.js';
import { getActiveProviderInfo } from './services/llm.js';
import { runNlToSqlPipeline } from './services/queryEngine.js';
import { validateAndSanitizeSql } from './services/sqlGuard.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    ai: getActiveProviderInfo(),
    db: getDbEngineInfo(),
    cache: getCacheStats(),
  });
});

app.get('/api/schema', async (req: Request, res: Response) => {
  try {
    const tableParam = typeof req.query.table === 'string' ? req.query.table : undefined;
    res.json({
      tables: await listUserTablesAsync(),
      pdfs: listPdfDocuments(),
      kpis: getKpiSummary(tableParam),
      ai: getActiveProviderInfo(),
      db: getDbEngineInfo(),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to list schema.',
    });
  }
});

app.get('/api/kpis', (req: Request, res: Response) => {
  try {
    const tableParam = typeof req.query.table === 'string' ? req.query.table : undefined;
    res.json({ kpis: getKpiSummary(tableParam) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to fetch KPIs.',
    });
  }
});

app.get('/api/datasets/:tableName/profile', (req: Request, res: Response) => {
  try {
    const profile = getTableProfile(String(req.params.tableName));
    res.json({ profile });
  } catch (err) {
    res.status(404).json({
      error: err instanceof Error ? err.message : 'Table not found.',
    });
  }
});

app.get('/api/history', (_req: Request, res: Response) => {
  res.json({
    history: getQueryHistory(25),
    cache: getCacheStats(),
  });
});

app.post('/api/cache/clear', async (_req: Request, res: Response) => {
  try {
    await clearQueryCache();
    res.json({ ok: true, message: 'Query cache cleared successfully.' });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to clear cache.' });
  }
});

app.post('/api/query/stream', async (req: Request, res: Response) => {
  const question = String(req.body?.question || '').trim();
  const bypassCache = Boolean(req.body?.bypassCache);
  if (!question) {
    res.status(400).json({ error: 'Question is required.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runNlToSqlPipeline(
      question,
      (step) => {
        sendEvent('step', step);
      },
      { bypassCache }
    );
    sendEvent('result', result);
    sendEvent('done', { ok: true });
  } catch (err) {
    sendEvent('error', {
      message: err instanceof Error ? err.message : 'Query pipeline failed.',
    });
  } finally {
    res.end();
  }
});

app.post('/api/query/run-sql', async (req: Request, res: Response) => {
  const rawSql = String(req.body?.sql || '').trim();
  const guard = validateAndSanitizeSql(rawSql);
  if (!guard.safe) {
    res.status(400).json({ error: guard.reason });
    return;
  }

  try {
    const execResult = await executeReadOnlyQueryAsync(guard.sanitizedSql);
    res.json({
      sql: guard.sanitizedSql,
      columns: execResult.columns,
      rows: execResult.rows,
      dbExecutionMs: execResult.executionMs,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'SQL execution failed.',
    });
  }
});

app.post('/api/datasets/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'CSV, Excel (.xlsx), or PDF file is required.' });
    return;
  }
  try {
    if (/\.pdf$/i.test(req.file.originalname)) {
      const pdfResult = await ingestPdfBuffer(req.file.buffer, req.file.originalname);
      await clearQueryCache();
      res.json({
        kind: 'pdf',
        pdf: pdfResult.pdf,
        dataset: pdfResult.extractedTable || null,
        tables: await listUserTablesAsync(),
        pdfs: listPdfDocuments(),
      });
      return;
    }

    const ingested = await ingestDatasetBuffer(req.file.buffer, req.file.originalname);
    await clearQueryCache();
    res.json({
      kind: 'table',
      dataset: ingested,
      tables: await listUserTablesAsync(),
      pdfs: listPdfDocuments(),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Failed to parse uploaded file.',
    });
  }
});

app.delete('/api/datasets/:tableName', async (req: Request, res: Response) => {
  try {
    await deleteCustomTable(String(req.params.tableName));
    await clearQueryCache();
    res.json({ tables: await listUserTablesAsync() });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not delete table.',
    });
  }
});

app.delete('/api/pdfs/:id', async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid PDF id.' });
    return;
  }
  deletePdfDocument(id);
  await clearQueryCache();
  res.json({ pdfs: listPdfDocuments() });
});

app.get('/api/dashboard', async (_req: Request, res: Response) => {
  try {
    const pinned = listPinnedCharts();
    const cards = await Promise.all(
      pinned.map(async (item) => {
        try {
          const guard = validateAndSanitizeSql(item.sql_query);
          if (!guard.safe) {
            return { ...item, columns: [], rows: [], error: guard.reason };
          }
          const execRes = await executeReadOnlyQueryAsync(guard.sanitizedSql);
          return {
            ...item,
            columns: execRes.columns,
            rows: execRes.rows,
            executionMs: execRes.executionMs,
          };
        } catch (err) {
          return {
            ...item,
            columns: [],
            rows: [],
            error: err instanceof Error ? err.message : 'Execution error',
          };
        }
      })
    );
    res.json({ cards });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to load dashboard.',
    });
  }
});

app.post('/api/dashboard', (req: Request, res: Response) => {
  const title = String(req.body?.title || req.body?.question || 'Saved Chart').trim();
  const question = String(req.body?.question || title).trim();
  const rawSql = String(req.body?.sql || '').trim();
  const chartType = String(req.body?.chartType || 'bar');
  const xAxis = req.body?.xAxis ? String(req.body.xAxis) : null;
  const yAxis = req.body?.yAxis ? String(req.body.yAxis) : null;

  const guard = validateAndSanitizeSql(rawSql);
  if (!guard.safe) {
    res.status(400).json({ error: guard.reason });
    return;
  }

  const card = savePinnedChart({
    title,
    question,
    sql: guard.sanitizedSql,
    chartType,
    xAxis,
    yAxis,
  });
  res.json({ card });
});

app.delete('/api/dashboard/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid card id.' });
    return;
  }
  deletePinnedChart(id);
  res.json({ ok: true });
});

app.post('/api/insights/suggest', async (req: Request, res: Response) => {
  try {
    const tableName = req.body?.tableName ? String(req.body.tableName) : undefined;
    const suggestion = await suggestInsightQuestions(tableName);
    res.json(suggestion);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to suggest insights.',
    });
  }
});

app.post('/api/evals/run', async (_req: Request, res: Response) => {
  try {
    const report = await runFullEvalSuite();
    res.json(report);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to run eval benchmark.',
    });
  }
});

const PORT = Number(process.env.PORT || 8000);

async function bootstrap() {
  await initAndSeedDatabaseAsync();
  await initCache();
  app.listen(PORT, () => {
    const aiInfo = getActiveProviderInfo();
    const dbInfo = getDbEngineInfo();
    console.log(
      `QueryCanvas backend listening on http://localhost:${PORT} (AI: ${aiInfo.provider}/${aiInfo.model}, DB: ${dbInfo.engine})`
    );
  });
}

bootstrap();
