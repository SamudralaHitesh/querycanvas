import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { PDFParse } from 'pdf-parse';
import {
  getTableProfile,
  getWriteDb,
  PdfDocSummary,
  savePdfDocument,
  tableExists,
  TableProfile,
} from '../db/database.js';
import { clearQueryCache } from './cache.js';

const PROTECTED_TABLES = new Set([
  'users',
  'products',
  'orders',
  'order_items',
  '_qc_history',
  '_qc_dashboards',
  '_qc_pdf_docs',
]);

function sanitizeIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return /^\d/.test(cleaned) ? `col_${cleaned}` : cleaned;
}

function getUniqueTableName(base: string): string {
  let candidate = base;
  if (PROTECTED_TABLES.has(candidate) || candidate.startsWith('_qc_')) {
    candidate = `upload_${candidate}`;
  }
  let counter = 2;
  const root = candidate;
  while (tableExists(candidate)) {
    candidate = `${root}_${counter}`;
    counter++;
  }
  return candidate;
}

function inferSqliteType(values: string[]): 'INTEGER' | 'REAL' | 'TEXT' {
  const nonEmpty = values.map((v) => v.trim()).filter((v) => v !== '');
  if (nonEmpty.length === 0) return 'TEXT';

  let allInt = true;
  let allFloat = true;

  for (const val of nonEmpty.slice(0, 200)) {
    const normalized = val.replace(/,/g, '');
    if (!/^-?\d+$/.test(normalized)) allInt = false;
    if (!/^-?\d+(\.\d+)?$/.test(normalized)) allFloat = false;
  }

  if (allInt) return 'INTEGER';
  if (allFloat) return 'REAL';
  return 'TEXT';
}

function cellToString(val: ExcelJS.CellValue): string {
  if (val === null || val === undefined) return '';
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'object') {
    if ('result' in val && val.result !== undefined) return String(val.result);
    if ('text' in val && val.text !== undefined) return String(val.text);
    if ('richText' in val && Array.isArray(val.richText)) {
      return val.richText.map((r) => r.text).join('');
    }
  }
  return String(val);
}

async function parseExcelBuffer(buffer: Buffer): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  const arrayBuf = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
  await workbook.xlsx.load(arrayBuf);
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) {
    throw new Error('Excel workbook has no data rows.');
  }

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = cellToString(cell.value).trim() || `col_${colNumber}`;
  });

  const records: Record<string, string>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const obj: Record<string, string> = {};
    let hasData = false;
    for (let c = 1; c < headers.length; c++) {
      const h = headers[c];
      if (!h) continue;
      const str = cellToString(row.getCell(c).value).trim();
      if (str !== '') hasData = true;
      obj[h] = str;
    }
    if (hasData) records.push(obj);
  }
  return records;
}

