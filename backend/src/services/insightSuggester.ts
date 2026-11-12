import { listPdfDocuments, listUserTablesAsync, TableSchema } from '../db/database.js';

const CORE_TABLES = new Set(['users', 'products', 'orders', 'order_items']);

const DEFAULT_CORE_QUESTIONS = [
  'Show monthly revenue trend',
  'Compare revenue by product category',
  'Show revenue by city',
  'Which payment method has the highest revenue?',
];

function isNumericCol(type: string): boolean {
  return /INT|REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL/i.test(type);
}

function isIdColumn(name: string): boolean {
  return /^id$|_id$/i.test(name);
}

function buildQuestionsForTable(table: TableSchema): string[] {
  const cols = table.columns;
  const numericCols = cols.filter((c) => isNumericCol(c.type) && !isIdColumn(c.name));
  const textCols = cols.filter((c) => !isNumericCol(c.type) && !isIdColumn(c.name));
  const timeCol = cols.find((c) => /date|month|year|quarter|week|period/i.test(c.name));

  const metric = numericCols[0]?.name;
  const secondMetric = numericCols[1]?.name;
  const dim1 = textCols.find((c) => c.name !== timeCol?.name)?.name || textCols[0]?.name;
  const dim2 = textCols.find((c) => c.name !== timeCol?.name && c.name !== dim1)?.name;

  const questions: string[] = [];

  if (timeCol && metric) {
    questions.push(`Show ${metric} trend by ${timeCol.name} in ${table.name}`);
  }
  if (dim1 && metric) {
    questions.push(`Compare ${metric} by ${dim1} in ${table.name}`);
    questions.push(`Top 5 ${dim1} by ${metric} in ${table.name}`);
  }
  if (dim2 && metric) {
    questions.push(`Break down ${metric} by ${dim2} in ${table.name}`);
  } else if (dim1 && secondMetric) {
    questions.push(`Compare ${secondMetric} by ${dim1} in ${table.name}`);
  } else if (dim1) {
    questions.push(`Count records by ${dim1} in ${table.name}`);
  }

  if (questions.length < 4) {
    questions.push(`Show summary from ${table.name}`);
  }

  return questions.slice(0, 4);
}

export async function suggestInsightQuestions(preferredTable?: string): Promise<{
  targetSource: string;
  questions: string[];
}> {
  const tables = await listUserTablesAsync();
  const pdfs = listPdfDocuments();

  const customTables = tables.filter((t) => !CORE_TABLES.has(t.name));
  const chosenTable =
    (preferredTable && tables.find((t) => t.name === preferredTable)) ||
    customTables[customTables.length - 1];

  if (chosenTable && !CORE_TABLES.has(chosenTable.name)) {
    const questions = buildQuestionsForTable(chosenTable);
    if (pdfs.length > 0 && questions.length < 4) {
      questions.push(`Summarize ${pdfs[pdfs.length - 1].filename}`);
    }
    return { targetSource: chosenTable.name, questions: questions.slice(0, 4) };
  }

  const questions = [...DEFAULT_CORE_QUESTIONS];
  if (pdfs.length > 0) {
    questions[3] = `Summarize ${pdfs[pdfs.length - 1].filename}`;
  }
  return { targetSource: 'ecommerce_core', questions };
}
