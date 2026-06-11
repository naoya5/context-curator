// check.ts — `curator check` report builder (DESIGN.md §4.5)
import type { Finding, FindingType } from '../types.js';
import {
  renderSectionHeader,
  renderTable,
  renderSummaryLine,
  renderJson,
  type TableRow,
} from './render.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface CheckReportOptions {
  /** Only show findings of this type (e.g. 'stale') */
  filter?: FindingType;
  /** Output JSON instead of colored text */
  json?: boolean;
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------
export interface CheckReportResult {
  text: string;
  exitCode: number; // 1 if any 'high' severity finding, else 0
}

// ---------------------------------------------------------------------------
// buildCheckReport
// ---------------------------------------------------------------------------
export function buildCheckReport(
  findings: Finding[],
  opts: CheckReportOptions = {},
): CheckReportResult {
  // Apply optional filter
  const filtered = opts.filter
    ? findings.filter((f) => f.type === opts.filter)
    : findings;

  // Determine exit code (high severity → 1)
  // We check on the *full* findings list regardless of filter to be consistent,
  // but the spec says "high が1件以上で exitCode 1" — use full list.
  const hasHigh = findings.some((f) => f.severity === 'high');
  const exitCode = hasHigh ? 1 : 0;

  // JSON path
  if (opts.json) {
    const data = filtered.map((f) => ({
      type: f.type,
      severity: f.severity,
      kind: f.asset.kind,
      name: f.asset.name,
      id: f.asset.id,
      reason: f.reason,
      suggestion: f.suggestion,
    }));
    return { text: renderJson(data), exitCode };
  }

  // Group by FindingType
  const groups = new Map<FindingType, Finding[]>();
  for (const f of filtered) {
    if (!groups.has(f.type)) groups.set(f.type, []);
    groups.get(f.type)!.push(f);
  }

  const ORDER: FindingType[] = ['zombie', 'stale', 'unused', 'bloated'];
  const lines: string[] = [];

  for (const type of ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;

    lines.push(renderSectionHeader(`${type.toUpperCase()} (${group.length})`));

    const rows: TableRow[] = group.map((f) => ({
      severity: f.severity,
      type: f.type,
      name: f.asset.name,
      kind: f.asset.kind,
      reason: f.reason,
    }));
    lines.push(renderTable(rows));

    // Print suggestions
    for (const f of group) {
      lines.push(`    → ${f.suggestion}`);
    }
  }

  // Summary
  const highCount = filtered.filter((f) => f.severity === 'high').length;
  const warnCount = filtered.filter((f) => f.severity === 'warn').length;
  lines.push('');
  lines.push(renderSummaryLine(filtered.length, highCount, warnCount));

  return { text: lines.join('\n'), exitCode };
}
