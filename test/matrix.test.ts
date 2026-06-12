// test/matrix.test.ts — McpMatrix + allProjects tests (DESIGN.md §9.2, §9.4, §9.5)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import type { ResolvedPaths } from '../src/paths.js';
import { loadMcpMatrix, listKnownProjectDirs } from '../src/usage/matrix.js';
import { buildInventory } from '../src/scan/inventory.js';
import { buildMcpReport } from '../src/report/mcp.js';
import type { Asset } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

// ── helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

async function makeTempPaths(): Promise<ResolvedPaths> {
  tmpDir = await mkdtemp(join(tmpdir(), 'curator-matrix-test-'));
  const curatorHome = join(tmpDir, 'curator');
  await mkdir(curatorHome, { recursive: true });
  return {
    claudeDir: join(FIXTURES, 'fake-claude'),
    curatorHome,
    claudeJson: join(FIXTURES, 'fake-claude.json'),
    projectDir: join(tmpDir, 'project'),
  };
}

/** Write MCP-tool ledger events to the curatorHome/ledger.jsonl */
async function writeMcpLedger(
  paths: ResolvedPaths,
  events: Array<{
    ts?: string;
    server: string;
    cwd: string;
    tool?: string;
    sessionId?: string;
  }>,
): Promise<void> {
  const lines = events.map((e) =>
    JSON.stringify({
      ts: e.ts ?? new Date().toISOString(),
      kind: 'mcp-tool',
      ref: e.server,
      tool: e.tool ?? 'some-tool',
      sessionId: e.sessionId ?? 'sess-001',
      cwd: e.cwd,
    }),
  );
  await writeFile(join(paths.curatorHome, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf-8');
}

// ── loadMcpMatrix: basic aggregation ─────────────────────────────────────────

describe('loadMcpMatrix — cwd × server aggregation', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty matrix when no ledger exists', async () => {
    const matrix = await loadMcpMatrix(paths);
    expect(matrix.servers).toEqual([]);
    expect(matrix.projects).toEqual([]);
    expect(matrix.counts).toEqual({});
  });

  it('aggregates cwd × server counts correctly', async () => {
    const cwd1 = '/home/user/project-alpha';
    const cwd2 = '/home/user/project-beta';

    await writeMcpLedger(paths, [
      { server: 'server-a', cwd: cwd1 },
      { server: 'server-a', cwd: cwd1 },
      { server: 'server-a', cwd: cwd2 },
      { server: 'server-b', cwd: cwd1 },
      { server: 'server-b', cwd: cwd2 },
      { server: 'server-b', cwd: cwd2 },
    ]);

    const matrix = await loadMcpMatrix(paths);

    expect(matrix.servers).toContain('server-a');
    expect(matrix.servers).toContain('server-b');

    // server-a: cwd1=2, cwd2=1
    expect(matrix.counts['server-a']?.[cwd1]).toBe(2);
    expect(matrix.counts['server-a']?.[cwd2]).toBe(1);

    // server-b: cwd1=1, cwd2=2
    expect(matrix.counts['server-b']?.[cwd1]).toBe(1);
    expect(matrix.counts['server-b']?.[cwd2]).toBe(2);
  });

  it('projects are ordered by total desc', async () => {
    const cwdHigh = '/home/user/project-high';
    const cwdLow = '/home/user/project-low';

    await writeMcpLedger(paths, [
      { server: 'srv', cwd: cwdHigh },
      { server: 'srv', cwd: cwdHigh },
      { server: 'srv', cwd: cwdHigh },
      { server: 'srv', cwd: cwdLow },
    ]);

    const matrix = await loadMcpMatrix(paths);
    expect(matrix.projects[0].cwd).toBe(cwdHigh);
    expect(matrix.projects[0].total).toBe(3);
    expect(matrix.projects[1].cwd).toBe(cwdLow);
    expect(matrix.projects[1].total).toBe(1);
  });

  it('project label is basename of cwd', async () => {
    await writeMcpLedger(paths, [
      { server: 'srv', cwd: '/home/user/my-project' },
    ]);

    const matrix = await loadMcpMatrix(paths);
    expect(matrix.projects[0].label).toBe('my-project');
  });

  it('ignores non-mcp-tool events', async () => {
    // Write mixed ledger with skill and agent events mixed in
    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), kind: 'skill', ref: 'article-workflow', sessionId: 's1', cwd: '/proj' }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'mcp-tool', ref: 'my-server', tool: 'search', sessionId: 's2', cwd: '/proj' }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'agent', ref: 'planner', sessionId: 's3', cwd: '/proj' }),
    ];
    await writeFile(join(paths.curatorHome, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const matrix = await loadMcpMatrix(paths);
    expect(matrix.servers).toEqual(['my-server']);
    expect(matrix.projects).toHaveLength(1);
  });

  it('handles broken ledger lines gracefully', async () => {
    const lines = [
      'not valid json',
      JSON.stringify({ ts: new Date().toISOString(), kind: 'mcp-tool', ref: 'ok-server', tool: 't', sessionId: 's1', cwd: '/ok' }),
      '{broken',
    ];
    await writeFile(join(paths.curatorHome, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const matrix = await loadMcpMatrix(paths);
    expect(matrix.servers).toContain('ok-server');
  });
});

