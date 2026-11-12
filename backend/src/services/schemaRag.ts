import { listUserTables, listUserTablesAsync, TableSchema } from '../db/database.js';

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Computes lightweight BM25-style / token-overlap relevance between a user's
 * natural-language question and each table's schema + sample rows.
 * Also supports optional vector similarity when external embeddings are enabled.
 */
export async function retrieveRelevantTablesAsync(
  question: string,
  topK = 6
): Promise<{
  selected: TableSchema[];
  allTableNames: string[];
  schemaVersion: string;
}> {
  const allTables = await listUserTablesAsync();
  return rankTables(question, allTables, topK);
}

export function retrieveRelevantTables(question: string, topK = 4): {
  selected: TableSchema[];
  allTableNames: string[];
  schemaVersion: string;
} {
  return rankTables(question, listUserTables(), topK);
}

function rankTables(question: string, allTables: TableSchema[], topK: number) {
  const schemaVersion = allTables
    .map((t) => `${t.name}:${t.columns.length}:${t.rowCount}`)
    .join('|');

  if (allTables.length <= topK) {
    return {
      selected: allTables,
      allTableNames: allTables.map((t) => t.name),
      schemaVersion,
    };
  }

  const queryTokens = new Set(tokenize(question));
  const scored = allTables.map((table) => {
    const docText = [
      table.name,
      table.name.replace(/_/g, ' '),
      ...table.columns.flatMap((c) => [c.name, c.name.replace(/_/g, ' '), c.type]),
      ...table.sampleRows.flatMap((r) => Object.values(r).map(String)),
    ].join(' ');

    const docTokens = tokenize(docText);
    let score = 0;
    for (const dt of docTokens) {
      if (queryTokens.has(dt)) score += 2;
      for (const qt of queryTokens) {
        if (dt.includes(qt) || qt.includes(dt)) score += 0.5;
      }
    }
    // Slight boost for core fact tables when joins might be needed
    if (table.columns.some((c) => c.name.endsWith('_id'))) {
      score += 0.25;
    }
    return { table, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    selected: scored.slice(0, topK).map((s) => s.table),
    allTableNames: allTables.map((t) => t.name),
    schemaVersion,
  };
}

export function formatSchemaForPrompt(tables: TableSchema[]): string {
  return tables
    .map((t) => {
      const cols = t.columns
        .map((c) => `  - ${c.name} (${c.type}${c.pk ? ', PRIMARY KEY' : ''})`)
        .join('\n');
      const samples =
        t.sampleRows.length > 0
          ? `  Sample rows: ${JSON.stringify(t.sampleRows.slice(0, 2))}`
          : '';
      return `TABLE ${t.name} (${t.rowCount} rows):\n${cols}\n${samples}`;
    })
    .join('\n\n');
}
