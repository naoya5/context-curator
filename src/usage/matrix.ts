// matrix.ts — MCP usage matrix builder (DESIGN.md §9.2)
//
// Reads ledger.jsonl and aggregates kind==='mcp-tool' events into a McpMatrix.
// Read-only: no writes to ledger or any file.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { UsageEvent, McpMatrix } from '../types.js';
import type { ResolvedPaths } from '../paths.js';

function ledgerPath(paths: ResolvedPaths): string {
  return join(paths.curatorHome, 'ledger.jsonl');
}

/**
 * Load the raw ledger file and return all mcp-tool events.
 * Respects optional days window (same semantics as loadUsageStats).
 */
async function loadMcpEvents(
  paths: ResolvedPaths,
  opts?: { days?: number },
): Promise<UsageEvent[]> {
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

  const events: UsageEvent[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: UsageEvent;
    try {
      event = JSON.parse(trimmed) as UsageEvent;
    } catch {
      continue;
    }

    // Validate minimal shape
    if (
      typeof event.ts !== 'string' ||
      typeof event.kind !== 'string' ||
      typeof event.ref !== 'string' ||
      typeof event.cwd !== 'string'
    ) {
      continue;
    }

    // Only mcp-tool events
    if (event.kind !== 'mcp-tool') continue;

    // Apply date filter
    if (cutoff) {
      try {
        const eventDate = new Date(event.ts);
        if (eventDate < cutoff) continue;
      } catch {
        continue;
      }
    }

    events.push(event);
  }

  return events;
}

/**
 * Build a McpMatrix from ledger events.
 *
 * @param paths - Resolved paths (reads from curatorHome/ledger.jsonl)
 * @param opts.days - Restrict to events from the last N days (omit for all time)
 */
export async function loadMcpMatrix(
  paths: ResolvedPaths,
  opts?: { days?: number },
): Promise<McpMatrix> {
  const events = await loadMcpEvents(paths, opts);

  // Aggregate: counts[server][cwd] = count
  const counts: Record<string, Record<string, number>> = {};
  // Track total per cwd for ordering
  const cwdTotals: Record<string, number> = {};

  for (const event of events) {
    const server = event.ref;
    const cwd = event.cwd;

    if (!counts[server]) counts[server] = {};
    counts[server][cwd] = (counts[server][cwd] ?? 0) + 1;

    cwdTotals[cwd] = (cwdTotals[cwd] ?? 0) + 1;
  }

  // Build servers list (unique servers seen in events)
  const servers = Object.keys(counts).sort();

  // Build projects list ordered by total desc
  const projects = Object.entries(cwdTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([cwd, total]) => ({
      cwd,
      label: basename(cwd),
      total,
    }));

  return { servers, projects, counts };
}

/**
 * List all unique cwd values from ledger events (any kind) that exist on disk.
 * Used by --all-projects to discover project directories.
 *
 * @param paths - Resolved paths
 */
export async function listKnownProjectDirs(paths: ResolvedPaths): Promise<string[]> {
  const file = ledgerPath(paths);
  if (!existsSync(file)) return [];

  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch {
    return [];
  }

  const cwdSet = new Set<string>();

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: UsageEvent;
    try {
      event = JSON.parse(trimmed) as UsageEvent;
    } catch {
      continue;
    }

    if (typeof event.cwd === 'string' && event.cwd) {
      cwdSet.add(event.cwd);
    }
  }

  // Filter to only existing directories
  return Array.from(cwdSet).filter((cwd) => existsSync(cwd));
}
