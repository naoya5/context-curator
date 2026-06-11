// render.ts — output helpers using picocolors (DESIGN.md §4.5)
import pc from 'picocolors';
import type { Finding } from '../types.js';

// ---------------------------------------------------------------------------
// Severity color map
// ---------------------------------------------------------------------------
export function severityColor(severity: Finding['severity']): (s: string) => string {
  switch (severity) {
    case 'high': return pc.red;
    case 'warn': return pc.yellow;
    case 'info': return pc.cyan;
  }
}

export function severityLabel(severity: Finding['severity']): string {
  return severityColor(severity)(severity.toUpperCase().padEnd(4));
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/** Pad a string to exactly `width` chars (truncates if longer) */
function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + ' '.repeat(width - s.length);
}

export interface TableRow {
  severity: Finding['severity'];
  type: string;
  name: string;
  kind: string;
  reason: string;
}

export function renderTable(rows: TableRow[]): string {
  if (rows.length === 0) return '';

  const lines: string[] = [];
  const header = `  ${pad('SEV ', 6)}${pad('TYPE', 10)}${pad('KIND', 12)}${pad('NAME', 30)}REASON`;
  lines.push(pc.dim(header));
  lines.push(pc.dim('  ' + '─'.repeat(80)));

  for (const row of rows) {
    const sev = severityColor(row.severity)(pad(row.severity.toUpperCase(), 6));
    const line = `  ${sev}${pad(row.type, 10)}${pad(row.kind, 12)}${pad(row.name, 30)}${row.reason}`;
    lines.push(line);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------
export function renderSectionHeader(title: string): string {
  return `\n${pc.bold(pc.blue(title))}\n${'─'.repeat(title.length + 2)}`;
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------
export function renderSummaryLine(
  total: number,
  highCount: number,
  warnCount: number,
): string {
  const parts: string[] = [];
  if (highCount > 0) parts.push(pc.red(`${highCount} high`));
  if (warnCount > 0) parts.push(pc.yellow(`${warnCount} warn`));
  const infoCount = total - highCount - warnCount;
  if (infoCount > 0) parts.push(pc.cyan(`${infoCount} info`));
  if (total === 0) return pc.green('  ✓ No findings.');
  return `  ${parts.join('  ')}  (${total} total)`;
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------
export function formatTokens(n: number): string {
  if (n >= 1000) {
    return `~${(n / 1000).toFixed(1)}K`;
  }
  return `~${n}`;
}

// ---------------------------------------------------------------------------
// JSON output helper
// ---------------------------------------------------------------------------
export function renderJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}
