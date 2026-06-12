// history.ts — `curator cost --history` report (DESIGN.md §9.3)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from './cost.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface HistoryReportOptions {
  /** Max entries to show (newest first). Default: 30 */
  limit?: number;
  /** Return JSON output instead of text */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Sparkline helpers
// ---------------------------------------------------------------------------
const SPARK_CHARS = '▁▂▃▄▅▆▇█';

function scoreToSpark(score: number): string {
  // score 0-100 → index 0-7
  const idx = Math.min(7, Math.floor((Math.max(0, Math.min(100, score)) / 100) * 8));
  return SPARK_CHARS[idx] ?? '▁';
}

function buildSparkline(entries: HistoryEntry[]): string {
  return entries.map((e) => scoreToSpark(e.score)).join('');
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Core: read + deduplicate (last entry per day wins)
// ---------------------------------------------------------------------------
export function loadHistoryEntries(curatorHome: string, limit: number = 30): HistoryEntry[] {
  const historyPath = join(curatorHome, 'history.jsonl');
  if (!existsSync(historyPath)) return [];

  const raw = readFileSync(historyPath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  // Parse lines, skip broken ones
  const parsed: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (
        typeof entry.date === 'string' &&
        typeof entry.score === 'number' &&
        typeof entry.totalTokens === 'number' &&
        typeof entry.staleTokens === 'number'
      ) {
        parsed.push(entry);
      }
    } catch {
      // skip malformed lines silently
    }
  }

  // Same-day dedup: last entry per date wins
  const byDate = new Map<string, HistoryEntry>();
  for (const entry of parsed) {
    byDate.set(entry.date, entry); // later entries overwrite earlier
  }

  // Sort ascending by date, then take last `limit` entries (newest)
  const sorted = Array.from(byDate.values()).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  // Apply limit: keep the most recent N
  return sorted.slice(-limit);
}

// ---------------------------------------------------------------------------
// Build report
// ---------------------------------------------------------------------------
export function buildHistoryReport(
  curatorHome: string,
  opts: HistoryReportOptions = {},
): { text: string; json: object } {
  const limit = opts.limit ?? 30;
  const entries = loadHistoryEntries(curatorHome, limit);

  if (entries.length === 0) {
    const msg = '履歴がありません。curator cost を実行すると記録されます';
    return {
      text: msg,
      json: { entries: [], message: msg },
    };
  }

  // ---- JSON shape ----
  const jsonData = {
    entries: entries.map((e) => ({
      date: e.date,
      score: e.score,
      totalTokens: e.totalTokens,
      staleTokens: e.staleTokens,
      findingCount: e.findingCount ?? null,
    })),
  };

  // ---- Text table ----
  const lines: string[] = [];

  // Header
  lines.push('日付         score  total    stale');
  lines.push('──────────── ─────  ───────  ───────');

  for (const e of entries) {
    const date = e.date.padEnd(12);
    const score = String(e.score).padStart(5);
    const total = fmtTokens(e.totalTokens).padStart(7);
    const stale = fmtTokens(e.staleTokens).padStart(7);
    lines.push(`${date} ${score}  ${total}  ${stale}`);
  }

  // Sparkline (score, oldest → newest)
  lines.push('');
  lines.push(`スコア推移: ${buildSparkline(entries)}`);

  return {
    text: lines.join('\n'),
    json: jsonData,
  };
}
