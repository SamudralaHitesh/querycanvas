<script setup lang="ts">
import * as echarts from 'echarts';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChartType } from '../types';
import { buildEChartsOption } from '../utils/chartOption';

const props = defineProps<{
  rows: Record<string, unknown>[];
  columns: string[];
  chartType: ChartType;
  xAxis: string | null;
  yAxis: string | null;
}>();

const chartContainer = ref<HTMLDivElement | null>(null);
let chartInstance: echarts.ECharts | null = null;

function renderChart() {
  if (!chartContainer.value || props.rows.length === 0 || props.chartType === 'kpi' || props.chartType === 'table') {
    return;
  }

  if (!chartInstance) {
    chartInstance = echarts.init(chartContainer.value);
  }

  const option = buildEChartsOption(
    props.rows,
    props.columns,
    props.chartType,
    props.xAxis,
    props.yAxis
  );
  chartInstance.setOption(option, true);
}

function getImageDataUrl(): string | null {
  if (!chartInstance) return null;
  return chartInstance.getDataURL({ type: 'png', backgroundColor: '#0f172a', pixelRatio: 2 });
}

function downloadPng() {
  const url = getImageDataUrl();
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'querycanvas-chart.png';
  a.click();
}

function handleResize() {
  chartInstance?.resize();
}

onMounted(() => {
  renderChart();
  window.addEventListener('resize', handleResize);
});

watch(
  () => [props.rows, props.chartType, props.xAxis, props.yAxis],
  () => {
    setTimeout(renderChart, 20);
  },
  { deep: true }
);

onBeforeUnmount(() => {
  window.removeEventListener('resize', handleResize);
  chartInstance?.dispose();
  chartInstance = null;
});

defineExpose({ downloadPng, getImageDataUrl });
</script>

<template>
  <div v-if="rows.length === 0" class="flex h-72 items-center justify-center text-sm text-slate-400">
    No rows to visualize.
  </div>

  <div v-else-if="chartType === 'kpi'" class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
    <div
      v-for="col in columns"
      :key="col"
      class="rounded-xl border border-slate-800 bg-slate-900/70 p-5"
    >
      <p class="text-xs font-medium uppercase tracking-wider text-slate-400">{{ col }}</p>
      <p class="mt-2 text-2xl font-bold text-indigo-400">
        {{ rows[0][col] }}
      </p>
    </div>
  </div>

  <div v-else ref="chartContainer" class="h-80 w-full"></div>
</template>
