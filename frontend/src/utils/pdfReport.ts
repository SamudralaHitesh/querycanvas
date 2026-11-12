import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ChartType } from '../types';
import { renderChartToPng } from './chartOption';

export interface PdfReportSection {
  title: string;
  question: string;
  insight?: string;
  sql: string;
  chartType: ChartType;
  xAxis: string | null;
  yAxis: string | null;
  columns: string[];
  rows: Record<string, unknown>[];
}

export function exportMultiChartPdf(
  sections: PdfReportSection[],
  filename = 'querycanvas-report.pdf',
  reportTitle = 'QueryCanvas Executive Analytics Report'
): void {
  if (sections.length === 0) return;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  sections.forEach((sec, idx) => {
    if (idx > 0) doc.addPage();
    let y = 42;

    if (idx === 0) {
      doc.setFontSize(18);
      doc.setTextColor(30, 41, 59);
      doc.text(reportTitle, 40, y);
      y += 18;

      doc.setFontSize(9);
      doc.setTextColor(100, 116, 139);
      doc.text(
        `Generated: ${new Date().toLocaleString()}  |  Total Sections: ${sections.length}`,
        40,
        y
      );
      y += 22;
    }

    doc.setFontSize(12);
    doc.setTextColor(79, 70, 229);
    doc.text(`${idx + 1}. ${sec.title}`, 40, y, { maxWidth: pageWidth - 80 });
    y += 18;

    if (sec.insight) {
      doc.setFontSize(10);
      doc.setTextColor(51, 65, 85);
      const summaryLines = doc.splitTextToSize(`AI Summary: ${sec.insight}`, pageWidth - 80);
      doc.text(summaryLines, 40, y);
      y += summaryLines.length * 13 + 10;
    }

    const chartImg = renderChartToPng(
      sec.rows,
      sec.columns,
      sec.chartType,
      sec.xAxis,
      sec.yAxis
    );
    if (chartImg) {
      if (y + 190 > pageHeight - 60) {
        doc.addPage();
        y = 42;
      }
      doc.addImage(chartImg, 'PNG', 40, y, pageWidth - 80, 185);
      y += 200;
    }

    doc.setFontSize(8);
    doc.setTextColor(71, 85, 105);
    const sqlLines = doc.splitTextToSize(`SQL: ${sec.sql}`, pageWidth - 80);
    doc.text(sqlLines, 40, y);
    y += sqlLines.length * 10 + 10;

    if (sec.rows.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [sec.columns],
        body: sec.rows.slice(0, 25).map((r) => sec.columns.map((c) => String(r[c] ?? ''))),
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [79, 70, 229] },
      });
    }
  });

  doc.save(filename);
}
