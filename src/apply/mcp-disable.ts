// mcp-disable.ts — propose and apply per-project MCP server disabling (DESIGN.md §10.2)
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { McpMatrix, McpDisableProposal } from '../types.js';
import type { ResolvedPaths } from '../paths.js';
import { safeEditJson } from './claudejson.js';
import { appendJournal } from './journal.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read and parse a JSON file; return null on missing or parse error */
async function tryReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(filePath)) return null;
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Extract server names from a .mcp.json `mcpServers` map */
function serverNamesFromMcpJson(obj: Record<string, unknown>): string[] {
  const servers = obj['mcpServers'];
  if (servers == null || typeof servers !== 'object' || Array.isArray(servers)) return [];
  return Object.keys(servers as Record<string, unknown>);
}

/** Extract already-disabled server names from a settings.json object */
function alreadyDisabled(obj: Record<string, unknown>): Set<string> {
  const disabled = obj['disabledMcpjsonServers'];
  if (!Array.isArray(disabled)) return new Set();
  return new Set(disabled.filter((x): x is string => typeof x === 'string'));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan each projectDir for a `.mcp.json` and build disable proposals for
 * servers that have zero usage in the given project according to `matrix`.
 *
 * Rules:
 * - Only servers defined in the project's own `.mcp.json` are considered
 *   (global-only servers are excluded — DESIGN.md §10.2)
 * - Servers with usage > 0 in this project are skipped
 * - Servers already listed in `.claude/settings.json#disabledMcpjsonServers`
 *   are skipped (already handled)
 * - Projects whose `.mcp.json` is missing or unparseable are silently skipped
 */
export async function buildMcpDisableProposals(
  matrix: McpMatrix,
  projectDirs: string[],
): Promise<McpDisableProposal[]> {
  const proposals: McpDisableProposal[] = [];

  for (const projectDir of projectDirs) {
    const mcpJsonPath = join(projectDir, '.mcp.json');
    const mcpJson = await tryReadJson(mcpJsonPath);
    if (mcpJson === null) continue; // missing or unparseable — skip

    const definedServers = serverNamesFromMcpJson(mcpJson);
    if (definedServers.length === 0) continue;

    const settingsPath = join(projectDir, '.claude', 'settings.json');
    const settingsObj = await tryReadJson(settingsPath);
    const disabledSet = settingsObj ? alreadyDisabled(settingsObj) : new Set<string>();

    for (const serverName of definedServers) {
      // Already disabled — skip
      if (disabledSet.has(serverName)) continue;

      // Check usage in this project
      const usageCount = matrix.counts[serverName]?.[projectDir] ?? 0;
      if (usageCount > 0) continue;

      proposals.push({
        projectDir,
        serverName,
        mcpJsonPath,
        settingsPath,
        reason: `${basename(projectDir)} の .mcp.json で定義されているが使用記録なし`,
      });
    }
  }

  return proposals;
}

/**
 * Apply a single McpDisableProposal:
 * - Append `serverName` to `disabledMcpjsonServers` in the project's
 *   `.claude/settings.json` (create if absent)
 * - Write a journal entry with op 'mcp-disable'
 *
 * Follows §8.2 safety rules via safeEditJson (backup + atomic write).
 */
export async function applyMcpDisable(
  paths: ResolvedPaths,
  proposal: McpDisableProposal,
): Promise<void> {
  const { serverName, settingsPath, projectDir } = proposal;
  const backupDir = join(paths.curatorHome, 'backups');

  // 1. Append to disabledMcpjsonServers with backup + atomic write
  await safeEditJson(settingsPath, backupDir, (obj) => {
    const existing = obj['disabledMcpjsonServers'];
    const arr: string[] = Array.isArray(existing)
      ? (existing as string[]).filter((x): x is string => typeof x === 'string')
      : [];

    // Idempotent: skip if already present
    if (!arr.includes(serverName)) {
      arr.push(serverName);
    }
    obj['disabledMcpjsonServers'] = arr;
  });

  // 2. Journal entry
  const ts = new Date().toISOString();
  // archiveId format: mcp-disable-<YYYYMMDD-HHmmss>-<server>
  const tsCompact = ts.replace(/[-:T]/g, '').slice(0, 15).replace(/(\d{8})(\d{6}).*/, '$1-$2');
  const archiveId = `mcp-disable-${tsCompact}-${serverName}`;

  await appendJournal(paths.curatorHome, {
    ts,
    op: 'mcp-disable',
    archiveId,
    assetId: `mcp-server:${serverName}`,
    detail: `settingsPath:${settingsPath} projectDir:${projectDir}`,
  });
}
