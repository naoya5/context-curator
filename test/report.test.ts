// report.test.ts — unit tests for report modules (DESIGN.md §5)
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import type { Asset, Finding } from '../src/types.js';
import { buildCheckReport } from '../src/report/check.js';
import { buildCostReport, computeScore, appendHistory } from '../src/report/cost.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAsset(overrides: Partial<Asset> = {}): Asset {
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

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------
describe('computeScore', () => {
  it('score is 100 when total is 0', () => {
    expect(computeScore(0, 0)).toBe(100);
  });

  it('score is 100 when no stale tokens', () => {
    expect(computeScore(1000, 0)).toBe(100);
  });

  it('score is 0 when all tokens are stale', () => {
    expect(computeScore(1000, 1000)).toBe(0);
  });

  it('score is 65 for 35% stale', () => {
    // 350 / 1000 = 35% → 100 - 35 = 65
    expect(computeScore(1000, 350)).toBe(65);
  });

  it('rounds correctly (50.6% → score 49)', () => {
    // 506 / 1000 = 50.6% → round(50.6) = 51 → 100 - 51 = 49
    expect(computeScore(1000, 506)).toBe(49);
  });

  it('mixed case: 200/1000 stale → 80', () => {
    expect(computeScore(1000, 200)).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// buildCheckReport
// ---------------------------------------------------------------------------
describe('buildCheckReport', () => {
  it('exitCode 0 when no findings', () => {
    const { exitCode, text } = buildCheckReport([]);
    expect(exitCode).toBe(0);
    expect(text).toContain('No findings');
  });

  it('exitCode 0 when only warn findings', () => {
    const findings = [makeFinding({ severity: 'warn' })];
    const { exitCode } = buildCheckReport(findings);
    expect(exitCode).toBe(0);
  });

  it('exitCode 1 when any high severity finding', () => {
    const findings = [makeFinding({ severity: 'high', type: 'zombie' })];
    const { exitCode } = buildCheckReport(findings);
    expect(exitCode).toBe(1);
  });

  it('exitCode 1 even if filter hides the high finding', () => {
    // high finding is zombie, filter is 'stale' — exitCode still 1 (full list checked)
    const findings = [
      makeFinding({ severity: 'high', type: 'zombie' }),
      makeFinding({ type: 'stale', severity: 'warn' }),
    ];
    const { exitCode } = buildCheckReport(findings, { filter: 'stale' });
    expect(exitCode).toBe(1);
  });

  it('text contains section headers for finding types', () => {
    const findings = [
      makeFinding({ type: 'stale', severity: 'warn' }),
      makeFinding({ type: 'unused', severity: 'warn', asset: makeAsset({ id: 'skill:other', name: 'other' }) }),
    ];
    const { text } = buildCheckReport(findings);
    expect(text.toUpperCase()).toContain('STALE');
    expect(text.toUpperCase()).toContain('UNUSED');
  });

  it('filter option restricts output', () => {
    const findings = [
      makeFinding({ type: 'stale', severity: 'warn' }),
      makeFinding({ type: 'bloated', severity: 'warn', asset: makeAsset({ id: 'skill:big', name: 'big' }) }),
    ];
    const { text } = buildCheckReport(findings, { filter: 'stale' });
    expect(text.toUpperCase()).toContain('STALE');
    // bloated should not appear in filtered output
    expect(text.toUpperCase()).not.toContain('BLOATED');
  });

  it('json option outputs valid JSON array', () => {
    const findings = [makeFinding()];
    const { text } = buildCheckReport(findings, { json: true });
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toHaveProperty('type', 'stale');
    expect(parsed[0]).toHaveProperty('severity', 'warn');
    expect(parsed[0]).toHaveProperty('name');
    expect(parsed[0]).toHaveProperty('reason');
    expect(parsed[0]).toHaveProperty('suggestion');
    expect(parsed[0]).toHaveProperty('id');
    expect(parsed[0]).toHaveProperty('kind');
  });

  it('json output respects filter', () => {
    const findings = [
      makeFinding({ type: 'stale' }),
      makeFinding({ type: 'bloated', asset: makeAsset({ id: 'skill:big', name: 'big' }) }),
    ];
    const { text } = buildCheckReport(findings, { json: true, filter: 'stale' });
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('stale');
  });
});

// ---------------------------------------------------------------------------
// buildCostReport
// ---------------------------------------------------------------------------
describe('buildCostReport', () => {
  it('score 100 with no assets and no findings', () => {
    const { score } = buildCostReport([], [], { dateLabel: '2026-06-11' });
    expect(score).toBe(100);
  });

  it('score 100 with assets but no stale/unused findings', () => {
    const assets = [makeAsset({ footprintTokens: 500 })];
    const { score } = buildCostReport(assets, [], { dateLabel: '2026-06-11' });
    expect(score).toBe(100);
  });

  it('score 0 when all assets are stale', () => {
    const asset = makeAsset({ footprintTokens: 1000 });
    const findings = [makeFinding({ type: 'stale', asset })];
    const { score } = buildCostReport([asset], findings, { dateLabel: '2026-06-11' });
    expect(score).toBe(0);
  });

  it('mixed: partial stale gives intermediate score', () => {
    const staleAsset = makeAsset({ id: 'skill:stale', name: 'stale', footprintTokens: 300 });
    const freshAsset = makeAsset({ id: 'skill:fresh', name: 'fresh', footprintTokens: 700 });
    const findings = [makeFinding({ type: 'stale', asset: staleAsset })];
    const { score } = buildCostReport([staleAsset, freshAsset], findings, { dateLabel: '2026-06-11' });
    // 300/1000 = 30% stale → score 70
    expect(score).toBe(70);
  });

  it('unused findings also count as stale footprint', () => {
    const unusedAsset = makeAsset({ id: 'skill:unused', name: 'unused', footprintTokens: 400 });
    const freshAsset = makeAsset({ id: 'skill:fresh', name: 'fresh', footprintTokens: 600 });
    const findings = [makeFinding({ type: 'unused', asset: unusedAsset })];
    const { score } = buildCostReport([unusedAsset, freshAsset], findings, { dateLabel: '2026-06-11' });
    // 400/1000 = 40% stale → score 60
    expect(score).toBe(60);
  });

  it('mcp-server footprint excluded from totals', () => {
    const mcpAsset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:srv',
      name: 'srv',
      footprintTokens: 5000, // should be excluded
    });
    const skillAsset = makeAsset({ footprintTokens: 100 });
    // No stale findings → score 100 regardless
    const { score } = buildCostReport([mcpAsset, skillAsset], [], { dateLabel: '2026-06-11' });
    expect(score).toBe(100);
  });

  it('json option returns valid JSON structure', () => {
    const asset = makeAsset({ footprintTokens: 100 });
    const { text } = buildCostReport([asset], [], { json: true, dateLabel: '2026-06-11' });
    const parsed = JSON.parse(text);
    expect(parsed).toHaveProperty('date', '2026-06-11');
    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('totalFootprintTokens');
    expect(parsed).toHaveProperty('staleFootprintTokens');
    expect(parsed).toHaveProperty('stalePercent');
    expect(parsed).toHaveProperty('findingCount');
    expect(parsed).toHaveProperty('byKind');
    expect(Array.isArray(parsed.byKind)).toBe(true);
  });

  it('text report contains score line', () => {
    const { text } = buildCostReport([], [], { dateLabel: '2026-06-11' });
    expect(text).toContain('Context Health Score');
    expect(text).toContain('100/100');
  });

  it('text report contains date', () => {
    const { text } = buildCostReport([], [], { dateLabel: '2026-06-11' });
    expect(text).toContain('2026-06-11');
  });
});

// ---------------------------------------------------------------------------
// appendHistory
// ---------------------------------------------------------------------------
describe('appendHistory', () => {
  it('appends a JSONL entry to history.jsonl', () => {
    const tmpDir = join(tmpdir(), `curator-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const entry = {
        date: '2026-06-11',
        score: 75,
        totalTokens: 1000,
        staleTokens: 250,
        findingCount: 3,
      };
      appendHistory(tmpDir, entry);

      const content = readFileSync(join(tmpDir, 'history.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(parsed).toEqual(entry);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('appends multiple entries as separate lines', () => {
    const tmpDir = join(tmpdir(), `curator-test-multi-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
      const entry1 = { date: '2026-06-10', score: 80, totalTokens: 1000, staleTokens: 200, findingCount: 2 };
      const entry2 = { date: '2026-06-11', score: 75, totalTokens: 1000, staleTokens: 250, findingCount: 3 };
      appendHistory(tmpDir, entry1);
      appendHistory(tmpDir, entry2);

      const content = readFileSync(join(tmpDir, 'history.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toEqual(entry1);
      expect(JSON.parse(lines[1]!)).toEqual(entry2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
