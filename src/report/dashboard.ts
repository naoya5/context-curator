// dashboard.ts — `curator dashboard` HTML report (DESIGN.md §11)
import type { Finding, FindingType } from '../types.js';

// ---------------------------------------------------------------------------
// DashboardData contract (DESIGN.md §11.3)
// ---------------------------------------------------------------------------
export interface DashboardData {
  generatedAt: string;        // ISO8601
  dateLabel: string;          // YYYY-MM-DD
  projectDir: string;
  score: number;              // 0-100
  totalFootprintTokens: number;
  staleFootprintTokens: number;
  stalePercent: number;
  totalAssets: number;
  byKind: Array<{ label: string; count: number; tokens: number | null }>; // tokens=null は unknown(MCP)
  history: Array<{ date: string; score: number; totalTokens: number; staleTokens: number }>; // 古い→新しい
  findings: Array<{
    type: FindingType; severity: 'info' | 'warn' | 'high';
    assetId: string; kind: string; name: string; reason: string;
  }>;
  findingCountsByType: Record<string, number>;
}

// ---------------------------------------------------------------------------
// buildDashboardData (DESIGN.md §11.3)
// ---------------------------------------------------------------------------
export function buildDashboardData(input: {
  cost: {
    date: string;
    score: number;
    totalFootprintTokens: number;
    staleFootprintTokens: number;
    stalePercent: number;
    byKind: Array<{ label: string; count: number; tokens: number | null }>;
  };
  findings: Finding[];
  totalAssets: number;
  history: Array<{ date: string; score: number; totalTokens: number; staleTokens: number }>;
  projectDir: string;
  generatedAt: string;
}): DashboardData {
  // Aggregate findingCountsByType
  const findingCountsByType: Record<string, number> = {};
  for (const f of input.findings) {
    findingCountsByType[f.type] = (findingCountsByType[f.type] ?? 0) + 1;
  }

  return {
    generatedAt: input.generatedAt,
    dateLabel: input.cost.date,
    projectDir: input.projectDir,
    score: input.cost.score,
    totalFootprintTokens: input.cost.totalFootprintTokens,
    staleFootprintTokens: input.cost.staleFootprintTokens,
    stalePercent: input.cost.stalePercent,
    totalAssets: input.totalAssets,
    byKind: input.cost.byKind,
    history: input.history,
    findings: input.findings.map((f) => ({
      type: f.type,
      severity: f.severity,
      assetId: f.asset.id,
      kind: f.asset.kind,
      name: f.asset.name,
      reason: f.reason,
    })),
    findingCountsByType,
  };
}

// ---------------------------------------------------------------------------
// HTML escape utility (DESIGN.md §11.2)
// ---------------------------------------------------------------------------
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Token formatting helper
// ---------------------------------------------------------------------------
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Score color class (DESIGN.md §11.4)
// ---------------------------------------------------------------------------
function scoreColorClass(score: number): string {
  if (score >= 80) return 'score-green';
  if (score >= 50) return 'score-yellow';
  return 'score-red';
}

// ---------------------------------------------------------------------------
// Inline SVG donut gauge
// ---------------------------------------------------------------------------
function renderDonutGauge(score: number): string {
  const r = 54;
  const cx = 64;
  const cy = 64;
  const circumference = 2 * Math.PI * r;
  const filled = circumference * (score / 100);
  const empty = circumference - filled;
  const colorClass = scoreColorClass(score);
  const strokeColor = colorClass === 'score-green'
    ? '#4ade80'
    : colorClass === 'score-yellow'
    ? '#facc15'
    : '#f87171';

  return `<svg viewBox="0 0 128 128" width="128" height="128" aria-label="Score ${score}/100">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#334155" stroke-width="14"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
    stroke="${strokeColor}" stroke-width="14"
    stroke-dasharray="${filled.toFixed(2)} ${empty.toFixed(2)}"
    stroke-linecap="round"
    transform="rotate(-90 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="22" font-weight="bold"
    fill="${strokeColor}" font-family="monospace">${score}</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Inline SVG line chart for history
// ---------------------------------------------------------------------------
function renderHistoryChart(
  history: Array<{ date: string; score: number }>,
): string {
  if (history.length === 0) {
    return '<p class="no-data">履歴なし</p>';
  }

  const W = 480;
  const H = 100;
  const PAD_L = 36;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 24;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;

  // Map each point to SVG coordinates
  const n = history.length;
  const points = history.map((h, i) => {
    const x = n === 1
      ? PAD_L + innerW / 2
      : PAD_L + (i / (n - 1)) * innerW;
    const y = PAD_T + innerH - (Math.max(0, Math.min(100, h.score)) / 100) * innerH;
    return { x, y, date: h.date, score: h.score };
  });

  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  // Score axis labels
  const axisLines = [0, 50, 100].map((v) => {
    const y = PAD_T + innerH - (v / 100) * innerH;
    return `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}"
      stroke="#334155" stroke-width="1" stroke-dasharray="2 2"/>
    <text x="${(PAD_L - 4).toFixed(0)}" y="${(y + 4).toFixed(1)}" text-anchor="end"
      font-size="9" fill="#94a3b8">${v}</text>`;
  });

  // Dots
  const dots = points.map((p) => {
    const col = p.score >= 80 ? '#4ade80' : p.score >= 50 ? '#facc15' : '#f87171';
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3"
      fill="${col}" stroke="#1e293b" stroke-width="1">
      <title>${esc(p.date)}: ${p.score}</title>
    </circle>`;
  });

  // Date labels (first + last)
  const dateLabelFirst = `<text x="${points[0]!.x.toFixed(1)}" y="${H}" text-anchor="start"
    font-size="9" fill="#64748b">${esc(points[0]!.date)}</text>`;
  const dateLabelLast = n > 1
    ? `<text x="${points[n - 1]!.x.toFixed(1)}" y="${H}" text-anchor="end"
    font-size="9" fill="#64748b">${esc(points[n - 1]!.date)}</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"
    style="max-width:100%;display:block;" aria-label="Score history chart">
  ${axisLines.join('\n  ')}
  <polyline points="${polylinePoints}"
    fill="none" stroke="#6366f1" stroke-width="2" stroke-linejoin="round"/>
  ${dots.join('\n  ')}
  ${dateLabelFirst}
  ${dateLabelLast}
</svg>`;
}

