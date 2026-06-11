// ledger.ts — incremental ledger accumulation + UsageStats aggregation (DESIGN.md §4.2)
//
// Files:
//   ~/.curator/ledger.jsonl  — append-only UsageEvent log
//   ~/.curator/state.json    — { [filePath]: { mtimeMs, size, lineCount } }
//
// Incremental logic:
//   - mtime + size unchanged → skip (already processed)
//   - size larger (append) → read from lineCount+1 onwards
//   - size smaller (shrink) → full re-read from line 1
//
// Write order: ledger written BEFORE state (safe on crash; may re-process but no duplicates lost)

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageEvent, UsageStats } from '../types.js';
import type { ResolvedPaths } from '../paths.js';
import { parseTranscript } from './transcript.js';
import { extractEventsFromLines } from './extract.js';

// ── State types ──────────────────────────────────────────────────────────────

export interface FileState {
  mtimeMs: number;
  size: number;
  lineCount: number;
}

export type LedgerState = Record<string, FileState>;

// ── Paths helpers ────────────────────────────────────────────────────────────

function ledgerPath(paths: ResolvedPaths): string {
  return join(paths.curatorHome, 'ledger.jsonl');
}

function statePath(paths: ResolvedPaths): string {
  return join(paths.curatorHome, 'state.json');
}

// ── State I/O ────────────────────────────────────────────────────────────────

async function loadState(paths: ResolvedPaths): Promise<LedgerState> {
  const file = statePath(paths);
  try {
    const raw = await readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as LedgerState;
    }
  } catch {
    // Missing or corrupt state → start fresh
  }
  return {};
}

async function saveState(paths: ResolvedPaths, state: LedgerState): Promise<void> {
  await ensureCuratorHome(paths);
  await writeFile(statePath(paths), JSON.stringify(state, null, 2), 'utf-8');
}

async function ensureCuratorHome(paths: ResolvedPaths): Promise<void> {
  await mkdir(paths.curatorHome, { recursive: true });
}

// ── Ledger I/O ───────────────────────────────────────────────────────────────

async function appendToLedger(paths: ResolvedPaths, events: UsageEvent[]): Promise<void> {
  if (events.length === 0) return;
  await ensureCuratorHome(paths);
  const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  await appendFile(ledgerPath(paths), lines, 'utf-8');
}

// ── updateLedger ─────────────────────────────────────────────────────────────

export interface UpdateLedgerResult {
  newEvents: number;
  scannedFiles: number;
  skippedFiles: number;
}

/**
 * Scan transcript files and incrementally append new UsageEvents to the ledger.
 * @param paths - Resolved paths (uses claudeDir for transcripts, curatorHome for ledger)
 * @param transcriptFiles - List of absolute paths to .jsonl transcript files
 */
export async function updateLedger(
  paths: ResolvedPaths,
  transcriptFiles: string[],
): Promise<UpdateLedgerResult> {
  const state = await loadState(paths);
  let newEvents = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;

  for (const filePath of transcriptFiles) {
    // Get current file stats
    let stat: { mtimeMs: number; size: number };
    try {
      const s = statSync(filePath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      // File disappeared: skip
      skippedFiles++;
      continue;
    }

    const prev = state[filePath];

    // mtime + size unchanged → already processed
    if (prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) {
      skippedFiles++;
      continue;
    }

    scannedFiles++;

    // Determine start line
    let startLine = 1;
    if (prev && stat.size > prev.size) {
      // File grew (append) → only read new lines
      startLine = prev.lineCount + 1;
    }
    // If file shrunk (prev.size > stat.size) → startLine = 1 (full re-read)

    // Parse transcript (stream, never full load)
    let parseResult: Awaited<ReturnType<typeof parseTranscript>>;
    try {
      parseResult = await parseTranscript(filePath, startLine);
    } catch {
      // Unreadable file → skip
      skippedFiles++;
      scannedFiles--;
      continue;
    }

    // Extract events
    const { events } = extractEventsFromLines(parseResult.lines);

    // Write ledger BEFORE updating state (crash-safe)
    await appendToLedger(paths, events);

    // Update state: lineCount is the total lines now in the file
    // If we did a partial read (append case), total = prev.lineCount + lines read
    // If we did a full re-read, total = parseResult.totalLines
    const totalLineCount =
      startLine > 1 && prev
        ? prev.lineCount + parseResult.totalLines
        : parseResult.totalLines;

    state[filePath] = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lineCount: totalLineCount,
    };

    newEvents += events.length;
  }

  // Save updated state
  await saveState(paths, state);

  return { newEvents, scannedFiles, skippedFiles };
}

/**
 * Clear the ledger and state (for --rebuild).
 */
export async function clearLedger(paths: ResolvedPaths): Promise<void> {
  await ensureCuratorHome(paths);
  // Overwrite both files with empty content
  await writeFile(ledgerPath(paths), '', 'utf-8');
  await writeFile(statePath(paths), '{}', 'utf-8');
}

// ── loadUsageStats ────────────────────────────────────────────────────────────

/**
 * Load all UsageEvents from ledger.jsonl and aggregate into UsageStats[].
 * @param paths - Resolved paths
 * @param opts.days - If provided, only events from the last N days are counted
 */
export async function loadUsageStats(
  paths: ResolvedPaths,
  opts?: { days?: number },
): Promise<UsageStats[]> {
  const file = ledgerPath(paths);
  if (!existsSync(file)) return [];

  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return [];
  }

  const cutoff =
    opts?.days != null
      ? new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000)
      : null;

  // Map: `${kind}::${ref}` → aggregation bucket
  const buckets = new Map<
    string,
    { ref: string; kind: UsageEvent['kind']; count: number; lastUsed: string | null; projectSet: Set<string> }
  >();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: UsageEvent;
    try {
      event = JSON.parse(trimmed) as UsageEvent;
    } catch {
      continue; // skip broken ledger lines
    }

    // Validate minimal shape
    if (
      typeof event.ts !== 'string' ||
      typeof event.kind !== 'string' ||
      typeof event.ref !== 'string'
    ) {
      continue;
    }

    // Apply date filter
    if (cutoff) {
      try {
        const eventDate = new Date(event.ts);
        if (eventDate < cutoff) continue;
      } catch {
        continue;
      }
    }

    const key = `${event.kind}::${event.ref}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        ref: event.ref,
        kind: event.kind as UsageEvent['kind'],
        count: 0,
        lastUsed: null,
        projectSet: new Set(),
      };
      buckets.set(key, bucket);
    }

    bucket.count++;

    // Track most recent usage
    if (!bucket.lastUsed || event.ts > bucket.lastUsed) {
      bucket.lastUsed = event.ts;
    }

    // Track unique projects (cwd)
    if (typeof event.cwd === 'string' && event.cwd) {
      bucket.projectSet.add(event.cwd);
    }
  }

  // Convert to UsageStats[]
  return Array.from(buckets.values()).map(b => ({
    ref: b.ref,
    kind: b.kind,
    count: b.count,
    lastUsed: b.lastUsed,
    projects: Array.from(b.projectSet),
  }));
}
