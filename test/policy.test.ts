// policy.test.ts — unit tests for rules.ts and engine.ts (DESIGN.md §5)
import { describe, it, expect } from 'vitest';
import type { Asset, UsageStats } from '../src/types.js';
import type { PolicyConfig } from '../src/config.js';
import {
  checkStale,
  checkUnused,
  checkBloated,
  checkZombie,
  matchesGlob,
  isIgnored,
} from '../src/policy/rules.js';
import { evaluate } from '../src/policy/engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-06-11T00:00:00Z');

const DEFAULT_POLICY: PolicyConfig = {
  staleDays: 30,
  unusedGraceDays: 14,
  bloat: {
    claudeMdTokens: 3000,
    skillFullTokens: 8000,
    memoryFileTokens: 2000,
  },
};

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'skill:test-skill',
    kind: 'skill',
    name: 'test-skill',
    path: '/fake/.claude/skills/test-skill/SKILL.md',
    scope: 'user',
    sizeBytes: 1024,
    footprintTokens: 100,
    fullTokens: 500,
    modifiedAt: '2026-01-01T00:00:00Z', // 161 days before NOW
    ...overrides,
  };
}

function makeStats(overrides: Partial<UsageStats> = {}): UsageStats {
  return {
    ref: 'test-skill',
    kind: 'skill',
    count: 5,
    lastUsed: '2026-05-01T00:00:00Z', // 41 days before NOW
    projects: ['/home/user/project'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------
describe('matchesGlob', () => {
  it('exact match', () => {
    expect(matchesGlob('skill:daily-commit', 'skill:daily-commit')).toBe(true);
  });
  it('wildcard prefix', () => {
    expect(matchesGlob('skill:*', 'skill:daily-commit')).toBe(true);
  });
  it('wildcard suffix', () => {
    // * matches any sequence including ':' and '-'
    // '*-commit' → * matches 'skill:daily', then '-commit' matches '-commit'
    expect(matchesGlob('*-commit', 'skill:daily-commit')).toBe(true);
  });
  it('no match', () => {
    expect(matchesGlob('agent:*', 'skill:daily-commit')).toBe(false);
  });
  it('full wildcard', () => {
    expect(matchesGlob('*', 'anything:goes')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isIgnored
// ---------------------------------------------------------------------------
describe('isIgnored', () => {
  it('matches exact id in ignore list', () => {
    expect(isIgnored('skill:daily-commit', ['skill:daily-commit'])).toBe(true);
  });
  it('matches glob pattern', () => {
    expect(isIgnored('skill:daily-commit', ['skill:*'])).toBe(true);
  });
  it('does not match unrelated patterns', () => {
    expect(isIgnored('skill:other', ['agent:*', 'mcp-server:*'])).toBe(false);
  });
  it('empty list → never ignored', () => {
    expect(isIgnored('skill:anything', [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkStale
// ---------------------------------------------------------------------------
describe('checkStale', () => {
  it('no finding when last used within staleDays', () => {
    const stats = makeStats({ lastUsed: '2026-06-01T00:00:00Z' }); // 10 days ago
    expect(checkStale(makeAsset(), stats, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('warn when last used > staleDays (just over)', () => {
    // 31 days ago → just over 30-day threshold
    const stats = makeStats({ lastUsed: '2026-05-11T00:00:00Z' });
    const finding = checkStale(makeAsset(), stats, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('warn');
    expect(finding!.type).toBe('stale');
  });

  it('warn at exactly staleDays (boundary: not yet stale)', () => {
    // Exactly 30 days ago → NOT stale (age <= staleDays)
    const stats = makeStats({ lastUsed: '2026-05-12T00:00:00Z' }); // 30 days
    const finding = checkStale(makeAsset(), stats, DEFAULT_POLICY, NOW);
    expect(finding).toBeNull();
  });

  it('high severity when age >= 3 × staleDays', () => {
    // 91 days ago → >= 90 days (3 × 30)
    const stats = makeStats({ lastUsed: '2026-03-11T00:00:00Z' });
    const finding = checkStale(makeAsset(), stats, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('high');
  });

  it('exactly 3× staleDays → high', () => {
    // 90 days ago = 3 × 30
    const stats = makeStats({ lastUsed: '2026-03-12T00:00:00Z' }); // 91 days... let's use exactly
    // 2026-06-11 - 90 days = 2026-03-12
    const stats90 = makeStats({ lastUsed: '2026-03-12T12:00:00Z' }); // ~89.5 days
    const stats91 = makeStats({ lastUsed: '2026-03-12T00:00:00Z' }); // 91 days exactly no...
    // 2026-06-11 - 90d = March 13? Let me compute carefully
    // 90 days before 2026-06-11: June has 30 days, May 31, April 30 → 30-31 = June->May(31d), May->April(30d)...
    // Simpler: use a date that is clearly 3x
    const stats3x = makeStats({ lastUsed: new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString() });
    const finding = checkStale(makeAsset(), stats3x, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.severity).toBe('high');
  });

  it('no finding when stats is undefined (no usage → handled by unused)', () => {
    expect(checkStale(makeAsset(), undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding when lastUsed is null', () => {
    const stats = makeStats({ lastUsed: null, count: 0 });
    expect(checkStale(makeAsset(), stats, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('claude-md is exempt from stale', () => {
    const asset = makeAsset({ kind: 'claude-md', id: 'claude-md:CLAUDE.md' });
    const stats = makeStats({ lastUsed: '2020-01-01T00:00:00Z' }); // very old
    expect(checkStale(asset, stats, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('memory is exempt from stale', () => {
    const asset = makeAsset({ kind: 'memory', id: 'memory:MEMORY.md' });
    const stats = makeStats({ lastUsed: '2020-01-01T00:00:00Z' });
    expect(checkStale(asset, stats, DEFAULT_POLICY, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkUnused
// ---------------------------------------------------------------------------
describe('checkUnused', () => {
  it('no finding when usage count > 0', () => {
    const stats = makeStats({ count: 1, lastUsed: '2026-05-01T00:00:00Z' });
    expect(checkUnused(makeAsset(), stats, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding when within grace period', () => {
    // modifiedAt 5 days ago → within 14-day grace
    const asset = makeAsset({
      modifiedAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(checkUnused(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding when exactly at grace period boundary', () => {
    // modifiedAt exactly 14 days ago → age <= unusedGraceDays → no finding
    const asset = makeAsset({
      modifiedAt: new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(checkUnused(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('warn when no usage and older than grace period', () => {
    // modifiedAt 161 days ago → well past 14-day grace
    const finding = checkUnused(makeAsset(), undefined, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('unused');
    expect(finding!.severity).toBe('warn');
  });

  it('warn when stats exists but count is 0', () => {
    const stats = makeStats({ count: 0, lastUsed: null });
    const finding = checkUnused(makeAsset(), stats, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('unused');
  });

  it('claude-md is exempt from unused', () => {
    const asset = makeAsset({ kind: 'claude-md', id: 'claude-md:CLAUDE.md', modifiedAt: '2020-01-01T00:00:00Z' });
    expect(checkUnused(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('memory is exempt from unused', () => {
    const asset = makeAsset({ kind: 'memory', id: 'memory:MEMORY.md', modifiedAt: '2020-01-01T00:00:00Z' });
    expect(checkUnused(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkBloated
// ---------------------------------------------------------------------------
describe('checkBloated', () => {
  it('no finding for claude-md within threshold', () => {
    const asset = makeAsset({
      kind: 'claude-md',
      id: 'claude-md:CLAUDE.md',
      footprintTokens: 2999,
    });
    expect(checkBloated(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('warn for claude-md exceeding claudeMdTokens', () => {
    const asset = makeAsset({
      kind: 'claude-md',
      id: 'claude-md:CLAUDE.md',
      footprintTokens: 3001,
    });
    const finding = checkBloated(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('bloated');
    expect(finding!.severity).toBe('warn');
  });

  it('exactly at claude-md threshold → no finding', () => {
    const asset = makeAsset({
      kind: 'claude-md',
      id: 'claude-md:CLAUDE.md',
      footprintTokens: 3000,
    });
    expect(checkBloated(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding for skill within skillFullTokens', () => {
    const asset = makeAsset({ fullTokens: 7999 });
    expect(checkBloated(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('warn for skill exceeding skillFullTokens', () => {
    const asset = makeAsset({ fullTokens: 8001 });
    const finding = checkBloated(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('bloated');
  });

  it('warn for memory exceeding memoryFileTokens', () => {
    const asset = makeAsset({
      kind: 'memory',
      id: 'memory:big-file.md',
      fullTokens: 2001,
    });
    const finding = checkBloated(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('bloated');
  });

  it('no finding for mcp-server (no threshold)', () => {
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:my-server',
      fullTokens: 99999,
      footprintTokens: 99999,
    });
    expect(checkBloated(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding for agent (no threshold)', () => {
    const asset = makeAsset({
      kind: 'agent',
      id: 'agent:my-agent',
      fullTokens: 99999,
    });
    expect(checkBloated(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkZombie
// ---------------------------------------------------------------------------
describe('checkZombie', () => {
  it('no finding for non-mcp-server asset', () => {
    expect(checkZombie(makeAsset(), undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding when command is empty', () => {
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:no-cmd',
      meta: { command: '' },
    });
    expect(checkZombie(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('no finding when meta has no command', () => {
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:no-meta',
      meta: {},
    });
    expect(checkZombie(asset, undefined, DEFAULT_POLICY, NOW)).toBeNull();
  });

  it('high finding when absolute path does not exist', () => {
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:ghost',
      meta: { command: '/nonexistent/path/to/binary-xyz-12345' },
    });
    const finding = checkZombie(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('zombie');
    expect(finding!.severity).toBe('high');
  });

  it('no finding when absolute path exists', () => {
    // /bin/sh should exist on any Unix system
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:sh-server',
      meta: { command: '/bin/sh' },
    });
    const finding = checkZombie(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).toBeNull();
  });

  it('no finding when command name is on PATH (e.g. node)', () => {
    // node should be on PATH in test environment
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:node-server',
      meta: { command: 'node /some/script.js' },
    });
    const finding = checkZombie(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).toBeNull();
  });

  it('high finding when command name is not on PATH', () => {
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:ghost-cmd',
      meta: { command: 'nonexistent-binary-xyz-curator-test-abc123' },
    });
    const finding = checkZombie(asset, undefined, DEFAULT_POLICY, NOW);
    expect(finding).not.toBeNull();
    expect(finding!.type).toBe('zombie');
    expect(finding!.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// evaluate (engine)
// ---------------------------------------------------------------------------
describe('evaluate', () => {
  it('returns empty array for empty assets', () => {
    expect(evaluate([], [], DEFAULT_POLICY)).toHaveLength(0);
  });

  it('ignores assets matching ignore list', () => {
    const asset = makeAsset();
    const findings = evaluate([asset], [], DEFAULT_POLICY, ['skill:test-skill'], NOW);
    expect(findings).toHaveLength(0);
  });

  it('ignores assets matching glob pattern', () => {
    const asset = makeAsset();
    const findings = evaluate([asset], [], DEFAULT_POLICY, ['skill:*'], NOW);
    expect(findings).toHaveLength(0);
  });

  it('produces stale finding for stale asset', () => {
    const asset = makeAsset();
    const stats: UsageStats = {
      ref: 'test-skill',
      kind: 'skill',
      count: 3,
      lastUsed: '2026-04-01T00:00:00Z', // ~71 days ago → > 30 days → stale warn (< 90 days)
      projects: [],
    };
    const findings = evaluate([asset], [stats], DEFAULT_POLICY, [], NOW);
    const stale = findings.filter((f) => f.type === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.severity).toBe('warn'); // 71 days < 90 (3×30), so warn not high
  });

  it('produces high severity stale finding when age >= 3x staleDays', () => {
    const asset = makeAsset();
    const stats: UsageStats = {
      ref: 'test-skill',
      kind: 'skill',
      count: 3,
      lastUsed: new Date(NOW.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString(), // 91 days ago
      projects: [],
    };
    const findings = evaluate([asset], [stats], DEFAULT_POLICY, [], NOW);
    const stale = findings.filter((f) => f.type === 'stale');
    expect(stale).toHaveLength(1);
    expect(stale[0]!.severity).toBe('high'); // 91 days >= 90 (3×30)
  });

  it('produces unused finding for untracked old asset', () => {
    const asset = makeAsset(); // modifiedAt 161 days ago, no stats
    const findings = evaluate([asset], [], DEFAULT_POLICY, [], NOW);
    const unused = findings.filter((f) => f.type === 'unused');
    expect(unused).toHaveLength(1);
  });

  it('does NOT produce unused finding for claude-md', () => {
    const asset = makeAsset({
      kind: 'claude-md',
      id: 'claude-md:CLAUDE.md',
      name: 'CLAUDE.md',
      modifiedAt: '2020-01-01T00:00:00Z',
    });
    const findings = evaluate([asset], [], DEFAULT_POLICY, [], NOW);
    const unused = findings.filter((f) => f.type === 'unused');
    expect(unused).toHaveLength(0);
  });

  it('does NOT produce stale finding for memory', () => {
    const asset = makeAsset({
      kind: 'memory',
      id: 'memory:MEMORY.md',
      name: 'MEMORY.md',
      modifiedAt: '2020-01-01T00:00:00Z',
    });
    const memStats: UsageStats = {
      ref: 'MEMORY.md',
      kind: 'skill', // wouldn't match anyway
      count: 0,
      lastUsed: '2020-01-01T00:00:00Z',
      projects: [],
    };
    const findings = evaluate([asset], [memStats], DEFAULT_POLICY, [], NOW);
    const stale = findings.filter((f) => f.type === 'stale');
    const unused = findings.filter((f) => f.type === 'unused');
    expect(stale).toHaveLength(0);
    expect(unused).toHaveLength(0);
  });

  it('maps mcp-server to mcp-tool stats kind', () => {
    const asset = makeAsset({
      kind: 'mcp-server',
      id: 'mcp-server:my-server',
      name: 'my-server',
      meta: { command: 'node' }, // exists on PATH → not zombie
    });
    const stats: UsageStats = {
      ref: 'my-server',
      kind: 'mcp-tool',
      count: 5,
      lastUsed: '2026-06-01T00:00:00Z', // 10 days ago → not stale
      projects: [],
    };
    const findings = evaluate([asset], [stats], DEFAULT_POLICY, [], NOW);
    const stale = findings.filter((f) => f.type === 'stale');
    expect(stale).toHaveLength(0);
  });

  it('multiple findings for same asset (e.g. stale + bloated)', () => {
    const asset = makeAsset({
      fullTokens: 9000, // exceeds 8000 → bloated
    });
    const stats: UsageStats = {
      ref: 'test-skill',
      kind: 'skill',
      count: 1,
      lastUsed: '2026-04-01T00:00:00Z', // ~71 days → stale high
      projects: [],
    };
    const findings = evaluate([asset], [stats], DEFAULT_POLICY, [], NOW);
    const types = findings.map((f) => f.type);
    expect(types).toContain('stale');
    expect(types).toContain('bloated');
  });
});
