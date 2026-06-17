// dashboard.test.ts — unit tests for dashboard module (DESIGN.md §11.5)
import { describe, it, expect } from 'vitest';
import type { Finding } from '../src/types.js';
import {
  buildDashboardData,
  renderDashboardHtml,
  type DashboardData,
} from '../src/report/dashboard.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAsset(overrides: Partial<Finding['asset']> = {}): Finding['asset'] {
  return {
    id: 'skill:test-skill',
    kind: 'skill',
    name: 'test-skill',
    path: '/fake/skills/test-skill/SKILL.md',
    scope: 'user',
    sizeBytes: 1024,
    footprintTokens: 200,
    fullTokens: 800,
    modifiedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    asset: makeAsset(),
    type: 'stale',
    severity: 'warn',
    reason: 'テスト理由',
    suggestion: 'テスト提案',
    ...overrides,
  };
}

function makeCost(overrides: Partial<ReturnType<typeof defaultCost>> = {}) {
  return { ...defaultCost(), ...overrides };
}

function defaultCost() {
  return {
    date: '2026-06-17',
    score: 75,
    totalFootprintTokens: 1000,
    staleFootprintTokens: 250,
    stalePercent: 25,
    byKind: [
      { label: 'skills frontmatter', count: 3, tokens: 600 },
      { label: 'CLAUDE.md', count: 1, tokens: 400 },
      { label: 'MCP servers', count: 2, tokens: null },
    ],
  };
}

