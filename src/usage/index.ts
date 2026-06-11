// usage/index.ts — public API for the usage tracker module (DESIGN.md §4.2)
//
// Exported functions:
//   updateLedger(paths, transcriptFiles) → Promise<{newEvents, scannedFiles, skippedFiles}>
//   loadUsageStats(paths, opts?)         → Promise<UsageStats[]>
//
// Transcript file discovery is handled here: scans claudeDir/projects/*/*/*.jsonl

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ResolvedPaths } from '../paths.js';
import type { UsageStats } from '../types.js';
import {
  updateLedger as _updateLedger,
  loadUsageStats as _loadUsageStats,
  clearLedger,
} from './ledger.js';

export type { UpdateLedgerResult } from './ledger.js';

// Re-export for consumers that want the lower-level API
export { clearLedger };

// ── Transcript file discovery ─────────────────────────────────────────────────

/**
 * Discover all transcript .jsonl files under claudeDir/projects/
 * Structure: ~/.claude/projects/<dir-slug>/<sessionId>.jsonl
 */
async function discoverTranscripts(paths: ResolvedPaths): Promise<string[]> {
  const projectsDir = join(paths.claudeDir, 'projects');
  if (!existsSync(projectsDir)) return [];

  const results: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  for (const slug of projectDirs) {
    const slugDir = join(projectsDir, slug);
    let files: string[];
    try {
      files = await readdir(slugDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (file.endsWith('.jsonl')) {
        results.push(join(slugDir, file));
      }
    }
  }

  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Discover transcript files and incrementally update the ledger.
 */
export async function updateLedger(
  paths: ResolvedPaths,
): Promise<{ newEvents: number; scannedFiles: number; skippedFiles: number }> {
  const files = await discoverTranscripts(paths);
  return _updateLedger(paths, files);
}

/**
 * Load aggregated UsageStats from the ledger.
 * @param paths - Resolved paths
 * @param opts.days - Restrict to last N days (omit for all time)
 */
export async function loadUsageStats(
  paths: ResolvedPaths,
  opts?: { days?: number },
): Promise<UsageStats[]> {
  return _loadUsageStats(paths, opts);
}