// ── loadMcpMatrix: --days window ─────────────────────────────────────────────

describe('loadMcpMatrix — --days window', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('includes all events when days not specified', async () => {
    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    await writeMcpLedger(paths, [
      { ts: oldTs, server: 'old-server', cwd: '/proj' },
      { server: 'new-server', cwd: '/proj' },
    ]);

    const matrix = await loadMcpMatrix(paths);
    expect(matrix.servers).toContain('old-server');
    expect(matrix.servers).toContain('new-server');
  });

  it('excludes events older than --days', async () => {
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recentTs = new Date().toISOString();

    await writeMcpLedger(paths, [
      { ts: oldTs, server: 'old-server', cwd: '/proj' },
      { ts: recentTs, server: 'new-server', cwd: '/proj' },
    ]);

    const matrix = await loadMcpMatrix(paths, { days: 30 });
    expect(matrix.servers).not.toContain('old-server');
    expect(matrix.servers).toContain('new-server');
  });

  it('returns empty matrix when all events are outside the window', async () => {
    const oldTs = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    await writeMcpLedger(paths, [
      { ts: oldTs, server: 'old-server', cwd: '/proj' },
    ]);

    const matrix = await loadMcpMatrix(paths, { days: 30 });
    expect(matrix.servers).toHaveLength(0);
    expect(matrix.projects).toHaveLength(0);
  });
});

// ── buildMcpReport: suggestions for unused servers ───────────────────────────

