import { PdfDocFull } from '../db/database.js';
import { getActiveProviderInfo } from './llm.js';

export interface PdfMatchExcerpt {
  filename: string;
  page_count: number;
  score: number;
  excerpt: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function findRelevantPdfExcerpts(
  question: string,
  pdfs: PdfDocFull[],
  topK = 5
): PdfMatchExcerpt[] {
  const qTokens = new Set(tokenize(question));
  const qLower = question.toLowerCase();
  const candidates: PdfMatchExcerpt[] = [];

  for (const doc of pdfs) {
    const fileMatchBonus = qLower.includes(doc.filename.toLowerCase().replace(/\.pdf$/i, ''))
      ? 5
      : 0;
    const chunks = doc.extracted_text
      .split(/\n{2,}|(?<=[.!?])\s+/)
      .map((c) => c.trim())
      .filter((c) => c.length > 15);

    for (const chunk of chunks) {
      const cTokens = tokenize(chunk);
      let score = fileMatchBonus;
      for (const ct of cTokens) {
        if (qTokens.has(ct)) score += 2;
      }
      if (score > 0 || qLower.includes('pdf') || qLower.includes('summarize')) {
        candidates.push({
          filename: doc.filename,
          page_count: doc.page_count,
          score: Math.max(score, 1),
          excerpt: chunk.slice(0, 320),
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, topK);
}

export async function summarizePdfAnswer(
  question: string,
  excerpts: PdfMatchExcerpt[]
): Promise<string> {
  if (excerpts.length === 0) {
    return 'No matching excerpts were found in your uploaded PDF documents.';
  }

  const aiInfo = getActiveProviderInfo();
  if (aiInfo.provider === 'gemini' && process.env.GEMINI_API_KEY) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${aiInfo.model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const context = excerpts
        .map((e, i) => `[${i + 1}] (${e.filename}): ${e.excerpt}`)
        .join('\n');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text: `Answer the question concisely in 2 sentences using ONLY these uploaded PDF excerpts. Cite filenames.\n\nExcerpts:\n${context}\n\nQuestion: ${question}`,
                },
              ],
            },
          ],
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return text;
      }
    } catch {
      // Fallback to deterministic excerpt summary
    }
  }

  const top = excerpts[0];
  return `Matched ${excerpts.length} excerpt(s) from ${top.filename}: "${top.excerpt}"`;
}