function insertRecordsIntoNewTable(
  records: Record<string, string>[],
  desiredBaseName: string
): {
  tableName: string;
  rowCount: number;
  columns: Array<{ name: string; type: string }>;
  profile: TableProfile;
} {
  const tableName = getUniqueTableName(sanitizeIdentifier(desiredBaseName, 'uploaded_data'));
  const rawHeaders = Object.keys(records[0]);
  const usedNames = new Set<string>();
  const colDefs = rawHeaders.map((header, idx) => {
    let colName = sanitizeIdentifier(header, `col_${idx + 1}`);
    while (usedNames.has(colName)) {
      colName = `${colName}_${idx + 1}`;
    }
    usedNames.add(colName);

    const sampleVals = records.map((r) => String(r[header] ?? ''));
    const colType = inferSqliteType(sampleVals);
    return { rawHeader: header, name: colName, type: colType };
  });

  const db = getWriteDb();
  const safeTable = `"${tableName}"`;
  const colsSql = colDefs.map((c) => `"${c.name}" ${c.type}`).join(', ');

  db.exec('BEGIN TRANSACTION;');
  try {
    db.exec(`CREATE TABLE ${safeTable} (${colsSql});`);

    const placeholders = colDefs.map(() => '?').join(', ');
    const insertStmt = db.prepare(
      `INSERT INTO ${safeTable} (${colDefs.map((c) => `"${c.name}"`).join(', ')}) VALUES (${placeholders})`
    );

    for (const row of records.slice(0, 10000)) {
      const vals = colDefs.map((c) => {
        const raw = String(row[c.rawHeader] ?? '').trim();
        if (raw === '') return null;
        if (c.type === 'INTEGER') return Number.parseInt(raw.replace(/,/g, ''), 10);
        if (c.type === 'REAL') return Number.parseFloat(raw.replace(/,/g, ''));
        return raw;
      });
      insertStmt.run(...vals);
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const profile = getTableProfile(tableName);
  return {
    tableName,
    rowCount: Math.min(records.length, 10000),
    columns: colDefs.map(({ name, type }) => ({ name, type })),
    profile,
  };
}

export async function ingestDatasetBuffer(
  buffer: Buffer,
  originalFilename: string
): Promise<{
  tableName: string;
  rowCount: number;
  columns: Array<{ name: string; type: string }>;
  profile: TableProfile;
}> {
  const isExcel = /\.xlsx$/i.test(originalFilename);
  const records = isExcel
    ? await parseExcelBuffer(buffer)
    : (parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[]);

  if (records.length === 0) {
    throw new Error('Uploaded file contains no data rows.');
  }

  const baseName = originalFilename.replace(/\.(csv|xlsx)$/i, '');
  const result = insertRecordsIntoNewTable(records, baseName);
  await clearQueryCache();
  return result;
}

function tryExtractTableFromPdfText(text: string): Record<string, string>[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Detect pipe-separated or tab-separated or CSV-style tabular blocks
  for (const sep of ['|', '\t', ',']) {
    const candidateLines = lines.filter((l) => l.split(sep).length >= 3);
    if (candidateLines.length >= 3) {
      const headers = candidateLines[0]
        .split(sep)
        .map((h) => h.trim())
        .filter(Boolean);
      if (headers.length < 2) continue;

      const records: Record<string, string>[] = [];
      for (const rowLine of candidateLines.slice(1)) {
        const cells = rowLine.split(sep).map((c) => c.trim());
        if (cells.length !== headers.length) continue;
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => {
          obj[h] = cells[i] ?? '';
        });
        records.push(obj);
      }
      if (records.length >= 2) return records;
    }
  }
  return null;
}

export async function ingestPdfBuffer(
  buffer: Buffer,
  originalFilename: string
): Promise<{
  pdf: PdfDocSummary;
  extractedTable?: {
    tableName: string;
    rowCount: number;
    columns: Array<{ name: string; type: string }>;
    profile: TableProfile;
  };
}> {
  const parser = new PDFParse({ data: buffer });
  let text = '';
  let total = 1;
  try {
    const result = await parser.getText();
    text = (result.text || '').trim();
    total = result.total || 1;
  } finally {
    await parser.destroy().catch(() => {});
  }

  if (!text) {
    throw new Error('Could not extract readable text from this PDF.');
  }

  // Always save persistently without removing any previous CSV, Excel, or PDF files
  const pdf = savePdfDocument({
    filename: originalFilename,
    pageCount: total,
    extractedText: text,
  });

  // Bonus: if the PDF contains structured table lines, also materialize a SQL table
  const tableRecords = tryExtractTableFromPdfText(text);
  let extractedTable:
    | {
        tableName: string;
        rowCount: number;
        columns: Array<{ name: string; type: string }>;
        profile: TableProfile;
      }
    | undefined;

  if (tableRecords) {
    const baseName = `pdf_${originalFilename.replace(/\.pdf$/i, '')}`;
    extractedTable = insertRecordsIntoNewTable(tableRecords, baseName);
  }

  await clearQueryCache();
  return { pdf, extractedTable };
}

export async function deleteCustomTable(tableName: string): Promise<void> {
  if (PROTECTED_TABLES.has(tableName) || tableName.startsWith('_qc_')) {
    throw new Error('Built-in sample tables cannot be deleted.');
  }
  const clean = sanitizeIdentifier(tableName, '');
  if (!clean || clean !== tableName) {
    throw new Error('Invalid table name.');
  }
  const db = getWriteDb();
  db.exec(`DROP TABLE IF EXISTS "${clean}";`);
  await clearQueryCache();
}
