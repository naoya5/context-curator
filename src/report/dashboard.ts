// dashboard.ts — `curator dashboard` HTML report (DESIGN.md §11)
//
// Aesthetic: "Engineering Telemetry / instrument panel".
// Monospace-forward (offline-safe, on-theme for a CLI), near-monochrome ink
// ground with green/amber/red as the only chroma, blueprint grid, registration
// marks, CSS-only load choreography. Fully self-contained: no external
// CDN/font/network resources; charts are hand-drawn inline SVG; every dynamic
// string is HTML-escaped; no <script> tag (no JS, no XSS vector).
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
// HTML escape (DESIGN.md §11.2) — applied to EVERY dynamic string
// ---------------------------------------------------------------------------
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Score → semantic color class (tests rely on score-green/yellow/red names)
function scoreColorClass(score: number): string {
  if (score >= 80) return 'score-green';
  if (score >= 50) return 'score-yellow';
  return 'score-red';
}

const SEMANTIC: Record<string, string> = {
  'score-green': '#4cc38a',
  'score-yellow': '#e0a93b',
  'score-red': '#f0695d',
};

function statusLabel(score: number): { text: string; cls: string } {
  if (score >= 80) return { text: 'NOMINAL', cls: 'score-green' };
  if (score >= 50) return { text: 'DEGRADED', cls: 'score-yellow' };
  return { text: 'CRITICAL', cls: 'score-red' };
}

// ---------------------------------------------------------------------------
// Inline SVG instrument dial (donut gauge with tick ring + sweep animation)
// ---------------------------------------------------------------------------
function renderDonutGauge(score: number): string {
  const cx = 80;
  const cy = 80;
  const r = 62;
  const CIRC = 2 * Math.PI * r; // constant (r fixed) — matches keyframe `from`
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const offset = CIRC * (1 - pct); // final stroke-dashoffset
  const cls = scoreColorClass(score);
  const color = SEMANTIC[cls]!;

  // Instrument tick ring: 60 ticks, every 5th major
  const ticks: string[] = [];
  for (let i = 0; i < 60; i++) {
    const ang = (i / 60) * 2 * Math.PI - Math.PI / 2;
    const major = i % 5 === 0;
    const r1 = major ? r + 10 : r + 12;
    const r2 = major ? r + 16 : r + 15;
    const x1 = (cx + Math.cos(ang) * r1).toFixed(1);
    const y1 = (cy + Math.sin(ang) * r1).toFixed(1);
    const x2 = (cx + Math.cos(ang) * r2).toFixed(1);
    const y2 = (cy + Math.sin(ang) * r2).toFixed(1);
    ticks.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major ? '#4a5a66' : '#2a343d'}" stroke-width="${major ? 1.4 : 1}"/>`,
    );
  }

  return `<svg viewBox="0 0 160 160" width="180" height="180" class="gauge" role="img" aria-label="Health score ${score} of 100">
  <g class="gauge-ticks">${ticks.join('')}</g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1b232b" stroke-width="7"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="7"
    stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(2)}"
    class="gauge-arc" transform="rotate(-90 ${cx} ${cy})"
    style="--final:${offset.toFixed(2)};filter:drop-shadow(0 0 6px ${color}99)"/>
  <text x="${cx}" y="${cy + 4}" text-anchor="middle" class="gauge-cap" fill="#5b6975">HEALTH</text>
</svg>`;
}

