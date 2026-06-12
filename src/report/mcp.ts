// report/mcp.ts — MCP active-set report builder (DESIGN.md §9.2)
//
// Builds a text + JSON report from a McpMatrix and an Asset list.
// Read-only: no writes.

import { basename } from 'node:path';
import type { Asset, McpMatrix } from '../types.js';

export interface McpReportOptions {
  /** Show all projects (default: top 8 by usage) */
  all?: boolean;
  /** Return JSON-friendly object alongside text */
  json?: boolean;
}

export interface McpReportResult {
  text: string;
  json: object;
}

/**
 * Build a MCP active-set report.
 *
 * @param matrix - McpMatrix from loadMcpMatrix()
 * @param assets - Full asset list from buildInventory()
 * @param opts   - Display options
 */
export function buildMcpReport(
  matrix: McpMatrix,
  assets: Asset[],
  opts: McpReportOptions = {},
): McpReportResult {
  // ── Project selection ────────────────────────────────────────────────────
  const MAX_PROJECTS = 8;
  const allProjects = matrix.projects; // already sorted desc by total
  const displayProjects = opts.all ? allProjects : allProjects.slice(0, MAX_PROJECTS);

  // ── Server categorization ─────────────────────────────────────────────────
  // Global inventory servers (scope='user' or scope='plugin', kind='mcp-server')
  const globalInventoryServers = assets
    .filter((a) => a.kind === 'mcp-server' && (a.scope === 'user' || a.scope === 'plugin'))
    .map((a) => a.name);
  const globalInventorySet = new Set(globalInventoryServers);

  // Servers that appear in ledger but NOT in inventory (deleted etc.)
  const ledgerOnlyServers = matrix.servers.filter((s) => !globalInventorySet.has(s));

  // All server rows: global inventory first (sorted), then ledger-only
  const inventoryRows = [...globalInventorySet].sort();
  const allServerRows = [...inventoryRows, ...ledgerOnlyServers.sort()];

  // ── Text report ───────────────────────────────────────────────────────────
  const lines: string[] = [];

  // Header
  lines.push('MCP Active-Set Report');
  lines.push('═'.repeat(60));

  if (displayProjects.length === 0) {
    lines.push('(No MCP tool usage recorded in ledger.)');
  } else {
    // Table header
    const colW = 12; // column width for project labels
    const serverColW = 30;
    const headerCells = displayProjects.map((p) => p.label.slice(0, colW - 1).padEnd(colW));
    lines.push(`${'Server'.padEnd(serverColW)} ${headerCells.join(' ')}`);
    lines.push('─'.repeat(serverColW + 1 + displayProjects.length * (colW + 1)));

    for (const server of allServerRows) {
      const isLedgerOnly = !globalInventorySet.has(server);
      const rowLabel = isLedgerOnly ? `(定義なし) ${server}` : server;
      const cells = displayProjects.map((p) => {
        const count = matrix.counts[server]?.[p.cwd] ?? 0;
        return (count === 0 ? '-' : String(count)).padEnd(colW);
      });
      lines.push(`${rowLabel.slice(0, serverColW - 1).padEnd(serverColW)} ${cells.join(' ')}`);
    }

    if (!opts.all && allProjects.length > MAX_PROJECTS) {
      lines.push('');
      lines.push(`(${allProjects.length - MAX_PROJECTS} more projects hidden — use --all to show all)`);
    }
  }

  // ── Suggestions section ───────────────────────────────────────────────────
  const suggestions: Array<{ project: string; server: string; hint: string }> = [];

  for (const proj of displayProjects) {
    for (const server of inventoryRows) {
      const count = matrix.counts[server]?.[proj.cwd] ?? 0;
      if (count === 0) {
        suggestions.push({
          project: proj.cwd,
          server,
          hint:
            `${proj.label} では ${server} が未使用 → このプロジェクトでの無効化・整理を検討` +
            `（定義元は \`claude mcp list\` で確認。プロジェクト .mcp.json のサーバーなら ` +
            `.claude/settings.json の disabledMcpjsonServers で無効化可能）`,
        });
      }
    }
  }

  if (suggestions.length > 0) {
    lines.push('');
    lines.push('提案 (未使用サーバーの無効化候補)');
    lines.push('─'.repeat(60));
    for (const s of suggestions) {
      lines.push(`• ${s.hint}`);
    }
    lines.push('');
    lines.push('注: v0.3 は表示のみ。自動編集は将来の apply 拡張で承認制として提供予定。');
  }

  // ── JSON output ───────────────────────────────────────────────────────────
  const jsonOutput = {
    servers: allServerRows.map((server) => ({
      name: server,
      inInventory: globalInventorySet.has(server),
    })),
    projects: displayProjects,
    counts: matrix.counts,
    suggestions: suggestions.map((s) => ({
      project: s.project,
      projectLabel: basename(s.project),
      server: s.server,
    })),
    truncated: !opts.all && allProjects.length > MAX_PROJECTS
      ? { shown: MAX_PROJECTS, total: allProjects.length }
      : null,
  };

  return {
    text: lines.join('\n'),
    json: jsonOutput,
  };
}
