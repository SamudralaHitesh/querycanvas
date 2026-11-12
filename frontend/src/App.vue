<script setup lang="ts">
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Code2,
  Database,
  Download,
  FileText,
  FlaskConical,
  History,
  LayoutDashboard,
  Loader2,
  Pin,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import EChartView from './components/EChartView.vue';
import SqlEditor from './components/SqlEditor.vue';
import { exportMultiChartPdf } from './utils/pdfReport';
import type {
  ChartType,
  DashboardCard,
  EvalSuiteReport,
  HistoryItem,
  PdfDocSummary,
  PipelineStep,
  QueryResult,
  TableProfile,
  TableSchema,
} from './types';

const CORE_TABLES = new Set(['users', 'products', 'orders', 'order_items']);

const STARTER_PROMPTS = [
  'Show monthly revenue trend',
  'Compare revenue by product category',
  'Show revenue by city',
  'Top 5 customers by total spend',
  'Which payment method has the highest revenue?',
];

const viewMode = ref<'ask' | 'dashboard' | 'evals'>('ask');
const tables = ref<TableSchema[]>([]);
const pdfDocs = ref<PdfDocSummary[]>([]);
const expandedTable = ref<string | null>('orders');
const activeProfile = ref<TableProfile | null>(null);
const history = ref<HistoryItem[]>([]);
const aiInfo = ref<{ provider: string; model: string }>({ provider: 'demo', model: 'local-demo-engine' });
const dbInfo = ref<{ engine: string }>({ engine: 'sqlite-wal' });
const kpis = ref<{
  totalRevenue: number;
  completedOrders: number;
  avgOrderValue: number;
  topCategory: string;
} | null>(null);
const customTables = computed(() => tables.value.filter((t) => !CORE_TABLES.has(t.name)));

const question = ref('');
const isRunning = ref(false);
const errorMessage = ref('');
const pipelineSteps = ref<PipelineStep[]>([]);
const result = ref<QueryResult | null>(null);
const sessionResults = ref<QueryResult[]>([]);
const activeTab = ref<'chart' | 'table' | 'sql'>('chart');
const selectedChartType = ref<ChartType>('bar');
const editableSql = ref('');
const showMetricsDrawer = ref(false);
const uploadInput = ref<HTMLInputElement | null>(null);
const uploadStatus = ref('');
const chartRef = ref<InstanceType<typeof EChartView> | null>(null);

const dashboardCards = ref<DashboardCard[]>([]);
const pinNotice = ref('');
const isLoadingDashboard = ref(false);

const evalReport = ref<EvalSuiteReport | null>(null);
const isRunningEvals = ref(false);
const isAutoDiscovering = ref(false);
const autoDiscoverProgress = ref('');

const hasResult = computed(() => result.value !== null);

async function loadSchemaAndHistory() {
  try {
    const [schemaRes, histRes, dashRes] = await Promise.all([
      fetch('/api/schema'),
      fetch('/api/history'),
      fetch('/api/dashboard'),
    ]);
    if (schemaRes.ok) {
      const data = await schemaRes.json();
      tables.value = data.tables || [];
      pdfDocs.value = data.pdfs || [];
      if (data.kpis) kpis.value = data.kpis;
      if (data.ai) aiInfo.value = data.ai;
      if (data.db) dbInfo.value = data.db;
    }
    if (histRes.ok) {
      const data = await histRes.json();
      history.value = data.history || [];
    }
    if (dashRes.ok) {
      const data = await dashRes.json();
      dashboardCards.value = data.cards || [];
    }
  } catch {
    errorMessage.value = 'Could not reach backend API on /api. Make sure the backend server is running.';
  }
}

async function askQuestion(promptText?: string) {
  const q = (promptText ?? question.value).trim();
  if (!q || isRunning.value) return;
  viewMode.value = 'ask';
  question.value = q;
  isRunning.value = true;
  errorMessage.value = '';
  pinNotice.value = '';
  pipelineSteps.value = [];

  try {
    const res = await fetch('/api/query/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        let eventName = 'message';
        let dataLine = '';
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        const payload = JSON.parse(dataLine);

        if (eventName === 'step') {
          pipelineSteps.value.push(payload as PipelineStep);
        } else if (eventName === 'result') {
          const queryRes = payload as QueryResult;
          result.value = queryRes;
          selectedChartType.value = queryRes.chartType === 'table' ? 'bar' : queryRes.chartType;
          editableSql.value = queryRes.sql;
          activeTab.value = queryRes.chartType === 'table' ? 'table' : 'chart';

          const existingIdx = sessionResults.value.findIndex(
            (item) => item.question.toLowerCase() === queryRes.question.toLowerCase()
          );
          if (existingIdx >= 0) {
            sessionResults.value[existingIdx] = { ...queryRes };
          } else {
            sessionResults.value.push({ ...queryRes });
          }
        } else if (eventName === 'error') {
          errorMessage.value = payload.message || 'Query failed.';
        }
      }
    }

    await loadSchemaAndHistory();
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Unexpected query error.';
  } finally {
    isRunning.value = false;
  }
}

