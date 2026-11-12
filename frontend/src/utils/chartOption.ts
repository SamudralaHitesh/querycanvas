import * as echarts from 'echarts';
import type { ChartType } from '../types';

export function resolveChartAxes(
  rows: Record<string, unknown>[],
  columns: string[],
  xAxis: string | null,
  yAxis: string | null
): { xKey: string; yKey: string } {
  if (rows.length === 0 || columns.length === 0) {
    return { xKey: '', yKey: '' };
  }
  const first = rows[0];
  const xKey =
    xAxis && xAxis in first
      ? xAxis
      : columns.find((c) => typeof first[c] === 'string') || columns[0];

  const yKey =
    yAxis && yAxis in first
      ? yAxis
      : columns.find((c) => c !== xKey && typeof first[c] === 'number') ||
        columns[columns.length - 1];

  return { xKey, yKey };
}

export function buildEChartsOption(
  rows: Record<string, unknown>[],
  columns: string[],
  chartType: ChartType,
  xAxis: string | null,
  yAxis: string | null,
  disableAnimation = false
): echarts.EChartsOption {
  const { xKey, yKey } = resolveChartAxes(rows, columns, xAxis, yAxis);
  const labels = rows.map((r) => String(r[xKey] ?? ''));
  const values = rows.map((r) => Number(r[yKey] ?? 0));

  if (chartType === 'pie') {
    return {
      animation: !disableAnimation,
      backgroundColor: 'transparent',
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: '#94a3b8' } },
      series: [
        {
          type: 'pie',
          radius: ['42%', '70%'],
          center: ['50%', '45%'],
          itemStyle: { borderRadius: 6, borderColor: '#0f172a', borderWidth: 2 },
          label: { color: '#e2e8f0' },
          data: labels.map((name, i) => ({ name, value: values[i] })),
        },
      ],
    };
  }

  return {
    animation: !disableAnimation,
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 56, right: 24, top: 24, bottom: 56 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: '#94a3b8', rotate: labels.length > 6 ? 20 : 0 },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: '#1e293b' } },
    },
    series: [
      {
        name: yKey,
        type: chartType === 'line' ? 'line' : 'bar',
        data: values,
        smooth: chartType === 'line',
        itemStyle: {
          color: '#6366f1',
          borderRadius: chartType === 'bar' ? [6, 6, 0, 0] : 0,
        },
        areaStyle:
          chartType === 'line'
            ? {
                color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                  { offset: 0, color: 'rgba(99, 102, 241, 0.35)' },
                  { offset: 1, color: 'rgba(99, 102, 241, 0.02)' },
                ]),
              }
            : undefined,
      },
    ],
  };
}

export function renderChartToPng(
  rows: Record<string, unknown>[],
  columns: string[],
  chartType: ChartType,
  xAxis: string | null,
  yAxis: string | null
): string | null {
  if (rows.length === 0 || chartType === 'kpi' || chartType === 'table') {
    return null;
  }

  const container = document.createElement('div');
  container.style.width = '720px';
  container.style.height = '340px';
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '-9999px';
  document.body.appendChild(container);

  const chart = echarts.init(container);
  try {
    const option = buildEChartsOption(rows, columns, chartType, xAxis, yAxis, true);
    chart.setOption(option, true);
    return chart.getDataURL({ type: 'png', backgroundColor: '#0f172a', pixelRatio: 2 });
  } finally {
    chart.dispose();
    document.body.removeChild(container);
  }
}