function makeDashboardData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: '2026-06-17T10:00:00Z',
    dateLabel: '2026-06-17',
    projectDir: '/Users/test/my-project',
    score: 75,
    totalFootprintTokens: 1000,
    staleFootprintTokens: 250,
    stalePercent: 25,
    totalAssets: 6,
    byKind: [
      { label: 'skills frontmatter', count: 3, tokens: 600 },
      { label: 'CLAUDE.md', count: 1, tokens: 400 },
      { label: 'MCP servers', count: 2, tokens: null },
    ],
    history: [
      { date: '2026-06-14', score: 80, totalTokens: 950, staleTokens: 190 },
      { date: '2026-06-15', score: 78, totalTokens: 980, staleTokens: 216 },
      { date: '2026-06-16', score: 77, totalTokens: 990, staleTokens: 228 },
      { date: '2026-06-17', score: 75, totalTokens: 1000, staleTokens: 250 },
    ],
    findings: [
      { type: 'stale', severity: 'warn', assetId: 'skill:old-skill', kind: 'skill', name: 'old-skill', reason: '90日間未使用' },
      { type: 'unused', severity: 'info', assetId: 'skill:dormant', kind: 'skill', name: 'dormant', reason: 'transcript に登場なし' },
    ],
    findingCountsByType: { stale: 1, unused: 1 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildDashboardData
// ---------------------------------------------------------------------------
describe('buildDashboardData', () => {
  it('copies cost fields into DashboardData', () => {
    const cost = makeCost();
    const data = buildDashboardData({
      cost,
      findings: [],
      totalAssets: 6,
      history: [],
      projectDir: '/test',
      generatedAt: '2026-06-17T00:00:00Z',
    });

    expect(data.score).toBe(cost.score);
    expect(data.dateLabel).toBe(cost.date);
    expect(data.totalFootprintTokens).toBe(cost.totalFootprintTokens);
    expect(data.staleFootprintTokens).toBe(cost.staleFootprintTokens);
    expect(data.stalePercent).toBe(cost.stalePercent);
    expect(data.byKind).toEqual(cost.byKind);
  });

  it('copies projectDir and generatedAt', () => {
    const data = buildDashboardData({
      cost: makeCost(),
      findings: [],
      totalAssets: 0,
      history: [],
      projectDir: '/Users/naoya/myproject',
      generatedAt: '2026-06-17T10:30:00Z',
    });
    expect(data.projectDir).toBe('/Users/naoya/myproject');
    expect(data.generatedAt).toBe('2026-06-17T10:30:00Z');
  });

  it('aggregates findingCountsByType correctly', () => {
    const findings = [
      makeFinding({ type: 'stale' }),
      makeFinding({ type: 'stale', asset: makeAsset({ id: 'skill:s2', name: 's2' }) }),
      makeFinding({ type: 'unused', asset: makeAsset({ id: 'skill:u1', name: 'u1' }) }),
      makeFinding({ type: 'zombie', asset: makeAsset({ id: 'skill:z1', name: 'z1' }) }),
    ];
    const data = buildDashboardData({
      cost: makeCost(),
      findings,
      totalAssets: 4,
      history: [],
      projectDir: '/test',
      generatedAt: '2026-06-17T00:00:00Z',
    });

    expect(data.findingCountsByType['stale']).toBe(2);
    expect(data.findingCountsByType['unused']).toBe(1);
    expect(data.findingCountsByType['zombie']).toBe(1);
    expect(data.findingCountsByType['bloated']).toBeUndefined();
  });

  it('returns empty findingCountsByType when no findings', () => {
    const data = buildDashboardData({
      cost: makeCost(),
      findings: [],
      totalAssets: 0,
      history: [],
      projectDir: '/test',
      generatedAt: '2026-06-17T00:00:00Z',
    });
    expect(data.findingCountsByType).toEqual({});
  });

  it('maps findings to the correct shape', () => {
    const f = makeFinding({ type: 'bloated', severity: 'high', reason: '大きすぎ' });
    const data = buildDashboardData({
      cost: makeCost(),
      findings: [f],
      totalAssets: 1,
      history: [],
      projectDir: '/test',
      generatedAt: '2026-06-17T00:00:00Z',
    });

    expect(data.findings).toHaveLength(1);
    expect(data.findings[0]).toMatchObject({
      type: 'bloated',
      severity: 'high',
      assetId: f.asset.id,
      kind: f.asset.kind,
      name: f.asset.name,
      reason: '大きすぎ',
    });
  });

  it('copies history as-is (oldest→newest)', () => {
    const history = [
      { date: '2026-06-10', score: 90, totalTokens: 800, staleTokens: 80 },
      { date: '2026-06-11', score: 85, totalTokens: 850, staleTokens: 128 },
    ];
    const data = buildDashboardData({
      cost: makeCost(),
      findings: [],
      totalAssets: 0,
      history,
      projectDir: '/test',
      generatedAt: '2026-06-17T00:00:00Z',
    });
    expect(data.history).toEqual(history);
  });
});

// ---------------------------------------------------------------------------
// renderDashboardHtml — HTML escaping (DESIGN.md §11.5)
// ---------------------------------------------------------------------------
describe('renderDashboardHtml — HTML escaping', () => {
  it('escapes < > & " in asset name', () => {
    const data = makeDashboardData({
      findings: [{
        type: 'stale',
        severity: 'warn',
        assetId: 'skill:xss',
        kind: 'skill',
        name: '<script>alert("xss")</script>',
        reason: 'normal reason',
      }],
    });
    const html = renderDashboardHtml(data);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;xss&quot;');
  });

  it('escapes < > & " in reason', () => {
    const data = makeDashboardData({
      findings: [{
        type: 'unused',
        severity: 'info',
        assetId: 'skill:evil',
        kind: 'skill',
        name: 'normal-skill',
        reason: '<img src=x onerror="alert(1)">&test',
      }],
    });
    const html = renderDashboardHtml(data);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&amp;test');
    expect(html).toContain('&quot;alert(1)&quot;');
  });

  it('escapes & in projectDir', () => {
    const data = makeDashboardData({
      projectDir: '/Users/test/my & special <project>',
    });
    const html = renderDashboardHtml(data);
    expect(html).not.toContain('/Users/test/my & special <project>');
    expect(html).toContain('my &amp; special &lt;project&gt;');
  });

  it('escapes < > & " in byKind labels', () => {
    const data = makeDashboardData({
      byKind: [
        { label: '<evil>"label"&test', count: 1, tokens: 100 },
      ],
    });
    const html = renderDashboardHtml(data);
    expect(html).not.toContain('<evil>');
    expect(html).toContain('&lt;evil&gt;');
    expect(html).toContain('&amp;test');
  });

  it('does not contain raw <script> injection from any user-controlled field', () => {
    const malicious = '<script>alert("pwned")</script>';
    const data = makeDashboardData({
      projectDir: malicious,
      findings: [{
        type: 'stale',
        severity: 'high',
        assetId: malicious,
        kind: 'skill',
        name: malicious,
        reason: malicious,
      }],
      byKind: [{ label: malicious, count: 1, tokens: 100 }],
    });
    const html = renderDashboardHtml(data);
    // The raw injected string must not appear as a working tag
    const tagPattern = /<script>alert\("pwned"\)<\/script>/;
    expect(tagPattern.test(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderDashboardHtml — no external network references (DESIGN.md §11.5)
// ---------------------------------------------------------------------------
describe('renderDashboardHtml — no external network references', () => {
  it('does not contain http:// in src/href attributes', () => {
    const html = renderDashboardHtml(makeDashboardData());
    // Match src="http... or href="http...
    const extSrc = /(?:src|href)=["']https?:\/\//i;
    expect(extSrc.test(html)).toBe(false);
  });

  it('does not contain https:// in src/href attributes', () => {
    const html = renderDashboardHtml(makeDashboardData());
    const extHref = /(?:src|href)=["']https?:\/\//i;
    expect(extHref.test(html)).toBe(false);
  });

  it('does not include <link> tags pointing to external resources', () => {
    const html = renderDashboardHtml(makeDashboardData());
    // No <link rel="stylesheet" href="http..."> or similar
    const externalLink = /<link[^>]+https?:\/\//i;
    expect(externalLink.test(html)).toBe(false);
  });

  it('does not include external <script src=...>', () => {
    const html = renderDashboardHtml(makeDashboardData());
    const externalScript = /<script[^>]+src=["']https?:\/\//i;
    expect(externalScript.test(html)).toBe(false);
  });

  it('does not include <img src="http..."> for chart images', () => {
    const html = renderDashboardHtml(makeDashboardData());
    const externalImg = /<img[^>]+src=["']https?:\/\//i;
    expect(externalImg.test(html)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderDashboardHtml — history edge cases (DESIGN.md §11.5)
// ---------------------------------------------------------------------------
describe('renderDashboardHtml — history edge cases', () => {
  it('does not crash with 0 history entries', () => {
    const data = makeDashboardData({ history: [] });
    expect(() => renderDashboardHtml(data)).not.toThrow();
  });

  it('shows 履歴なし when history is empty', () => {
    const data = makeDashboardData({ history: [] });
    const html = renderDashboardHtml(data);
    expect(html).toContain('履歴なし');
  });

  it('does not crash with 1 history entry', () => {
    const data = makeDashboardData({
      history: [{ date: '2026-06-17', score: 75, totalTokens: 1000, staleTokens: 250 }],
    });
    expect(() => renderDashboardHtml(data)).not.toThrow();
  });

  it('renders valid SVG polyline with 1 history entry', () => {
    const data = makeDashboardData({
      history: [{ date: '2026-06-17', score: 75, totalTokens: 1000, staleTokens: 250 }],
    });
    const html = renderDashboardHtml(data);
    // Should contain a polyline element (not crash)
    expect(html).toContain('<polyline');
  });

  it('renders valid SVG polyline with multiple history entries', () => {
    const data = makeDashboardData({
      history: [
        { date: '2026-06-15', score: 80, totalTokens: 900, staleTokens: 180 },
        { date: '2026-06-16', score: 78, totalTokens: 950, staleTokens: 209 },
        { date: '2026-06-17', score: 75, totalTokens: 1000, staleTokens: 250 },
      ],
    });
    expect(() => renderDashboardHtml(data)).not.toThrow();
    const html = renderDashboardHtml(data);
    expect(html).toContain('<polyline');
  });

  it('does not crash with history score of 0', () => {
    const data = makeDashboardData({
      history: [{ date: '2026-06-17', score: 0, totalTokens: 1000, staleTokens: 1000 }],
    });
    expect(() => renderDashboardHtml(data)).not.toThrow();
  });

  it('does not crash with history score of 100', () => {
    const data = makeDashboardData({
      history: [{ date: '2026-06-17', score: 100, totalTokens: 1000, staleTokens: 0 }],
    });
    expect(() => renderDashboardHtml(data)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// renderDashboardHtml — score color classes (DESIGN.md §11.5)
// ---------------------------------------------------------------------------
describe('renderDashboardHtml — score color thresholds', () => {
  it('score >= 80 uses score-green class', () => {
    const data = makeDashboardData({ score: 80 });
    const html = renderDashboardHtml(data);
    expect(html).toContain('score-green');
  });

  it('score >= 80 (high value) uses score-green class', () => {
    const data = makeDashboardData({ score: 95 });
    const html = renderDashboardHtml(data);
    expect(html).toContain('score-green');
  });

  it('score = 79 uses score-yellow class (not green) on the score number element', () => {
    const data = makeDashboardData({ score: 79 });
    const html = renderDashboardHtml(data);
    // The score-num element must have score-yellow, not score-green
    expect(html).toMatch(/class="score-num score-yellow"/);
    expect(html).not.toMatch(/class="score-num score-green"/);
  });

  it('score >= 50 uses score-yellow class on the score number element', () => {
    const data = makeDashboardData({ score: 50 });
    const html = renderDashboardHtml(data);
    expect(html).toMatch(/class="score-num score-yellow"/);
  });

  it('score = 65 uses score-yellow class on the score number element', () => {
    const data = makeDashboardData({ score: 65 });
    const html = renderDashboardHtml(data);
    expect(html).toMatch(/class="score-num score-yellow"/);
  });

  it('score = 49 uses score-red class (not yellow) on the score number element', () => {
    const data = makeDashboardData({ score: 49 });
    const html = renderDashboardHtml(data);
    expect(html).toMatch(/class="score-num score-red"/);
    expect(html).not.toMatch(/class="score-num score-yellow"/);
    expect(html).not.toMatch(/class="score-num score-green"/);
  });

  it('score = 0 uses score-red class on the score number element', () => {
    const data = makeDashboardData({ score: 0 });
    const html = renderDashboardHtml(data);
    expect(html).toMatch(/class="score-num score-red"/);
  });
});

// ---------------------------------------------------------------------------
// renderDashboardHtml — structure sanity checks
// ---------------------------------------------------------------------------
describe('renderDashboardHtml — structure', () => {
  it('returns a complete HTML document', () => {
    const html = renderDashboardHtml(makeDashboardData());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
    expect(html).toContain('<body');
    expect(html).toContain('</body>');
  });

  it('contains the generatedAt timestamp in footer', () => {
    const data = makeDashboardData({ generatedAt: '2026-06-17T10:00:00Z' });
    const html = renderDashboardHtml(data);
    expect(html).toContain('2026-06-17T10:00:00Z');
  });

  it('contains the read-only disclaimer', () => {
    const html = renderDashboardHtml(makeDashboardData());
    expect(html).toContain('read-only');
    expect(html).toContain('~/.claude は変更していない');
  });

  it('shows finding types in findings section', () => {
    const data = makeDashboardData();
    const html = renderDashboardHtml(data);
    expect(html.toLowerCase()).toContain('stale');
    expect(html.toLowerCase()).toContain('unused');
  });

  it('shows "unknown" for MCP server tokens=null in inventory', () => {
    const data = makeDashboardData({
      byKind: [{ label: 'MCP servers', count: 2, tokens: null }],
    });
    const html = renderDashboardHtml(data);
    expect(html).toContain('unknown');
  });

  it('shows "Findings なし" when no findings', () => {
    const data = makeDashboardData({ findings: [] });
    const html = renderDashboardHtml(data);
    expect(html).toContain('Findings なし');
  });

  it('contains donut SVG gauge', () => {
    const html = renderDashboardHtml(makeDashboardData());
    expect(html).toContain('<svg');
    expect(html).toContain('circle');
  });

  it('sets charset to UTF-8', () => {
    const html = renderDashboardHtml(makeDashboardData());
    expect(html).toContain('charset="UTF-8"');
  });

  it('inline style tag present (no external CSS)', () => {
    const html = renderDashboardHtml(makeDashboardData());
    expect(html).toContain('<style>');
    // No <link rel="stylesheet" href="...">
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });
});