async function runEditedSql() {
  if (!editableSql.value.trim()) return;
  errorMessage.value = '';
  try {
    const res = await fetch('/api/query/run-sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: editableSql.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      errorMessage.value = data.error || 'SQL execution failed.';
      return;
    }
    if (result.value) {
      result.value = {
        ...result.value,
        sql: data.sql,
        columns: data.columns,
        rows: data.rows,
        metrics: {
          ...result.value.metrics,
          dbExecutionMs: data.dbExecutionMs,
        },
      };
    }
    activeTab.value = 'table';
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to run SQL.';
  }
}

async function handleFileUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  uploadStatus.value = 'Parsing, indexing & profiling file...';
  errorMessage.value = '';
  const form = new FormData();
  form.append('file', file);

  try {
    const res = await fetch('/api/datasets/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'File upload failed');
    }
    tables.value = data.tables || [];
    pdfDocs.value = data.pdfs || [];
    if (data.kind === 'pdf') {
      const extra = data.dataset
        ? ` + extracted SQL table "${data.dataset.tableName}" (${data.dataset.rowCount} rows)`
        : '';
      uploadStatus.value = `Saved PDF "${data.pdf.filename}" (${data.pdf.page_count}p)${extra}`;
      if (data.dataset?.profile) activeProfile.value = data.dataset.profile;
      question.value = `Summarize ${data.pdf.filename}`;
    } else {
      expandedTable.value = data.dataset.tableName;
      activeProfile.value = data.dataset.profile || null;
      uploadStatus.value = `Loaded "${data.dataset.tableName}" (${data.dataset.rowCount} rows)`;
      question.value = `Show summary from ${data.dataset.tableName}`;
    }
  } catch (err) {
    uploadStatus.value = '';
    errorMessage.value = err instanceof Error ? err.message : 'File upload failed';
  } finally {
    input.value = '';
  }
}

async function loadTableProfile(tableName: string) {
  try {
    const res = await fetch(`/api/datasets/${encodeURIComponent(tableName)}/profile`);
    if (res.ok) {
      const data = await res.json();
      activeProfile.value = data.profile;
    }
  } catch {
    // ignore
  }
}

async function removeCustomTable(tableName: string) {
  try {
    const res = await fetch(`/api/datasets/${encodeURIComponent(tableName)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      tables.value = data.tables;
      if (activeProfile.value?.tableName === tableName) {
        activeProfile.value = null;
      }
    }
  } catch {
    // ignore
  }
}

async function removePdfDoc(id: number) {
  try {
    const res = await fetch(`/api/pdfs/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      pdfDocs.value = data.pdfs || [];
    }
  } catch {
    // ignore
  }
}

async function pinCurrentChart() {
  if (!result.value) return;
  pinNotice.value = '';
  try {
    const res = await fetch('/api/dashboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: result.value.question,
        question: result.value.question,
        sql: result.value.sql,
        chartType: selectedChartType.value,
        xAxis: result.value.xAxis,
        yAxis: result.value.yAxis,
      }),
    });
    if (res.ok) {
      pinNotice.value = 'Pinned to Dashboard!';
      await refreshDashboard();
    }
  } catch {
    errorMessage.value = 'Could not pin chart to dashboard.';
  }
}

async function refreshDashboard() {
  isLoadingDashboard.value = true;
  try {
    const res = await fetch('/api/dashboard');
    if (res.ok) {
      const data = await res.json();
      dashboardCards.value = data.cards || [];
    }
  } finally {
    isLoadingDashboard.value = false;
  }
}

async function unpinCard(id: number) {
  const res = await fetch(`/api/dashboard/${id}`, { method: 'DELETE' });
  if (res.ok) {
    dashboardCards.value = dashboardCards.value.filter((c) => c.id !== id);
  }
}

async function runLiveEvals() {
  isRunningEvals.value = true;
  try {
    const res = await fetch('/api/evals/run', { method: 'POST' });
    if (res.ok) {
      evalReport.value = await res.json();
    }
  } finally {
    isRunningEvals.value = false;
  }
}

