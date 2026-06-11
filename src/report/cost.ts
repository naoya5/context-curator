// cost.ts — `curator cost` Context Health Report (DESIGN.md §4.5)
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import pc from 'picocolors';
import type { Asset, Finding } from '../types.js';
import { formatTokens, renderJson } from './render.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface CostReportOptions {
  /** Output JSON instead of colored text */
  json?: boolean;
  /** curatorHome for history.jsonl. If omitted, history is not written. */
  curatorHome?: string;
  /** Override today's date string (for tests) */
  dateLabel?: string;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------
export interface CostReportResult {
  text: string;
  json: object;
  score: number;
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------
/**
 * Context Health Score = 100 - round(staleFootprintTokens / totalFootprintTokens * 100)
 * "stale/unused 両方の footprint を「stale資産の寄与」に含める"
 * If totalFootprintTokens is 0, score is 100.
 */
export function computeScore(
  totalFootprintTokens: number,
  staleFootprintTokens: number,
): number {
  if (totalFootprintTokens === 0) return 100;
  return 100 - Math.round((staleFootprintTokens / totalFootprintTokens) * 100);
}

// ---------------------------------------------------------------------------
// History append
// ---------------------------------------------------------------------------
export interface HistoryEntry {
  date: string;
  score: number;
  totalTokens: number;
  staleTokens: number;
  findingCount: number;
}

export function appendHistory(curatorHome: string, entry: HistoryEntry): void {
  const historyPath = join(curatorHome, 'history.jsonl');
  // Ensure directory exists
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, JSON.stringify(entry) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Kind grouping for display
// ---------------------------------------------------------------------------
interface KindGroup {
  label: string;
  tokens: number;
  count: number;
  unknown: boolean;
}

function groupByKind(assets: Asset[]): KindGroup[] {
  const groups: Record<string, KindGroup> = {};

  for (const a of assets) {
    let label: string;
    let tokens: number;
    let unknown = false;

    switch (a.kind) {
      case 'claude-md':
        label = 'CLAUDE.md';
        tokens = a.footprintTokens;
        break;
      case 'memory':
        label = 'memory';
        tokens = a.footprintTokens;
        break;
      case 'skill':
        label = 'skills frontmatter';
        tokens = a.footprintTokens;
        break;
      case 'mcp-server':
        label = 'MCP servers';
        tokens = 0;
        unknown = true;
        break;
      case 'command':
        label = 'commands';
        tokens = a.footprintTokens;
        break;
      case 'agent':
        label = 'agents';
        tokens = a.footprintTokens;
        break;
      default:
        label = a.kind;
        tokens = a.footprintTokens;
    }

    if (!groups[label]) {
      groups[label] = { label, tokens: 0, count: 0, unknown };
    }
    groups[label]!.tokens += tokens;
    groups[label]!.count += 1;
    if (unknown) groups[label]!.unknown = true;
  }

  return Object.values(groups);
}

// ---------------------------------------------------------------------------
// buildCostReport
// ---------------------------------------------------------------------------
export function buildCostReport(
  assets: Asset[],
  findings: Finding[],
  opts: CostReportOptions = {},
): CostReportResult {
  const dateLabel = opts.dateLabel ?? new Date().toISOString().slice(0, 10);

  // Stale asset ids (stale OR unused findings)
  const staleIds = new Set<string>(
    findings
      .filter((f) => f.type === 'stale' || f.type === 'unused')
      .map((f) => f.asset.id),
  );

  // Total footprint (all assets, exclude mcp-server since unknown)
  const totalFootprintTokens = assets
    .filter((a) => a.kind !== 'mcp-server')
    .reduce((sum, a) => sum + a.footprintTokens, 0);

  // Stale footprint (stale/unused assets, exclude mcp-server)
  const staleFootprintTokens = assets
    .filter((a) => a.kind !== 'mcp-server' && staleIds.has(a.id))
    .reduce((sum, a) => sum + a.footprintTokens, 0);

  const score = computeScore(totalFootprintTokens, staleFootprintTokens);

  // Score bar (simple ASCII)
  const scoreBar = buildScoreBar(score);

  // Kind groups for display
  const kindGroups = groupByKind(assets);

  // ---- Build JSON object ----
  const jsonData = {
    date: dateLabel,
    score,
    totalFootprintTokens,
    staleFootprintTokens,
    stalePercent: totalFootprintTokens > 0
      ? Math.round((staleFootprintTokens / totalFootprintTokens) * 100)
      : 0,
    findingCount: findings.length,
    byKind: kindGroups.map((g) => ({
      label: g.label,
      count: g.count,
      tokens: g.unknown ? null : g.tokens,
    })),
  };

  if (opts.json) {
    return { text: renderJson(jsonData), json: jsonData, score };
  }

  // ---- Build text output ----
  const WIDTH = 50;
  const divider = '═'.repeat(WIDTH);
  const separator = '─'.repeat(WIDTH - 2);

  const lines: string[] = [];
  lines.push('');
  lines.push(pc.bold(`Context Health Report (${dateLabel})`));
  lines.push(divider);
  lines.push(pc.dim('起動時コンテキスト寄与（常時ロード分・推定）'));
  lines.push('');

  // Sort groups: claude-md first, mcp-server last
  const ORDER: Record<string, number> = {
    'CLAUDE.md': 0,
    'memory': 1,
    'skills frontmatter': 2,
    'commands': 3,
    'agents': 4,
    'MCP servers': 10,
  };
  kindGroups.sort(
    (a, b) => (ORDER[a.label] ?? 5) - (ORDER[b.label] ?? 5),
  );

  for (const group of kindGroups) {
    const countSuffix = group.count > 1 ? ` × ${group.count}` : '';
    const labelStr = `  ${group.label}${countSuffix}`;
    const tokenStr = group.unknown
      ? '(unknown — tool定義は実測不能)'
      : formatTokens(group.tokens) + ' tokens';
    lines.push(`${labelStr.padEnd(36)}${pc.cyan(tokenStr)}`);
  }

  lines.push(`  ${'─'.repeat(separator.length)}`);
  lines.push(`  ${'合計（推定可能分）'.padEnd(26)}${pc.bold(pc.cyan(formatTokens(totalFootprintTokens) + ' tokens'))}`);
  lines.push('');

  const stalePct = jsonData.stalePercent;
  lines.push(
    `  うち stale/unused 資産の寄与:  ${pc.yellow(formatTokens(staleFootprintTokens) + ' tokens')} (${stalePct}%)`,
  );
  lines.push('');

  // Score display
  const scoreColor = score >= 80 ? pc.green : score >= 50 ? pc.yellow : pc.red;
  lines.push(`  Context Health Score: ${scoreColor(pc.bold(`${score}/100`))}  ${scoreBar}`);
  lines.push('');

  return { text: lines.join('\n'), json: jsonData, score };
}

// ---------------------------------------------------------------------------
// Score bar helper
// ---------------------------------------------------------------------------
function buildScoreBar(score: number): string {
  const total = 20;
  const filled = Math.round((score / 100) * total);
  const empty = total - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  if (score >= 80) return pc.green(`[${bar}]`);
  if (score >= 50) return pc.yellow(`[${bar}]`);
  return pc.red(`[${bar}]`);
}