describe('buildMcpReport — unused project suggestions', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  function makeGlobalMcpAsset(name: string): Asset {
    return {
      id: `mcp-server:${name}`,
      kind: 'mcp-server',
      name,
      path: '/fake/settings.json',
      scope: 'user',
      sizeBytes: 0,
      footprintTokens: 0,
      fullTokens: 0,
      modifiedAt: new Date().toISOString(),
    };
  }

  it('suggests disabling unused global server in a project', async () => {
    await writeMcpLedger(paths, [
      { server: 'used-server', cwd: '/proj/alpha' },
      // 'unused-server' appears in inventory but NOT for /proj/alpha
    ]);

    const matrix = await loadMcpMatrix(paths);
    const assets = [makeGlobalMcpAsset('used-server'), makeGlobalMcpAsset('unused-server')];
    const report = buildMcpReport(matrix, assets);

    expect(report.text).toContain('unused-server');
    expect(report.text).toContain('alpha');
    expect(report.text).toContain('無効化');
  });

  it('no suggestion when all global servers are used in all projects', async () => {
    await writeMcpLedger(paths, [
      { server: 'srv-a', cwd: '/proj/x' },
      { server: 'srv-b', cwd: '/proj/x' },
    ]);

    const matrix = await loadMcpMatrix(paths);
    const assets = [makeGlobalMcpAsset('srv-a'), makeGlobalMcpAsset('srv-b')];
    const report = buildMcpReport(matrix, assets);

    // No "提案" section
    expect(report.text).not.toContain('無効化候補');
  });

  it('shows (定義なし) row for ledger-only servers not in inventory', async () => {
    await writeMcpLedger(paths, [
      { server: 'ghost-server', cwd: '/proj/x' },
    ]);

    const matrix = await loadMcpMatrix(paths);
    const assets: Asset[] = []; // ghost-server NOT in inventory
    const report = buildMcpReport(matrix, assets);

    expect(report.text).toContain('定義なし');
    expect(report.text).toContain('ghost-server');
  });

  it('json output contains suggestions array', async () => {
    await writeMcpLedger(paths, [
      { server: 'used-srv', cwd: '/proj/beta' },
    ]);

    const matrix = await loadMcpMatrix(paths);
    const assets = [makeGlobalMcpAsset('used-srv'), makeGlobalMcpAsset('idle-srv')];
    const report = buildMcpReport(matrix, assets, { json: true });

    const json = report.json as {
      suggestions: Array<{ project: string; server: string }>;
    };
    expect(json.suggestions).toBeDefined();
    expect(json.suggestions.some((s) => s.server === 'idle-srv')).toBe(true);
  });

  it('limits projects to top 8 by default', async () => {
    // Create 10 distinct project cwds
    const events = Array.from({ length: 10 }, (_, i) => ({
      server: 'srv',
      cwd: `/proj/project-${i.toString().padStart(2, '0')}`,
    }));
    // Give them different totals by adding extra events to some
    events[0] = { server: 'srv', cwd: '/proj/project-00' };
    await writeMcpLedger(paths, events);

    const matrix = await loadMcpMatrix(paths);
    expect(matrix.projects.length).toBe(10);

    // Report without --all should show at most 8
    const assets = [makeGlobalMcpAsset('srv')];
    const report = buildMcpReport(matrix, assets, { all: false });

    expect(report.text).toContain('more projects hidden');

    const jsonOut = report.json as { truncated: { shown: number; total: number } | null };
    expect(jsonOut.truncated).not.toBeNull();
    expect(jsonOut.truncated!.shown).toBe(8);
    expect(jsonOut.truncated!.total).toBe(10);
  });

  it('--all shows all projects', async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      server: 'srv',
      cwd: `/proj/project-${i.toString().padStart(2, '0')}`,
    }));
    await writeMcpLedger(paths, events);

    const matrix = await loadMcpMatrix(paths);
    const assets = [makeGlobalMcpAsset('srv')];
    const report = buildMcpReport(matrix, assets, { all: true });

    const jsonOut = report.json as { truncated: null };
    expect(jsonOut.truncated).toBeNull();
    expect(report.text).not.toContain('more projects hidden');
  });
});

// ── listKnownProjectDirs ──────────────────────────────────────────────────────

describe('listKnownProjectDirs', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when no ledger exists', async () => {
    const dirs = await listKnownProjectDirs(paths);
    expect(dirs).toEqual([]);
  });

  it('returns unique cwds that exist on disk', async () => {
    // Create real temp dirs
    const dir1 = join(tmpDir, 'real-project-1');
    const dir2 = join(tmpDir, 'real-project-2');
    await mkdir(dir1, { recursive: true });
    await mkdir(dir2, { recursive: true });
    const nonExistent = '/tmp/this-absolutely-does-not-exist-curator-test-xyz';

    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), kind: 'skill', ref: 'a', sessionId: 's1', cwd: dir1 }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'mcp-tool', ref: 'srv', tool: 't', sessionId: 's2', cwd: dir2 }),
      JSON.stringify({ ts: new Date().toISOString(), kind: 'agent', ref: 'b', sessionId: 's3', cwd: dir1 }), // duplicate dir1
      JSON.stringify({ ts: new Date().toISOString(), kind: 'skill', ref: 'c', sessionId: 's4', cwd: nonExistent }),
    ];
    await writeFile(join(paths.curatorHome, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const dirs = await listKnownProjectDirs(paths);
    expect(dirs).toContain(dir1);
    expect(dirs).toContain(dir2);
    // Non-existent dirs should be filtered out
    expect(dirs).not.toContain(nonExistent);
    // No duplicates
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('skips cwds that do not exist', async () => {
    const nonExistent = '/absolutely/no/such/dir/curator-xyz-9999';
    const lines = [
      JSON.stringify({ ts: new Date().toISOString(), kind: 'skill', ref: 'a', sessionId: 's1', cwd: nonExistent }),
    ];
    await writeFile(join(paths.curatorHome, 'ledger.jsonl'), lines.join('\n') + '\n', 'utf-8');

    const dirs = await listKnownProjectDirs(paths);
    expect(dirs).toHaveLength(0);
  });
});