async function runAutoDiscover() {
  if (isRunning.value || isAutoDiscovering.value) return;
  isAutoDiscovering.value = true;
  errorMessage.value = '';
  try {
    const preferredTable =
      customTables.value.length > 0
        ? customTables.value[customTables.value.length - 1].name
        : undefined;
    const res = await fetch('/api/insights/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName: preferredTable }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to generate insight plan.');

    const questions: string[] = data.questions || [];
    for (let i = 0; i < questions.length; i++) {
      autoDiscoverProgress.value = `${i + 1}/${questions.length}`;
      await askQuestion(questions[i]);
    }
    pinNotice.value = `Auto-discovered ${questions.length} charts — click "Export All (${sessionResults.value.length}) PDF" to download as one report!`;
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Auto-Discover failed.';
  } finally {
    isAutoDiscovering.value = false;
    autoDiscoverProgress.value = '';
  }
}

function selectSessionResult(item: QueryResult) {
  result.value = item;
  question.value = item.question;
  selectedChartType.value = item.chartType === 'table' ? 'bar' : item.chartType;
  editableSql.value = item.sql;
  activeTab.value = item.chartType === 'table' ? 'table' : 'chart';
}

function exportCsv() {
  if (!result.value || result.value.rows.length === 0) return;
  const cols = result.value.columns;
  const lines = [
    cols.join(','),
    ...result.value.rows.map((r) =>
      cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')
    ),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'querycanvas-export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

watch(selectedChartType, (newType) => {
  if (!result.value) return;
  const active = sessionResults.value.find(
    (item) => item.question.toLowerCase() === result.value!.question.toLowerCase()
  );
  if (active) active.chartType = newType;
});

function toSessionPdfSection(item: QueryResult, chartOverride?: ChartType) {
  return {
    title: item.question,
    question: item.question,
    insight: item.insight,
    sql: item.sql,
    chartType: chartOverride ?? item.chartType,
    xAxis: item.xAxis,
    yAxis: item.yAxis,
    columns: item.columns,
    rows: item.rows,
  };
}

function exportPdfReport() {
  if (!result.value) return;
  exportMultiChartPdf(
    [toSessionPdfSection(result.value, selectedChartType.value)],
    'querycanvas-report.pdf',
    'QueryCanvas Executive Analytics Report'
  );
}

function exportSessionPdf() {
  if (sessionResults.value.length === 0) return;
  exportMultiChartPdf(
    sessionResults.value.map((item) => toSessionPdfSection(item)),
    'querycanvas-session-report.pdf',
    `QueryCanvas Multi-Query Session Report (${sessionResults.value.length} Charts)`
  );
}

function exportDashboardPdf() {
  const validCards = dashboardCards.value.filter((c) => !c.error && c.rows.length > 0);
  if (validCards.length === 0) return;
  exportMultiChartPdf(
    validCards.map((card) => ({
      title: card.title,
      question: card.question,
      sql: card.sql_query,
      chartType: card.chart_type,
      xAxis: card.x_axis,
      yAxis: card.y_axis,
      columns: card.columns,
      rows: card.rows,
    })),
    'querycanvas-dashboard-report.pdf',
    `QueryCanvas Pinned BI Dashboard (${validCards.length} Charts)`
  );
}

onMounted(async () => {
  await loadSchemaAndHistory();
  await askQuestion('Show monthly revenue trend');
});
</script>

<template>
  <div class="flex min-h-screen flex-col bg-slate-950 text-slate-100">
    <!-- Top Header -->
    <header class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/70 px-5 py-3 backdrop-blur">
      <div class="flex items-center gap-4">
        <div class="flex items-center gap-3">
          <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600/20 text-indigo-400 ring-1 ring-indigo-500/40">
            <Sparkles class="h-5 w-5" />
          </div>
          <div>
            <h1 class="text-base font-bold tracking-tight text-white">QueryCanvas</h1>
            <p class="text-xs text-slate-400">Safe AI Text-to-SQL &amp; Analytics Studio</p>
          </div>
        </div>

        <!-- Primary View Switcher -->
        <nav class="ml-2 flex items-center gap-1 rounded-xl border border-slate-800 bg-slate-950/70 p-1">
          <button
            type="button"
            @click="viewMode = 'ask'"
            :class="viewMode === 'ask' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
            class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition"
          >
            <Sparkles class="h-3.5 w-3.5" />
            Ask AI
          </button>
          <button
            type="button"
            @click="viewMode = 'dashboard'; refreshDashboard()"
            :class="viewMode === 'dashboard' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
            class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition"
          >
            <LayoutDashboard class="h-3.5 w-3.5" />
            Dashboard ({{ dashboardCards.length }})
          </button>
          <button
            type="button"
            @click="viewMode = 'evals'"
            :class="viewMode === 'evals' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
            class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition"
          >
            <FlaskConical class="h-3.5 w-3.5" />
            Evals
          </button>
        </nav>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
          <ShieldCheck class="h-3.5 w-3.5" />
          AST Guard
        </span>
        <span class="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1 text-xs text-slate-300">
          DB: <strong class="text-sky-300">{{ dbInfo.engine }}</strong>
        </span>
        <span class="rounded-full border border-slate-700 bg-slate-800/80 px-3 py-1 text-xs text-slate-300">
          AI: <strong class="text-indigo-300">{{ aiInfo.provider }}</strong>
        </span>

        <input
          ref="uploadInput"
          type="file"
          accept=".csv,.xlsx,.pdf"
          class="hidden"
          @change="handleFileUpload"
        />
        <button
          type="button"
          @click="uploadInput?.click()"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-indigo-500 hover:text-white"
        >
          <Upload class="h-3.5 w-3.5" />
          Upload CSV / Excel / PDF
        </button>

        <button
          type="button"
          @click="showMetricsDrawer = !showMetricsDrawer"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-indigo-500"
        >
          <Activity class="h-3.5 w-3.5 text-indigo-400" />
          Observability
        </button>
      </div>
    </header>

    <div class="flex flex-1 flex-col lg:flex-row">
      <!-- Left Sidebar: Schema Explorer + History -->
      <aside class="w-full border-b border-slate-800 bg-slate-900/40 p-4 lg:w-72 lg:shrink-0 lg:border-r lg:border-b-0">
        <div class="mb-6">
          <div class="mb-2.5 flex items-center justify-between">
            <h2 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <Database class="h-3.5 w-3.5 text-indigo-400" />
              Data Explorer
            </h2>
            <span class="text-xs text-slate-500">{{ tables.length }} tables</span>
          </div>

          <p v-if="uploadStatus" class="mb-2 rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-300">
            {{ uploadStatus }}
          </p>

          <div class="space-y-1.5">
            <div
              v-for="tbl in tables"
              :key="tbl.name"
              class="rounded-lg border border-slate-800 bg-slate-900/70"
            >
              <div class="flex items-center justify-between px-3 py-2">
                <button
                  type="button"
                  @click="expandedTable = expandedTable === tbl.name ? null : tbl.name"
                  class="flex flex-1 items-center justify-between text-left text-xs font-medium text-slate-200 hover:text-indigo-300"
                >
                  <span class="truncate">{{ tbl.name }}</span>
                  <span class="ml-2 shrink-0 text-[11px] text-slate-500">{{ tbl.rowCount }} rows</span>
                </button>
                <button
                  type="button"
                  @click="loadTableProfile(tbl.name)"
                  title="Inspect Data Profile"
                  class="ml-2 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-indigo-500 hover:text-white"
                >
                  Profile
                </button>
                <button
                  v-if="!CORE_TABLES.has(tbl.name)"
                  type="button"
                  @click="removeCustomTable(tbl.name)"
                  title="Delete uploaded table"
                  class="ml-1.5 text-slate-500 hover:text-rose-400"
                >
                  <Trash2 class="h-3.5 w-3.5" />
                </button>
              </div>

              <div v-if="expandedTable === tbl.name" class="border-t border-slate-800 px-3 py-2 space-y-1">
                <div
                  v-for="col in tbl.columns"
                  :key="col.name"
                  class="flex items-center justify-between text-[11px]"
                >
                  <span class="font-mono text-slate-300">{{ col.name }}</span>
                  <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{{ col.type }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="pdfDocs.length > 0" class="mb-6">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
              <FileText class="h-3.5 w-3.5 text-amber-400" />
              Saved PDFs
            </h2>
            <span class="text-xs text-slate-500">{{ pdfDocs.length }} files</span>
          </div>
          <div class="space-y-1.5">
            <div
              v-for="doc in pdfDocs"
              :key="doc.id"
              class="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2"
            >
              <button
                type="button"
                @click="askQuestion(`Summarize ${doc.filename}`)"
                class="min-w-0 flex-1 text-left"
              >
                <p class="truncate text-xs font-medium text-slate-200 hover:text-amber-300">
                  {{ doc.filename }}
                </p>
                <p class="text-[10px] text-slate-500">{{ doc.page_count }} page(s)</p>
              </button>
              <button
                type="button"
                @click="removePdfDoc(doc.id)"
                title="Delete PDF"
                class="ml-2 text-slate-500 hover:text-rose-400"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div>
          <h2 class="mb-2.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <History class="h-3.5 w-3.5 text-indigo-400" />
            Recent Queries
          </h2>
          <div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            <button
              v-for="item in history"
              :key="item.id"
              type="button"
              @click="askQuestion(item.question)"
              class="w-full rounded-lg border border-slate-800/80 bg-slate-900/50 px-3 py-2 text-left transition hover:border-indigo-500/50 hover:bg-slate-800/60"
            >
              <p class="truncate text-xs font-medium text-slate-200">{{ item.question }}</p>
              <p class="mt-0.5 text-[10px] text-slate-500">
                {{ item.row_count }} rows · {{ item.latency_ms }}ms
                <span v-if="item.cache_hit" class="text-emerald-400">· cached</span>
              </p>
            </button>
          </div>
        </div>
      </aside>

      <!-- Main Analytics Workspace -->
      <main class="flex-1 p-5 space-y-5 overflow-x-hidden">
        <!-- Data Profile Card (when inspected or uploaded) -->
        <section
          v-if="activeProfile"
          class="rounded-2xl border border-sky-500/30 bg-slate-900/80 p-4"
        >
          <div class="mb-3 flex items-center justify-between">
            <div>
              <h3 class="text-sm font-semibold text-white">
                Data Profile: <span class="font-mono text-sky-300">{{ activeProfile.tableName }}</span>
              </h3>
              <p class="text-xs text-slate-400">
                {{ activeProfile.rowCount }} rows · {{ activeProfile.columnCount }} columns
              </p>
            </div>
            <button
              type="button"
              @click="activeProfile = null"
              class="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="cp in activeProfile.columns"
              :key="cp.name"
              class="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-xs"
            >
              <div class="flex items-center justify-between">
                <span class="font-mono font-semibold text-slate-200">{{ cp.name }}</span>
                <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{{ cp.type }}</span>
              </div>
              <p class="mt-1.5 text-[11px] text-slate-400">
                Distinct: <strong class="text-slate-200">{{ cp.distinctCount }}</strong> ·
                Nulls: <strong :class="cp.nullCount > 0 ? 'text-amber-300' : 'text-emerald-300'">{{ cp.nullCount }}</strong>
              </p>
              <p v-if="cp.avg !== undefined && cp.avg !== null" class="mt-0.5 text-[11px] text-sky-300">
                Min: {{ cp.min }} · Avg: {{ cp.avg }} · Max: {{ cp.max }}
              </p>
            </div>
          </div>
        </section>

        <!-- VIEW 1: ASK AI WORKSPACE -->
        <template v-if="viewMode === 'ask'">
          <!-- Live KPI Summary Strip -->
          <section v-if="kpis" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
              <p class="text-[11px] uppercase tracking-wider text-slate-400">Total Revenue</p>
              <p class="mt-1 text-lg font-bold text-emerald-400">
                ${{ kpis.totalRevenue.toLocaleString() }}
              </p>
            </div>
            <div class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
              <p class="text-[11px] uppercase tracking-wider text-slate-400">Completed Orders</p>
              <p class="mt-1 text-lg font-bold text-white">{{ kpis.completedOrders }}</p>
            </div>
            <div class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
              <p class="text-[11px] uppercase tracking-wider text-slate-400">Avg Order Value</p>
              <p class="mt-1 text-lg font-bold text-indigo-300">
                ${{ kpis.avgOrderValue.toLocaleString() }}
              </p>
            </div>
            <div class="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3">
              <p class="text-[11px] uppercase tracking-wider text-slate-400">Top Category</p>
              <p class="mt-1 truncate text-lg font-bold text-sky-300">{{ kpis.topCategory }}</p>
            </div>
          </section>

          <!-- Persistent Uploaded Files Strip (above AI search bar) -->
          <section
            v-if="customTables.length > 0 || pdfDocs.length > 0"
            class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3.5 py-2.5 text-xs"
          >
            <span class="font-semibold text-slate-400">Your Uploaded Files:</span>
            <button
              v-for="tbl in customTables"
              :key="tbl.name"
              type="button"
              @click="loadTableProfile(tbl.name)"
              class="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1 text-xs font-medium text-sky-300 hover:bg-sky-500/20"
            >
              <Table2 class="h-3 w-3" />
              {{ tbl.name }} ({{ tbl.rowCount }} rows)
            </button>
            <button
              v-for="doc in pdfDocs"
              :key="'pill-' + doc.id"
              type="button"
              @click="askQuestion(`Summarize ${doc.filename}`)"
              class="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
            >
              <FileText class="h-3 w-3" />
              {{ doc.filename }} ({{ doc.page_count }}p)
            </button>
          </section>

          <section class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-lg">
            <form @submit.prevent="askQuestion()" class="flex flex-col gap-3 sm:flex-row">
              <input
                v-model="question"
                type="text"
                placeholder="Ask a business question in plain English (e.g. region wise profit)..."
                class="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="submit"
                :disabled="isRunning || isAutoDiscovering"
                class="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
              >
                <Loader2 v-if="isRunning && !isAutoDiscovering" class="h-4 w-4 animate-spin" />
                <Play v-else class="h-4 w-4" />
                {{ isRunning && !isAutoDiscovering ? 'Analyzing...' : 'Ask AI' }}
              </button>
              <button
                type="button"
                @click="runAutoDiscover"
                :disabled="isRunning || isAutoDiscovering"
                class="inline-flex items-center justify-center gap-1.5 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-4 py-2.5 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
                title="Automatically inspect active tables/uploads and generate 4 complementary charts ready for multi-chart PDF export"
              >
                <Loader2 v-if="isAutoDiscovering" class="h-4 w-4 animate-spin" />
                <Sparkles v-else class="h-4 w-4" />
                {{ isAutoDiscovering ? `Auto ${autoDiscoverProgress}` : 'Auto-Discover (4)' }}
              </button>
            </form>

            <div class="mt-3 flex flex-wrap gap-2">
              <button
                v-for="prompt in STARTER_PROMPTS"
                :key="prompt"
                type="button"
                @click="askQuestion(prompt)"
                class="rounded-full border border-slate-700/80 bg-slate-800/60 px-3 py-1 text-xs text-slate-300 transition hover:border-indigo-500/60 hover:text-white"
              >
                {{ prompt }}
              </button>
            </div>

            <div v-if="pipelineSteps.length > 0" class="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-3">
              <span
                v-for="(step, idx) in pipelineSteps"
                :key="idx"
                class="inline-flex items-center gap-1 rounded-md bg-slate-800/80 px-2 py-1 text-[11px] text-slate-300"
              >
                <CheckCircle2 class="h-3 w-3 text-emerald-400" />
                {{ step.message }}
              </span>
            </div>
          </section>

          <div
            v-if="errorMessage"
            class="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
          >
            {{ errorMessage }}
          </div>

          <section
            v-if="showMetricsDrawer && result"
            class="grid grid-cols-2 gap-3 rounded-2xl border border-indigo-500/30 bg-indigo-950/20 p-4 sm:grid-cols-5"
          >
            <div>
              <p class="text-[11px] uppercase text-slate-400">Total Latency</p>
              <p class="text-base font-bold text-white">{{ result.metrics.totalLatencyMs }} ms</p>
            </div>
            <div>
              <p class="text-[11px] uppercase text-slate-400">DB Exec Time</p>
              <p class="text-base font-bold text-white">{{ result.metrics.dbExecutionMs }} ms</p>
            </div>
            <div>
              <p class="text-[11px] uppercase text-slate-400">Cache Status</p>
              <p class="text-base font-bold" :class="result.metrics.cacheHit ? 'text-emerald-400' : 'text-amber-300'">
                {{ result.metrics.cacheHit ? 'HIT' : 'MISS' }}
              </p>
            </div>
            <div>
              <p class="text-[11px] uppercase text-slate-400">Self-Heal Retries</p>
              <p class="text-base font-bold text-white">{{ result.metrics.retries }}</p>
            </div>
            <div>
              <p class="text-[11px] uppercase text-slate-400">Matched Tables</p>
              <p class="truncate text-xs font-mono text-indigo-300">{{ result.metrics.tablesRetrieved.join(', ') }}</p>
            </div>
          </section>

          <section v-if="hasResult && result" class="space-y-4">
            <div
              v-if="sessionResults.length >= 2"
              class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2"
            >
              <span class="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Session Charts ({{ sessionResults.length }}):
              </span>
              <button
                v-for="(item, idx) in sessionResults"
                :key="'sess-' + idx"
                type="button"
                @click="selectSessionResult(item)"
                :class="
                  result?.question === item.question
                    ? 'border-indigo-500 bg-indigo-600/25 text-white'
                    : 'border-slate-700/80 bg-slate-800/70 text-slate-300 hover:border-slate-500'
                "
                class="max-w-[230px] truncate rounded-lg border px-2.5 py-1 text-xs transition"
                :title="item.question"
              >
                {{ idx + 1 }}. {{ item.question }}
              </button>
            </div>

            <div class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="text-xs font-semibold uppercase tracking-wider text-indigo-400">
                  Grounded AI Summary
                </span>
                <span class="text-xs text-slate-400">{{ result.explanation }}</span>
              </div>
              <p class="mt-1.5 text-sm leading-relaxed text-slate-200">{{ result.insight }}</p>
            </div>

            <div class="rounded-2xl border border-slate-800 bg-slate-900/60">
              <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    @click="activeTab = 'chart'"
                    :class="activeTab === 'chart' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
                    class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                  >
                    <BarChart3 class="h-3.5 w-3.5" />
                    Chart
                  </button>
                  <button
                    type="button"
                    @click="activeTab = 'table'"
                    :class="activeTab === 'table' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
                    class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                  >
                    <Table2 class="h-3.5 w-3.5" />
                    Data ({{ result.rows.length }})
                  </button>
                  <button
                    type="button"
                    @click="activeTab = 'sql'"
                    :class="activeTab === 'sql' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'"
                    class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                  >
                    <Code2 class="h-3.5 w-3.5" />
                    SQL Editor
                  </button>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <span v-if="pinNotice" class="text-xs text-emerald-400">{{ pinNotice }}</span>
                  <button
                    type="button"
                    @click="pinCurrentChart"
                    class="inline-flex items-center gap-1 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20"
                  >
                    <Pin class="h-3.5 w-3.5" />
                    Pin to Dashboard
                  </button>
                  <select
                    v-if="activeTab === 'chart'"
                    v-model="selectedChartType"
                    class="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-xs text-slate-200"
                  >
                    <option value="bar">Bar Chart</option>
                    <option value="line">Line Chart</option>
                    <option value="pie">Pie Chart</option>
                  </select>
                  <button
                    v-if="activeTab === 'chart'"
                    type="button"
                    @click="chartRef?.downloadPng()"
                    class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500"
                  >
                    <Download class="h-3.5 w-3.5" />
                    PNG
                  </button>
                  <button
                    type="button"
                    @click="exportCsv"
                    class="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:border-indigo-500"
                  >
                    <Download class="h-3.5 w-3.5" />
                    CSV
                  </button>
                  <button
                    type="button"
                    @click="exportPdfReport"
                    class="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
                  >
                    <FileText class="h-3.5 w-3.5" />
                    PDF Report
                  </button>
                  <button
                    v-if="sessionResults.length >= 2"
                    type="button"
                    @click="exportSessionPdf"
                    class="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20"
                    title="Export all charts & queries from this session into one multi-page PDF"
                  >
                    <FileText class="h-3.5 w-3.5" />
                    Export All ({{ sessionResults.length }}) PDF
                  </button>
                </div>
              </div>

              <div class="p-4">
                <EChartView
                  v-if="activeTab === 'chart'"
                  ref="chartRef"
                  :rows="result.rows"
                  :columns="result.columns"
                  :chart-type="selectedChartType"
                  :x-axis="result.xAxis"
                  :y-axis="result.yAxis"
                />

                <div v-else-if="activeTab === 'table'" class="max-h-96 overflow-auto rounded-xl border border-slate-800">
                  <table class="min-w-full divide-y divide-slate-800 text-left text-xs">
                    <thead class="bg-slate-950 text-slate-400">
                      <tr>
                        <th v-for="col in result.columns" :key="col" class="px-3.5 py-2.5 font-semibold">
                          {{ col }}
                        </th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800/70">
                      <tr v-for="(row, idx) in result.rows" :key="idx" class="hover:bg-slate-800/40">
                        <td v-for="col in result.columns" :key="col" class="whitespace-nowrap px-3.5 py-2 text-slate-200">
                          {{ row[col] }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <SqlEditor
                  v-else-if="activeTab === 'sql'"
                  v-model="editableSql"
                  @run="runEditedSql"
                />
              </div>
            </div>

            <div v-if="result.followUps.length > 0" class="flex flex-wrap items-center gap-2">
              <span class="text-xs font-medium text-slate-400">Follow-up ideas:</span>
              <button
                v-for="fu in result.followUps"
                :key="fu"
                type="button"
                @click="askQuestion(fu)"
                class="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-xs text-indigo-300 transition hover:bg-indigo-500/20"
              >
                {{ fu }}
              </button>
            </div>
          </section>
        </template>

        <!-- VIEW 2: SAVED BI DASHBOARD -->
        <template v-else-if="viewMode === 'dashboard'">
          <div class="flex items-center justify-between">
            <div>
              <h2 class="text-lg font-bold text-white">Pinned BI Dashboard</h2>
              <p class="text-xs text-slate-400">Live charts re-executed against your database on load.</p>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="dashboardCards.length > 0"
                type="button"
                @click="exportDashboardPdf"
                class="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20"
              >
                <FileText class="h-3.5 w-3.5" />
                Export Full PDF
              </button>
              <button
                type="button"
                @click="refreshDashboard"
                :disabled="isLoadingDashboard"
                class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-indigo-500"
              >
                <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': isLoadingDashboard }" />
                Refresh All
              </button>
            </div>
          </div>

          <div
            v-if="dashboardCards.length === 0"
            class="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 p-10 text-center text-sm text-slate-400"
          >
            No charts pinned yet. Run any query in <strong>Ask AI</strong> and click <strong>Pin to Dashboard</strong>!
          </div>

          <div v-else class="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <div
              v-for="card in dashboardCards"
              :key="card.id"
              class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4"
            >
              <div class="mb-2 flex items-start justify-between gap-2">
                <div>
                  <h3 class="text-sm font-semibold text-white">{{ card.title }}</h3>
                  <p class="text-[11px] text-slate-400">
                    {{ card.rows.length }} rows · {{ card.executionMs ?? 0 }}ms
                  </p>
                </div>
                <div class="flex items-center gap-1.5">
                  <button
                    type="button"
                    @click="askQuestion(card.question)"
                    class="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:border-indigo-500"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    @click="unpinCard(card.id)"
                    class="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-rose-400"
                    title="Unpin chart"
                  >
                    <Trash2 class="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <p v-if="card.error" class="text-xs text-rose-400">{{ card.error }}</p>
              <EChartView
                v-else
                :rows="card.rows"
                :columns="card.columns"
                :chart-type="card.chart_type"
                :x-axis="card.x_axis"
                :y-axis="card.y_axis"
              />
            </div>
          </div>
        </template>

        <!-- VIEW 3: IN-APP AI EVALUATION & SECURITY BENCHMARK -->
        <template v-else-if="viewMode === 'evals'">
          <div class="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <div>
              <h2 class="text-lg font-bold text-white">AI Accuracy &amp; Security Benchmark</h2>
              <p class="text-xs text-slate-400">
                Runs 8 golden Text-to-SQL test cases + 4 SQL AST security firewall checks live.
              </p>
            </div>
            <button
              type="button"
              @click="runLiveEvals"
              :disabled="isRunningEvals"
              class="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              <Loader2 v-if="isRunningEvals" class="h-4 w-4 animate-spin" />
              <FlaskConical v-else class="h-4 w-4" />
              {{ isRunningEvals ? 'Running Benchmark...' : 'Run Live Benchmark' }}
            </button>
          </div>

          <div v-if="evalReport" class="space-y-5">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div class="rounded-2xl border border-emerald-500/30 bg-emerald-950/20 p-4">
                <p class="text-xs uppercase text-slate-400">Execution Accuracy</p>
                <p class="mt-1 text-2xl font-bold text-emerald-400">
                  {{ evalReport.executionAccuracy }}%
                  <span class="text-xs font-normal text-slate-400">
                    ({{ evalReport.passedAccuracy }}/{{ evalReport.totalAccuracy }})
                  </span>
                </p>
              </div>
              <div class="rounded-2xl border border-sky-500/30 bg-sky-950/20 p-4">
                <p class="text-xs uppercase text-slate-400">Security Firewall Pass</p>
                <p class="mt-1 text-2xl font-bold text-sky-400">
                  {{ evalReport.securityPassRate }}%
                  <span class="text-xs font-normal text-slate-400">
                    ({{ evalReport.passedSecurity }}/{{ evalReport.totalSecurity }})
                  </span>
                </p>
              </div>
              <div class="rounded-2xl border border-indigo-500/30 bg-indigo-950/20 p-4">
                <p class="text-xs uppercase text-slate-400">Average Latency</p>
                <p class="mt-1 text-2xl font-bold text-indigo-300">{{ evalReport.avgLatencyMs }} ms</p>
              </div>
            </div>

            <div class="grid grid-cols-1 gap-5 lg:grid-cols-2">
              <div class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                <h3 class="mb-3 text-sm font-semibold text-white">Text-to-SQL Accuracy Cases</h3>
                <div class="space-y-2">
                  <div
                    v-for="(c, idx) in evalReport.accuracyCases"
                    :key="idx"
                    class="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs"
                  >
                    <span class="truncate pr-2 text-slate-200">{{ c.question }}</span>
                    <span
                      :class="c.passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'"
                      class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold"
                    >
                      {{ c.passed ? `PASS (${c.rowCount} rows)` : 'FAIL' }}
                    </span>
                  </div>
                </div>
              </div>

              <div class="rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
                <h3 class="mb-3 text-sm font-semibold text-white">AST SQL Firewall Cases</h3>
                <div class="space-y-2">
                  <div
                    v-for="(s, idx) in evalReport.securityCases"
                    :key="idx"
                    class="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs"
                  >
                    <div class="truncate pr-2">
                      <p class="font-medium text-slate-200">{{ s.name }}</p>
                      <p class="truncate font-mono text-[10px] text-slate-400">{{ s.sql }}</p>
                    </div>
                    <span
                      :class="s.passed ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'"
                      class="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold"
                    >
                      {{ s.passed ? 'BLOCKED / SAFE' : 'FAIL' }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>