// ---------------------------------------------------------------------------
// Inventory horizontal bar chart
// ---------------------------------------------------------------------------
function renderInventoryBars(
  byKind: Array<{ label: string; count: number; tokens: number | null }>,
  totalTokens: number,
): string {
  if (byKind.length === 0) return '<p class="no-data">資産なし</p>';

  const rows = byKind.map((k) => {
    const tokenStr = k.tokens === null ? 'unknown' : fmtTokens(k.tokens);
    const pct = (k.tokens !== null && totalTokens > 0)
      ? Math.max(2, Math.round((k.tokens / totalTokens) * 100))
      : 0;
    const barWidth = k.tokens !== null && totalTokens > 0 ? pct : 0;

    return `<tr>
      <td class="inv-label">${esc(k.label)}</td>
      <td class="inv-bar-cell">
        <div class="inv-bar-wrap">
          <div class="inv-bar" style="width:${barWidth}%"></div>
        </div>
      </td>
      <td class="inv-tokens">${esc(tokenStr)}</td>
      <td class="inv-count">${k.count}</td>
    </tr>`;
  });

  return `<table class="inv-table">
    <thead><tr>
      <th>種別</th><th>トークン比率</th><th>tokens</th><th>件数</th>
    </tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>`;
}

// ---------------------------------------------------------------------------
// Findings section
// ---------------------------------------------------------------------------
function renderFindings(
  findings: DashboardData['findings'],
): string {
  if (findings.length === 0) {
    return '<p class="no-data">Findings なし</p>';
  }

  // Group by type
  const groups = new Map<FindingType, typeof findings>();
  for (const f of findings) {
    if (!groups.has(f.type)) groups.set(f.type, []);
    groups.get(f.type)!.push(f);
  }

  const ORDER: FindingType[] = ['zombie', 'stale', 'unused', 'bloated', 'duplicate', 'lint'];
  const html: string[] = [];

  for (const type of ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;

    const rows = group.map((f) => {
      const sevClass = `sev-${f.severity}`;
      return `<tr>
        <td><span class="badge ${sevClass}">${esc(f.severity)}</span></td>
        <td>${esc(f.kind)}</td>
        <td class="finding-name">${esc(f.name)}</td>
        <td class="finding-reason">${esc(f.reason)}</td>
      </tr>`;
    });

    html.push(`<div class="finding-group">
      <h3 class="finding-type-header">${esc(type)} <span class="badge-count">${group.length}</span></h3>
      <table class="findings-table">
        <thead><tr><th>severity</th><th>kind</th><th>name</th><th>reason</th></tr></thead>
        <tbody>${rows.join('\n')}</tbody>
      </table>
    </div>`);
  }

  return html.join('\n');
}