// ── buildInventory --allProjects integration ──────────────────────────────────

describe('buildInventory — allProjects option', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('without allProjects behaves identically to original signature (no extra assets)', async () => {
    const inv1 = await buildInventory(paths);
    const inv2 = await buildInventory(paths, {});
    expect(inv1.assets.length).toBe(inv2.assets.length);
  });

  it('allProjects with empty projectDirs adds no extra assets', async () => {
    const inv1 = await buildInventory(paths);
    const inv2 = await buildInventory(paths, { allProjects: true, projectDirs: [] });
    expect(inv1.assets.length).toBe(inv2.assets.length);
  });

  it('allProjects: scans multiple projectDirs and integrates project-scoped assets', async () => {
    // Create two fake project dirs with .claude/settings.json containing MCP servers
    const projA = join(tmpDir, 'project-a');
    const projB = join(tmpDir, 'project-b');
    await mkdir(join(projA, '.claude'), { recursive: true });
    await mkdir(join(projB, '.claude'), { recursive: true });

    await writeFile(
      join(projA, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          'proj-a-server': { command: 'node', args: ['server.js'] },
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(projB, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          'proj-b-server': { command: 'python3', args: ['-m', 'server'] },
        },
      }),
      'utf-8',
    );

    const inv = await buildInventory(paths, {
      allProjects: true,
      projectDirs: [projA, projB],
    });

    const names = inv.assets.map((a) => a.name);
    expect(names).toContain('proj-a-server');
    expect(names).toContain('proj-b-server');

    // All project-scoped assets should have scope='project'
    const projAssets = inv.assets.filter(
      (a) => a.name === 'proj-a-server' || a.name === 'proj-b-server',
    );
    for (const a of projAssets) {
      expect(a.scope).toBe('project');
    }
  });

  it('allProjects: skips non-existent projectDirs without crash', async () => {
    const nonExistent = '/absolutely/no/such/dir/curator-xyz-fake';
    const inv = await buildInventory(paths, {
      allProjects: true,
      projectDirs: [nonExistent],
    });
    // Should not throw; inventory should be same as baseline
    const baseline = await buildInventory(paths);
    expect(inv.assets.length).toBe(baseline.assets.length);
  });

  it('allProjects: deduplicates assets with conflicting ids', async () => {
    // Both project dirs define a server with the same name
    const projA = join(tmpDir, 'dup-project-a');
    const projB = join(tmpDir, 'dup-project-b');
    await mkdir(join(projA, '.claude'), { recursive: true });
    await mkdir(join(projB, '.claude'), { recursive: true });

    const serverConfig = JSON.stringify({
      mcpServers: {
        'shared-server': { command: 'node', args: ['s.js'] },
      },
    });
    await writeFile(join(projA, '.claude', 'settings.json'), serverConfig, 'utf-8');
    await writeFile(join(projB, '.claude', 'settings.json'), serverConfig, 'utf-8');

    // Should not throw
    const inv = await buildInventory(paths, {
      allProjects: true,
      projectDirs: [projA, projB],
    });

    // All asset ids should be unique
    const ids = inv.assets.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