// ---------------------------------------------------------------------------
// Inline SVG history line chart (area fill + glow line + draw-in)
// ---------------------------------------------------------------------------
function renderHistoryChart(
  history: Array<{ date: string; score: number }>,
): string {
  if (history.length === 0) {
    return '<p class="no-data">履歴なし — <code>curator cost</code> を回すと記録されます</p>';
  }

  const W = 520;
  const H = 150;
  const PAD_L = 32;
  const PAD_R = 14;
  const PAD_T = 16;
  const PAD_B = 26;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const n = history.length;

  const pts = history.map((h, i) => {
    const x = n === 1 ? PAD_L + innerW / 2 : PAD_L + (i / (n - 1)) * innerW;
    const y = PAD_T + innerH - (Math.max(0, Math.min(100, h.score)) / 100) * innerH;
    return { x, y, date: h.date, score: h.score };
  });

  const linePoints = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const baselineY = PAD_T + innerH;
  const areaPoints = `${pts[0]!.x.toFixed(1)},${baselineY} ${linePoints} ${pts[n - 1]!.x.toFixed(1)},${baselineY}`;

  const gridLines = [0, 50, 100].map((v) => {
    const y = PAD_T + innerH - (v / 100) * innerH;
    return `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="#1d2630" stroke-width="1" stroke-dasharray="1 4"/>
    <text x="${(PAD_L - 6).toFixed(0)}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="ax">${v}</text>`;
  });

  const dots = pts.map((p) => {
    const cls = scoreColorClass(p.score);
    const col = SEMANTIC[cls]!;
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.4" fill="#0a0f14" stroke="${col}" stroke-width="2" style="filter:drop-shadow(0 0 4px ${col}aa)"><title>${esc(p.date)} · ${p.score}</title></circle>`;
  });

  const firstLabel = `<text x="${pts[0]!.x.toFixed(1)}" y="${H - 6}" text-anchor="${n === 1 ? 'middle' : 'start'}" class="ax">${esc(pts[0]!.date)}</text>`;
  const lastLabel = n > 1
    ? `<text x="${pts[n - 1]!.x.toFixed(1)}" y="${H - 6}" text-anchor="end" class="ax">${esc(pts[n - 1]!.date)}</text>`
    : '';

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" class="hist" role="img" aria-label="Score history">
  <defs>
    <linearGradient id="histArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#39c7d8" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="#39c7d8" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${gridLines.join('\n  ')}
  <polygon points="${areaPoints}" fill="url(#histArea)" class="hist-area"/>
  <polyline points="${linePoints}" fill="none" stroke="#56d6e6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" class="hist-line" style="filter:drop-shadow(0 0 5px #56d6e688)"/>
  ${dots.join('\n  ')}
  ${firstLabel}
  ${lastLabel}
</svg>`;
}

// ---------------------------------------------------------------------------
// Inventory — instrument readout rows with grow-in bars
// ---------------------------------------------------------------------------
function renderInventoryBars(
  byKind: Array<{ label: string; count: number; tokens: number | null }>,
  totalTokens: number,
): string {
  if (byKind.length === 0) return '<p class="no-data">資産なし</p>';

  const maxTokens = Math.max(
    1,
    ...byKind.map((k) => (k.tokens !== null ? k.tokens : 0)),
  );

  const rows = byKind.map((k, i) => {
    const isUnknown = k.tokens === null;
    const tokenStr = isUnknown ? 'unknown' : fmtTokens(k.tokens!);
    const w = isUnknown ? 0 : Math.max(2, Math.round((k.tokens! / maxTokens) * 100));
    const delay = (0.05 * i + 0.5).toFixed(2);
    return `<div class="inv-row">
      <div class="inv-label">${esc(k.label)}</div>
      <div class="inv-track">
        <div class="inv-fill${isUnknown ? ' inv-unknown' : ''}" style="--w:${w}%;animation-delay:${delay}s"></div>
      </div>
      <div class="inv-tok${isUnknown ? ' dim' : ''}">${esc(tokenStr)}</div>
      <div class="inv-cnt">${k.count}<span class="unit">×</span></div>
    </div>`;
  });

  return `<div class="inv">${rows.join('\n')}</div>`;
}

// ---------------------------------------------------------------------------
// Findings — console log grouped by type with LED severity indicators
// ---------------------------------------------------------------------------
function renderFindings(findings: DashboardData['findings']): string {
  if (findings.length === 0) {
    return '<p class="no-data ok">Findings なし — クリーンな状態です ✓</p>';
  }

  const groups = new Map<FindingType, typeof findings>();
  for (const f of findings) {
    if (!groups.has(f.type)) groups.set(f.type, []);
    groups.get(f.type)!.push(f);
  }

  const ORDER: FindingType[] = ['zombie', 'stale', 'unused', 'bloated', 'duplicate', 'lint'];
  const blocks: string[] = [];

  for (const type of ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;

    const rows = group.map((f) => `<li class="frow">
        <span class="led sev-${esc(f.severity)}" aria-hidden="true"></span>
        <span class="fsev sev-${esc(f.severity)}">${esc(f.severity)}</span>
        <span class="fkind">${esc(f.kind)}</span>
        <span class="fname">${esc(f.name)}</span>
        <span class="freason">${esc(f.reason)}</span>
      </li>`);

    blocks.push(`<div class="fgroup">
      <div class="fhead"><span class="ftype">${esc(type)}</span><span class="fcount">${group.length}</span><span class="frule"></span></div>
      <ul class="flist">${rows.join('\n')}</ul>
    </div>`);
  }

  return blocks.join('\n');
}

// ---------------------------------------------------------------------------
// CSS — engineering telemetry theme (inline, self-contained)
// ---------------------------------------------------------------------------
function buildStyles(): string {
  return `<style>
:root{
  --ink:#0a0f14; --panel:rgba(255,255,255,.018); --line:rgba(125,150,170,.14);
  --line-soft:rgba(125,150,170,.07); --tx:#cdd6e0; --dim:#7c8a99; --faint:#46525f;
  --cyan:#56d6e6; --green:#4cc38a; --amber:#e0a93b; --red:#f0695d;
  --mono:"SF Mono","JetBrains Mono","Fira Code",ui-monospace,Menlo,Consolas,monospace;
  --jp:"Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP",sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{-webkit-font-smoothing:antialiased}
body{
  font-family:var(--mono),var(--jp);color:var(--tx);font-size:13px;line-height:1.55;
  background:
    radial-gradient(120% 80% at 50% -10%,#11181f 0%,var(--ink) 55%,#05080b 100%),
    var(--ink);
  min-height:100vh;padding:38px 30px 60px;position:relative;overflow-x:hidden;
}
/* blueprint grid */
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:
    linear-gradient(var(--line-soft) 1px,transparent 1px),
    linear-gradient(90deg,var(--line-soft) 1px,transparent 1px);
  background-size:30px 30px;
  -webkit-mask-image:radial-gradient(130% 90% at 50% 0%,#000 40%,transparent 92%);
          mask-image:radial-gradient(130% 90% at 50% 0%,#000 40%,transparent 92%);
}
.wrap{position:relative;z-index:1;max-width:1080px;margin:0 auto}
/* registration / crop marks */
.reg{position:fixed;width:14px;height:14px;z-index:2;pointer-events:none;opacity:.5}
.reg::before,.reg::after{content:"";position:absolute;background:var(--cyan);opacity:.6}
.reg::before{width:14px;height:1px;top:6px}.reg::after{height:14px;width:1px;left:6px}
.reg.tl{top:14px;left:14px}.reg.tr{top:14px;right:14px}
.reg.bl{bottom:14px;left:14px}.reg.br{bottom:14px;right:14px}

/* header */
header{margin-bottom:26px;opacity:0;animation:rise .6s ease .05s forwards}
.brand{font-size:1.55rem;font-weight:700;letter-spacing:.02em;color:#eef3f7}
.brand b{color:var(--cyan);font-weight:700}
.brand .dim{color:var(--faint);font-weight:400}
.readout{display:flex;flex-wrap:wrap;gap:6px 22px;margin-top:12px;
  font-size:.72rem;letter-spacing:.08em;align-items:center}
.rd{display:flex;gap:7px;align-items:baseline}
.rd .k{color:var(--faint);text-transform:uppercase}
.rd .v{color:var(--dim)}
.status{margin-left:auto;display:inline-flex;align-items:center;gap:7px;
  text-transform:uppercase;font-weight:700;letter-spacing:.14em;font-size:.72rem;
  padding:4px 11px;border:1px solid var(--line);border-radius:2px;background:rgba(0,0,0,.25)}
.status .dot{width:7px;height:7px;border-radius:50%;background:currentColor;
  box-shadow:0 0 7px currentColor;animation:pulse 2.4s ease-in-out infinite}

/* layout */
.grid{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:14px;margin-bottom:14px}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
.panel{position:relative;background:var(--panel);border:1px solid var(--line);
  border-radius:3px;padding:18px 20px;opacity:0;animation:rise .6s ease forwards}
.panel::before{content:"";position:absolute;top:-1px;left:14px;width:26px;height:2px;background:var(--cyan);opacity:.55}
.grid .panel:nth-child(1){animation-delay:.12s}
.grid .panel:nth-child(2){animation-delay:.20s}
.panel.full{animation-delay:.28s;margin-bottom:14px}
.panel.find{animation-delay:.36s}
.eyebrow{font-size:.68rem;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);
  margin-bottom:14px;display:flex;align-items:center;gap:9px}
.eyebrow::after{content:"";flex:1;height:1px;background:var(--line-soft)}

/* gauge panel */
.gauge-wrap{display:flex;flex-direction:column;align-items:center;gap:14px}
.gauge{display:block;margin-top:-6px}
.gauge-cap{font-family:var(--mono);font-size:9px;letter-spacing:.34em}
.gauge-arc{animation:sweep 1.3s cubic-bezier(.4,0,.2,1) .25s both}
.score-line{display:flex;align-items:baseline;gap:8px;justify-content:center;margin-top:-4px}
.score-num{font-size:2.9rem;font-weight:700;line-height:1;letter-spacing:-.02em}
.score-den{color:var(--faint);font-size:.85rem}
.score-green{color:var(--green)}.score-yellow{color:var(--amber)}.score-red{color:var(--red)}
.score-num.score-green{text-shadow:0 0 22px #4cc38a55}
.score-num.score-yellow{text-shadow:0 0 22px #e0a93b55}
.score-num.score-red{text-shadow:0 0 22px #f0695d55}
.telemetry{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%;margin-top:4px}
.tcell{border:1px solid var(--line-soft);border-radius:2px;padding:9px 11px;background:rgba(0,0,0,.18)}
.tval{font-size:1.15rem;font-weight:700;color:#eef3f7;letter-spacing:-.01em}
.tval.warn{color:var(--red)}
.tkey{font-size:.64rem;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-top:3px}
.tsub{text-align:center;font-size:.74rem;color:var(--dim);margin-top:2px}
.tsub b{color:var(--tx);font-weight:700}

/* history */
.hist{overflow:visible}
.ax{font-family:var(--mono);font-size:8.5px;fill:#5b6975;letter-spacing:.05em}
.hist-line{stroke-dasharray:1400;stroke-dashoffset:1400;animation:draw 1.5s ease .35s forwards}
.hist-area{opacity:0;animation:fade .8s ease .7s forwards}

/* inventory */
.inv{display:flex;flex-direction:column;gap:9px}
.inv-row{display:grid;grid-template-columns:140px 1fr 56px 44px;align-items:center;gap:12px}
@media(max-width:560px){.inv-row{grid-template-columns:96px 1fr 48px 36px;gap:8px}}
.inv-label{color:var(--tx);font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.inv-track{height:9px;background:rgba(0,0,0,.32);border:1px solid var(--line-soft);border-radius:2px;overflow:hidden}
.inv-fill{height:100%;width:0;border-radius:1px;
  background:linear-gradient(90deg,#2f7d8a,var(--cyan));
  box-shadow:0 0 8px #56d6e644;animation:grow .9s cubic-bezier(.4,0,.2,1) both}
.inv-fill.inv-unknown{background:repeating-linear-gradient(45deg,#2a343d,#2a343d 4px,transparent 4px,transparent 8px);box-shadow:none;width:100%!important;opacity:.5;animation:none}
.inv-tok{text-align:right;font-size:.76rem;color:var(--cyan)}
.inv-tok.dim{color:var(--faint)}
.inv-cnt{text-align:right;font-size:.82rem;color:var(--tx);font-weight:600}
.inv-cnt .unit{color:var(--faint);font-weight:400;margin-left:1px;font-size:.7rem}

/* findings */
.fgroup{margin-bottom:18px}
.fgroup:last-child{margin-bottom:0}
.fhead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.ftype{font-size:.74rem;letter-spacing:.16em;text-transform:uppercase;color:var(--tx);font-weight:700}
.fcount{font-size:.7rem;color:var(--dim);border:1px solid var(--line);border-radius:10px;padding:0 8px;min-width:22px;text-align:center}
.frule{flex:1;height:1px;background:var(--line-soft)}
.flist{list-style:none}
.frow{display:grid;grid-template-columns:9px 52px 74px minmax(120px,1fr) 2fr;align-items:baseline;gap:11px;
  padding:6px 6px 6px 2px;border-bottom:1px solid var(--line-soft)}
.frow:hover{background:rgba(86,214,230,.04)}
@media(max-width:680px){.frow{grid-template-columns:9px 48px 1fr;row-gap:2px}
  .fname{grid-column:2/-1}.freason{grid-column:2/-1}}
.led{width:8px;height:8px;border-radius:50%;align-self:center;background:currentColor;box-shadow:0 0 6px currentColor}
.fsev{font-size:.64rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.fkind{font-size:.72rem;color:var(--dim)}
.fname{font-size:.8rem;color:#dfe6ee;word-break:break-word}
.freason{font-size:.75rem;color:var(--dim);word-break:break-word}
.sev-high{color:var(--red)}.sev-warn{color:var(--amber)}.sev-info{color:var(--cyan)}

.no-data{color:var(--faint);font-style:normal;padding:10px 0;font-size:.82rem}
.no-data code{color:var(--cyan);font-style:normal}
.no-data.ok{color:var(--green)}
code{font-family:var(--mono)}

footer{margin-top:30px;padding-top:16px;border-top:1px solid var(--line-soft);
  color:var(--faint);font-size:.72rem;letter-spacing:.04em;
  display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;
  opacity:0;animation:rise .6s ease .45s forwards}
footer .k{color:var(--dim)}
footer .lock{color:var(--green)}

@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@keyframes sweep{from{stroke-dashoffset:389.56}to{stroke-dashoffset:var(--final)}}
@keyframes grow{from{width:0}to{width:var(--w)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes fade{to{opacity:1}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){
  *{animation:none!important}
  header,.panel,footer{opacity:1;transform:none}
  .gauge-arc{stroke-dashoffset:var(--final)}
  .inv-fill{width:var(--w)}
  .hist-line{stroke-dashoffset:0}.hist-area{opacity:1}
}
</style>`;
}

// ---------------------------------------------------------------------------
// renderDashboardHtml — pure function (DESIGN.md §11.2)
// ---------------------------------------------------------------------------
export function renderDashboardHtml(data: DashboardData): string {
  const colorClass = scoreColorClass(data.score);
  const status = statusLabel(data.score);
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
<title>context-curator dashboard — ${esc(data.dateLabel)}</title>
${styles}
</head>
<body>
<span class="reg tl"></span><span class="reg tr"></span><span class="reg bl"></span><span class="reg br"></span>
<div class="wrap">
<header>
  <div class="brand">context<b>·</b>curator <span class="dim">/ telemetry</span></div>
  <div class="readout">
    <span class="rd"><span class="k">project</span><span class="v">${esc(data.projectDir)}</span></span>
    <span class="rd"><span class="k">scan</span><span class="v">${esc(data.dateLabel)}</span></span>
    <span class="rd"><span class="k">assets</span><span class="v">${data.totalAssets}</span></span>
    <span class="status ${status.cls}"><span class="dot"></span>${status.text}</span>
  </div>
</header>

<div class="grid">
  <div class="panel">
    <div class="eyebrow">context health</div>
    <div class="gauge-wrap">
      ${donut}
      <div class="score-line">
        <span class="score-num ${colorClass}">${data.score}</span>
        <span class="score-den">/ 100</span>
      </div>
      <div class="tsub">起動時 <b>${esc(fmtTokens(data.totalFootprintTokens))}</b> tokens · うち
        <b>${data.stalePercent}%</b> が stale/unused</div>
      <div class="telemetry">
        <div class="tcell"><div class="tval">${esc(fmtTokens(data.staleFootprintTokens))}</div><div class="tkey">stale tokens</div></div>
        <div class="tcell"><div class="tval ${highCount > 0 ? 'warn' : ''}">${totalFindings}</div><div class="tkey">findings${highCount > 0 ? ` · ${highCount} high` : ''}</div></div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="eyebrow">score history</div>
    ${historyChart}
  </div>
</div>

<div class="panel full">
  <div class="eyebrow">context asset footprint</div>
  ${inventoryBars}
</div>

<div class="panel find">
  <div class="eyebrow">findings · ${totalFindings}</div>
  ${findingsHtml}
</div>

<footer>
  <span class="k">generated</span> ${esc(data.generatedAt)}
  <span class="lock">● read-only</span>
  <span>~/.claude は変更していない</span>
</footer>
</div>
</body>
</html>`;
}