// ---------------------------------------------------------------------------
// CSS styles (inline, dark theme)
// ---------------------------------------------------------------------------
function buildStyles(): string {
  return `<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;
  background:#0f172a;color:#e2e8f0;font-size:14px;line-height:1.5;padding:24px}
h1{font-size:1.4rem;color:#f8fafc;font-weight:700;margin-bottom:4px}
h2{font-size:1.1rem;color:#94a3b8;font-weight:600;margin:0 0 12px 0;
  border-bottom:1px solid #1e293b;padding-bottom:6px}
h3.finding-type-header{font-size:.95rem;color:#cbd5e1;font-weight:600;
  margin:16px 0 8px 0;text-transform:uppercase;letter-spacing:.05em}
.subtitle{color:#64748b;font-size:.85rem;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-bottom:24px}
.card{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:20px}
.score-section{display:flex;align-items:center;gap:20px}
.score-num{font-size:3rem;font-weight:800;line-height:1}
.score-green{color:#4ade80}.score-yellow{color:#facc15}.score-red{color:#f87171}
.score-label{font-size:.8rem;color:#64748b;margin-top:4px}
.score-sub{font-size:.85rem;color:#94a3b8;margin-top:8px}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:16px}
.stat-item{background:#0f172a;border-radius:6px;padding:10px}
.stat-val{font-size:1.3rem;font-weight:700;color:#f8fafc}
.stat-key{font-size:.75rem;color:#64748b;margin-top:2px}
.chart-wrap{overflow-x:auto}
.inv-table{width:100%;border-collapse:collapse}
.inv-table th{text-align:left;color:#64748b;font-size:.75rem;font-weight:500;
  padding:4px 8px;border-bottom:1px solid #334155}
.inv-label{padding:6px 8px;color:#e2e8f0;white-space:nowrap}
.inv-bar-cell{padding:6px 8px;width:50%}
.inv-bar-wrap{background:#0f172a;border-radius:4px;height:14px;overflow:hidden}
.inv-bar{background:#6366f1;height:100%;border-radius:4px;transition:width .3s}
.inv-tokens{padding:6px 8px;color:#94a3b8;font-size:.8rem;text-align:right;white-space:nowrap}
.inv-count{padding:6px 8px;color:#64748b;font-size:.8rem;text-align:right}
.findings-table{width:100%;border-collapse:collapse;font-size:.85rem}
.findings-table th{text-align:left;color:#64748b;font-size:.75rem;font-weight:500;
  padding:4px 8px;border-bottom:1px solid #334155}
.findings-table td{padding:5px 8px;border-bottom:1px solid #1e293b;vertical-align:top}
.finding-name{color:#cbd5e1;font-family:monospace;font-size:.8rem}
.finding-reason{color:#94a3b8;font-size:.8rem}
.finding-group{margin-bottom:16px}
.badge{display:inline-block;border-radius:4px;padding:1px 6px;
  font-size:.72rem;font-weight:600;text-transform:uppercase}
.sev-high{background:#450a0a;color:#f87171;border:1px solid #991b1b}
.sev-warn{background:#451a03;color:#facc15;border:1px solid #92400e}
.sev-info{background:#0c1a3a;color:#60a5fa;border:1px solid #1e40af}
.badge-count{display:inline-block;background:#334155;color:#94a3b8;
  border-radius:12px;padding:0 8px;font-size:.8rem;font-weight:400;margin-left:6px}
.no-data{color:#475569;font-style:italic;padding:12px 0}
footer{margin-top:32px;padding-top:16px;border-top:1px solid #1e293b;
  color:#475569;font-size:.78rem}
footer strong{color:#64748b}
</style>`;
}

// ---------------------------------------------------------------------------
// renderDashboardHtml — pure function (DESIGN.md §11.2)
// ---------------------------------------------------------------------------
export function renderDashboardHtml(data: DashboardData): string {
  const colorClass = scoreColorClass(data.score);
  const donut = renderDonutGauge(data.score);
  const historyChart = renderHistoryChart(data.history);
  const inventoryBars = renderInventoryBars(data.byKind, data.totalFootprintTokens);
  const findingsHtml = renderFindings(data.findings);
  const styles = buildStyles();

  const totalFindings = data.findings.length;
  const highCount = data.findings.filter((f) => f.severity === 'high').length;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Context Curator Dashboard — ${esc(data.dateLabel)}</title>
${styles}
</head>
<body>
<h1>Context Curator Dashboard</h1>
<p class="subtitle">Project: <code>${esc(data.projectDir)}</code></p>

<div class="grid">
  <!-- Score card -->
  <div class="card">
    <h2>Context Health Score</h2>
    <div class="score-section">
      ${donut}
      <div>
        <div class="score-num ${colorClass}">${data.score}</div>
        <div class="score-label">/ 100</div>
        <div class="score-sub">
          ${data.stalePercent}% stale &nbsp;·&nbsp;
          ${esc(fmtTokens(data.staleFootprintTokens))} / ${esc(fmtTokens(data.totalFootprintTokens))} tokens
        </div>
      </div>
    </div>
    <div class="stat-grid">
      <div class="stat-item">
        <div class="stat-val">${data.totalAssets}</div>
        <div class="stat-key">総資産数</div>
      </div>
      <div class="stat-item">
        <div class="stat-val ${highCount > 0 ? 'score-red' : ''}">${totalFindings}</div>
        <div class="stat-key">Findings${highCount > 0 ? ` (${highCount} HIGH)` : ''}</div>
      </div>
    </div>
  </div>

  <!-- History card -->
  <div class="card">
    <h2>Score 履歴</h2>
    <div class="chart-wrap">
      ${historyChart}
    </div>
  </div>
</div>

<!-- Inventory card -->
<div class="card" style="margin-bottom:16px">
  <h2>コンテキスト資産 内訳</h2>
  ${inventoryBars}
</div>

<!-- Findings card -->
<div class="card">
  <h2>Findings (${totalFindings})</h2>
  ${findingsHtml}
</div>

<footer>
  <strong>Generated:</strong> ${esc(data.generatedAt)}<br>
  read-only。~/.claude は変更していない。
</footer>
</body>
</html>`;
}
