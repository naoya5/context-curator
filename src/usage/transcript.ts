// transcript.ts — JSONL stream parser (DESIGN.md §4.2)
// Reads transcript files line-by-line using node:readline (never loads full file into memory).
// Broken lines are skipped and counted; they never cause crashes.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface TranscriptLine {
  /** Raw parsed JSON object */
  raw: unknown;
  /** Line number (1-based) */
  lineNumber: number;
}

export interface ParseResult {
  lines: TranscriptLine[];
  skippedCount: number;
  totalLines: number;
}

/**
 * Parse a JSONL transcript file as a stream.
 * Returns all successfully parsed lines.
 * Broken/unparseable lines are counted in skippedCount and not thrown.
 *
 * @param filePath - Absolute path to the .jsonl file
 * @param startLine - Skip lines before this (1-based, default: 1 = read all)
 */
export async function parseTranscript(
  filePath: string,
  startLine = 1,
): Promise<ParseResult> {
  const lines: TranscriptLine[] = [];
  let skippedCount = 0;
  let totalLines = 0;

  const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    totalLines++;

    // Skip lines before startLine
    if (totalLines < startLine) {
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed === '') {
      // empty lines: skip silently
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      lines.push({ raw: parsed, lineNumber: totalLines });
    } catch {
      // Broken JSON: count as skipped, never crash
      skippedCount++;
    }
  }

  return { lines, skippedCount, totalLines };
}
