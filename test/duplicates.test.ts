// duplicates.test.ts — unit tests for policy/duplicates.ts (DESIGN.md §8.5)
import { describe, it, expect } from 'vitest';
import type { Asset, UsageStats } from '../src/types.js';
import type { PolicyConfig } from '../src/config.js';
import { detectDuplicates } from '../src/policy/duplicates.js';
import { evaluate } from '../src/policy/engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const THRESHOLD = 0.65;

const DEFAULT_POLICY: PolicyConfig = {
  staleDays: 30,
  unusedGraceDays: 14,
  bloat: {
    claudeMdTokens: 3000,
    skillFullTokens: 8000,
    memoryFileTokens: 2000,
  },
  duplicateThreshold: THRESHOLD,
};

function makeSkill(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'skill:test-skill',
    kind: 'skill',
    name: 'test-skill',
    path: '/fake/.claude/skills/test-skill/SKILL.md',
    scope: 'user',
    sizeBytes: 1024,
    footprintTokens: 100,
    fullTokens: 500,
    modifiedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeStats(ref: string, count: number): UsageStats {
  return {
    ref,
    kind: 'skill',
    count,
    lastUsed: count > 0 ? '2026-06-01T00:00:00Z' : null,
    projects: [],
  };
}

// ---------------------------------------------------------------------------
// Helper: same description pair (identical text → Jaccard = 1.0)
// ---------------------------------------------------------------------------

describe('detectDuplicates — identical description pair', () => {
  const descText = 'translate japanese text into english for social media posts';

  const skillA = makeSkill({
    id: 'skill:x-translate',
    name: 'x-translate',
    meta: { description: descText },
    modifiedAt: '2026-01-01T00:00:00Z',
  });

  const skillB = makeSkill({
    id: 'skill:x-translate-v2',
    name: 'x-translate-v2',
    meta: { description: descText },
    modifiedAt: '2026-02-01T00:00:00Z',
  });

  it('produces exactly 1 finding for identical descriptions', () => {
    const findings = detectDuplicates([skillA, skillB], [], THRESHOLD);
    expect(findings).toHaveLength(1);
  });

  it('finding type is duplicate with severity info', () => {
    const [finding] = detectDuplicates([skillA, skillB], [], THRESHOLD);
    expect(finding!.type).toBe('duplicate');
    expect(finding!.severity).toBe('info');
  });

  it('finding has counterpartId set to the other skill id', () => {
    const [finding] = detectDuplicates([skillA, skillB], [], THRESHOLD);
    // candidate should be skillA (older modifiedAt, equal usage=0)
    expect(finding!.asset.id).toBe('skill:x-translate');
    expect(finding!.counterpartId).toBe('skill:x-translate-v2');
  });

  it('reason string contains similarity percentage and usage counts', () => {
    const [finding] = detectDuplicates([skillA, skillB], [], THRESHOLD);
    expect(finding!.reason).toContain('%');
    expect(finding!.reason).toContain('回');
  });
});

// ---------------------------------------------------------------------------
// Unrelated pair (no overlap → Jaccard = 0, below threshold)
// ---------------------------------------------------------------------------

describe('detectDuplicates — unrelated description pair', () => {
  const skillA = makeSkill({
    id: 'skill:git-commit',
    name: 'git-commit',
    meta: { description: 'create conventional git commit messages from staged changes' },
  });

  const skillB = makeSkill({
    id: 'skill:image-resize',
    name: 'image-resize',
    meta: { description: 'resize and compress image files to target dimensions' },
  });

  it('produces no findings for unrelated skills', () => {
    const findings = detectDuplicates([skillA, skillB], [], THRESHOLD);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Japanese description similar pair
// ---------------------------------------------------------------------------

describe('detectDuplicates — Japanese description similar pair', () => {
  const skillA = makeSkill({
    id: 'skill:jp-summarize',
    name: 'jp-summarize',
    meta: { description: '日本語テキストを要約してMarkdownに変換するスキル' },
    modifiedAt: '2026-01-01T00:00:00Z',
  });

  const skillB = makeSkill({
    id: 'skill:md-summarize',
    name: 'md-summarize',
    meta: { description: '日本語テキストを要約してMarkdownに変換するスキル（改良版）' },
    modifiedAt: '2026-03-01T00:00:00Z',
  });

  it('detects similarity in Japanese bigrams', () => {
    const findings = detectDuplicates([skillA, skillB], [], THRESHOLD);
    // These are highly similar — should produce a finding
    expect(findings.length).toBeGreaterThanOrEqual(1);
    if (findings.length > 0) {
      expect(findings[0]!.type).toBe('duplicate');
    }
  });
});

// ---------------------------------------------------------------------------
// Threshold variation
// ---------------------------------------------------------------------------

describe('detectDuplicates — threshold change', () => {
  const skillA = makeSkill({
    id: 'skill:post-twitter',
    name: 'post-twitter',
    meta: { description: 'post content to twitter social media platform' },
    modifiedAt: '2026-01-01T00:00:00Z',
  });

  const skillB = makeSkill({
    id: 'skill:tweet-publish',
    name: 'tweet-publish',
    meta: { description: 'publish tweet to twitter platform with formatting' },
    modifiedAt: '2026-02-01T00:00:00Z',
  });

  it('no finding at high threshold (0.95)', () => {
    // These overlap somewhat but not 95%
    const findings = detectDuplicates([skillA, skillB], [], 0.95);
    expect(findings).toHaveLength(0);
  });

  it('produces finding at low threshold (0.1)', () => {
    // Even a small overlap should exceed 10%
    const findings = detectDuplicates([skillA, skillB], [], 0.1);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Usage count based selection of archive candidate
// ---------------------------------------------------------------------------

describe('detectDuplicates — usage count based candidate selection', () => {
  const descText = 'search and browse the web using browser automation';

  const highUse = makeSkill({
    id: 'skill:browser-search',
    name: 'browser-search',
    meta: { description: descText },
    modifiedAt: '2026-01-01T00:00:00Z',
  });

  const lowUse = makeSkill({
    id: 'skill:web-browse',
    name: 'web-browse',
    meta: { description: descText },
    modifiedAt: '2026-02-01T00:00:00Z',
  });

  it('candidate is the lower-usage skill', () => {
    const stats = [
      makeStats('browser-search', 42),
      makeStats('web-browse', 3),
    ];
    const findings = detectDuplicates([highUse, lowUse], stats, THRESHOLD);
    expect(findings).toHaveLength(1);
    // web-browse has fewer uses → it's the archive candidate
    expect(findings[0]!.asset.id).toBe('skill:web-browse');
    expect(findings[0]!.counterpartId).toBe('skill:browser-search');
  });

  it('when usage counts are equal, older modifiedAt is the candidate', () => {
    const stats = [
      makeStats('browser-search', 5),
      makeStats('web-browse', 5),
    ];
    const findings = detectDuplicates([highUse, lowUse], stats, THRESHOLD);
    expect(findings).toHaveLength(1);
    // browser-search has older modifiedAt (2026-01-01) → it's the candidate
    expect(findings[0]!.asset.id).toBe('skill:browser-search');
    expect(findings[0]!.counterpartId).toBe('skill:web-browse');
  });

  it('reason contains usage counts (42 vs 3)', () => {
    const stats = [
      makeStats('browser-search', 42),
      makeStats('web-browse', 3),
    ];
    const [finding] = detectDuplicates([highUse, lowUse], stats, THRESHOLD);
    expect(finding!.reason).toContain('3');
    expect(finding!.reason).toContain('42');
  });
});

// ---------------------------------------------------------------------------
// Ignore list interaction (via evaluate)
// ---------------------------------------------------------------------------

describe('detectDuplicates — ignore list via evaluate()', () => {
  const descText = 'automate browser tasks and web scraping with playwright';

  const skillA = makeSkill({
    id: 'skill:playwright-auto',
    name: 'playwright-auto',
    meta: { description: descText },
    modifiedAt: '2026-01-01T00:00:00Z',
  });

  const skillB = makeSkill({
    id: 'skill:scraper',
    name: 'scraper',
    meta: { description: descText },
    modifiedAt: '2026-02-01T00:00:00Z',
  });

  it('ignoring one skill prevents the pair from being detected', () => {
    // Without ignore: should detect duplicate
    const findings = evaluate([skillA, skillB], [], DEFAULT_POLICY, [], new Date('2026-06-13'));
    const dupFindings = findings.filter((f) => f.type === 'duplicate');
    expect(dupFindings.length).toBeGreaterThanOrEqual(1);
  });

  it('ignored skill is excluded from duplicate comparison', () => {
    const findings = evaluate(
      [skillA, skillB],
      [],
      DEFAULT_POLICY,
      ['skill:playwright-auto'], // ignore skillA
      new Date('2026-06-13'),
    );
    const dupFindings = findings.filter((f) => f.type === 'duplicate');
    expect(dupFindings).toHaveLength(0);
  });

  it('ignoring with glob pattern also excludes from duplicate detection', () => {
    const findings = evaluate(
      [skillA, skillB],
      [],
      DEFAULT_POLICY,
      ['skill:playwright-*'],
      new Date('2026-06-13'),
    );
    const dupFindings = findings.filter((f) => f.type === 'duplicate');
    expect(dupFindings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Non-skill assets are not compared
// ---------------------------------------------------------------------------

describe('detectDuplicates — non-skill assets excluded', () => {
  const descText = 'manage file operations and directory structure';

  const skillAsset = makeSkill({
    id: 'skill:file-manager',
    name: 'file-manager',
    meta: { description: descText },
  });

  const mcpAsset = makeSkill({
    id: 'mcp-server:file-mcp',
    name: 'file-mcp',
    kind: 'mcp-server' as const,
    meta: { description: descText },
  });

  it('mcp-server assets are not compared for duplicates', () => {
    const findings = detectDuplicates([skillAsset, mcpAsset], [], THRESHOLD);
    expect(findings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('detectDuplicates — edge cases', () => {
  it('empty assets returns empty findings', () => {
    expect(detectDuplicates([], [], THRESHOLD)).toHaveLength(0);
  });

  it('single skill returns empty findings', () => {
    const skill = makeSkill({ id: 'skill:solo', name: 'solo' });
    expect(detectDuplicates([skill], [], THRESHOLD)).toHaveLength(0);
  });

  it('skill with no meta description uses name only for comparison', () => {
    const skillA = makeSkill({
      id: 'skill:alpha',
      name: 'alpha',
      meta: undefined,
      modifiedAt: '2026-01-01T00:00:00Z',
    });
    const skillB = makeSkill({
      id: 'skill:alpha-duplicate',
      name: 'alpha',  // same name
      meta: undefined,
      modifiedAt: '2026-02-01T00:00:00Z',
    });
    // Same name → Jaccard = 1.0 → finding
    const findings = detectDuplicates([skillA, skillB], [], THRESHOLD);
    expect(findings).toHaveLength(1);
  });
});
