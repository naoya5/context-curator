// test/mcp-disable.test.ts — DESIGN.md §10.4 required tests for mcp-disable
// All I/O is directed to os.tmpdir() — never touches real ~/.claude or ~/.curator
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ResolvedPaths } from '../src/paths.js';
import type { McpMatrix } from '../src/types.js';
import { buildMcpDisableProposals, applyMcpDisable } from '../src/apply/mcp-disable.js';

// ─── test helpers ──────────────────────────────────────────────────────────────

let tmpBase: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'curator-mcp-disable-test-'));
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

function makePaths(overrides: Partial<ResolvedPaths> = {}): ResolvedPaths {
  return {
    claudeDir: join(tmpBase, 'claude'),
    curatorHome: join(tmpBase, 'curator'),
    claudeJson: join(tmpBase, 'claude.json'),
    projectDir: join(tmpBase, 'project'),
    ...overrides,
  };
}

/** Build a minimal McpMatrix with explicit counts */
function makeMatrix(counts: Record<string, Record<string, number>> = {}): McpMatrix {
  const servers = Object.keys(counts);
  // Derive projects from all cwd keys
  const cwdSet = new Set<string>();
  for (const serverCounts of Object.values(counts)) {
    for (const cwd of Object.keys(serverCounts)) {
      cwdSet.add(cwd);
    }
  }
  const projects = [...cwdSet].map((cwd) => ({
    cwd,
    label: cwd.split('/').pop() ?? cwd,
    total: Object.values(counts).reduce((sum, sc) => sum + (sc[cwd] ?? 0), 0),
  }));
  return { servers, projects, counts };
}

/** Write a .mcp.json with the given server names */
async function writeMcpJson(projectDir: string, serverNames: string[]): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  const mcpServers: Record<string, unknown> = {};
  for (const name of serverNames) {
    mcpServers[name] = { command: 'node', args: [`/opt/${name}/index.js`] };
  }
  await writeFile(join(projectDir, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2), 'utf8');
}

/** Write a settings.json with the given disabledMcpjsonServers array */
async function writeSettings(projectDir: string, disabled: string[]): Promise<void> {
  const settingsDir = join(projectDir, '.claude');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, 'settings.json'),
    JSON.stringify({ disabledMcpjsonServers: disabled }, null, 2),
    'utf8',
  );
}

/** Read settings.json and return parsed object */
async function readSettings(projectDir: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(projectDir, '.claude', 'settings.json'), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

// ─── buildMcpDisableProposals ──────────────────────────────────────────────────

describe('buildMcpDisableProposals — .mcp.json defined × unused', () => {
  it('proposes servers defined in .mcp.json with zero usage', async () => {
    const projectDir = join(tmpBase, 'my-project');
    await writeMcpJson(projectDir, ['server-a', 'server-b']);

    const matrix = makeMatrix({}); // zero usage for all servers

    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(2);

    const names = proposals.map((p) => p.serverName).sort();
    expect(names).toEqual(['server-a', 'server-b']);

    // Check proposal fields
    const p = proposals.find((x) => x.serverName === 'server-a')!;
    expect(p.projectDir).toBe(projectDir);
    expect(p.mcpJsonPath).toBe(join(projectDir, '.mcp.json'));
    expect(p.settingsPath).toBe(join(projectDir, '.claude', 'settings.json'));
    expect(p.reason).toContain('使用記録なし');
  });

  it('does not propose servers that have usage > 0 in the project', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['used-server', 'unused-server']);

    const matrix = makeMatrix({ 'used-server': { [projectDir]: 5 } });

    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].serverName).toBe('unused-server');
  });

  it('skips servers already in disabledMcpjsonServers', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['server-x', 'server-y']);
    await writeSettings(projectDir, ['server-x']); // server-x already disabled

    const matrix = makeMatrix({}); // zero usage

    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].serverName).toBe('server-y');
  });

  it('skips projects without .mcp.json silently', async () => {
    const projectDir = join(tmpBase, 'no-mcp-json');
    await mkdir(projectDir, { recursive: true }); // directory exists but no .mcp.json

    const matrix = makeMatrix({});
    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(0);
  });

  it('skips projects with unparseable .mcp.json silently', async () => {
    const projectDir = join(tmpBase, 'bad-mcp-json');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, '.mcp.json'), 'NOT JSON {{{{', 'utf8');

    const matrix = makeMatrix({});
    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(0);
  });

  it('skips non-existent projectDir entries silently', async () => {
    const projectDir = join(tmpBase, 'does-not-exist');
    const matrix = makeMatrix({});
    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(0);
  });

  it('does not propose global-only servers (not in any .mcp.json)', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['local-server']);

    // 'global-server' exists only in the matrix (global inventory), not in .mcp.json
    const matrix = makeMatrix({ 'global-server': { [projectDir]: 0 } });

    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    // Only local-server should be proposed (0 usage)
    expect(proposals.every((p) => p.serverName !== 'global-server')).toBe(true);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].serverName).toBe('local-server');
  });

  it('handles multiple projectDirs independently', async () => {
    const projA = join(tmpBase, 'proj-a');
    const projB = join(tmpBase, 'proj-b');
    await writeMcpJson(projA, ['svc']);
    await writeMcpJson(projB, ['svc']);

    // svc used in projA but not projB
    const matrix = makeMatrix({ svc: { [projA]: 3 } });

    const proposals = await buildMcpDisableProposals(matrix, [projA, projB]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].projectDir).toBe(projB);
    expect(proposals[0].serverName).toBe('svc');
  });
});

// ─── applyMcpDisable — settings.json creation ─────────────────────────────────

describe('applyMcpDisable — settings.json new creation', () => {
  it('creates settings.json when absent and adds disabledMcpjsonServers', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['my-server']);

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const matrix = makeMatrix({});
    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(1);

    const proposal = proposals[0];
    await applyMcpDisable(paths, proposal);

    const settings = await readSettings(projectDir);
    expect(settings['disabledMcpjsonServers']).toEqual(['my-server']);
  });

  it('creates .claude directory if missing', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['srv']);
    // Do NOT create .claude dir
    const claudeDir = join(projectDir, '.claude');
    expect(existsSync(claudeDir)).toBe(false);

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);
    await applyMcpDisable(paths, proposal);

    expect(existsSync(claudeDir)).toBe(true);
    const settings = await readSettings(projectDir);
    expect(settings['disabledMcpjsonServers']).toEqual(['srv']);
  });
});

// ─── applyMcpDisable — settings.json append ───────────────────────────────────

describe('applyMcpDisable — settings.json existing append', () => {
  it('appends to existing disabledMcpjsonServers without overwriting', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['new-server']);
    await writeSettings(projectDir, ['existing-server']);

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);
    await applyMcpDisable(paths, proposal);

    const settings = await readSettings(projectDir);
    const disabled = settings['disabledMcpjsonServers'] as string[];
    expect(disabled).toContain('existing-server');
    expect(disabled).toContain('new-server');
    expect(disabled).toHaveLength(2);
  });

  it('preserves other settings keys', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['srv']);
    const settingsDir = join(projectDir, '.claude');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify({ someOtherKey: 'value', permissions: { allow: [] } }, null, 2),
      'utf8',
    );

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);
    await applyMcpDisable(paths, proposal);

    const settings = await readSettings(projectDir);
    expect(settings['someOtherKey']).toBe('value');
    expect(settings['permissions']).toEqual({ allow: [] });
    expect(settings['disabledMcpjsonServers']).toEqual(['srv']);
  });
});

// ─── applyMcpDisable — duplicate skip ─────────────────────────────────────────

describe('applyMcpDisable — duplicate idempotency', () => {
  it('does not duplicate entry if server already in disabledMcpjsonServers', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['dup-server']);
    await writeSettings(projectDir, ['dup-server']); // already disabled

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });

    // Build proposal manually since buildMcpDisableProposals would skip it
    const proposal = {
      projectDir,
      serverName: 'dup-server',
      mcpJsonPath: join(projectDir, '.mcp.json'),
      settingsPath: join(projectDir, '.claude', 'settings.json'),
      reason: 'test',
    };
    await applyMcpDisable(paths, proposal);

    const settings = await readSettings(projectDir);
    const disabled = settings['disabledMcpjsonServers'] as string[];
    expect(disabled.filter((x) => x === 'dup-server')).toHaveLength(1);
  });
});

// ─── applyMcpDisable — backup creation ────────────────────────────────────────

describe('applyMcpDisable — backup creation', () => {
  it('creates a backup of settings.json before modifying', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['srv']);
    await writeSettings(projectDir, ['existing']);

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);
    await applyMcpDisable(paths, proposal);

    // Backup should exist in curatorHome/backups/
    const backupDir = join(tmpBase, 'curator', 'backups');
    expect(existsSync(backupDir)).toBe(true);
    const backupFiles = await readdir(backupDir);
    expect(backupFiles.some((f) => f.startsWith('settings.json.'))).toBe(true);
  });

  it('does NOT create a backup when settings.json did not exist', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['srv']);
    // No settings.json written

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);
    await applyMcpDisable(paths, proposal);

    const backupDir = join(tmpBase, 'curator', 'backups');
    if (existsSync(backupDir)) {
      const backupFiles = await readdir(backupDir);
      expect(backupFiles.filter((f) => f.startsWith('settings.json.'))).toHaveLength(0);
    }
    // If backupDir doesn't exist at all, that's also acceptable
  });
});

// ─── applyMcpDisable — settings.json parse failure abort ─────────────────────

describe('applyMcpDisable — parse failure abort', () => {
  it('throws and does NOT modify settings.json if it contains invalid JSON', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['srv']);
    const settingsDir = join(projectDir, '.claude');
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');
    await writeFile(settingsPath, 'INVALID JSON {{{', 'utf8');

    const paths = makePaths({ curatorHome: join(tmpBase, 'curator') });
    const proposal = {
      projectDir,
      serverName: 'srv',
      mcpJsonPath: join(projectDir, '.mcp.json'),
      settingsPath,
      reason: 'test',
    };

    await expect(applyMcpDisable(paths, proposal)).rejects.toThrow(/JSON parse failed/);

    // Original invalid content should remain untouched
    const content = await readFile(settingsPath, 'utf8');
    expect(content).toBe('INVALID JSON {{{');
  });
});

// ─── applyMcpDisable — journal entry ──────────────────────────────────────────

describe('applyMcpDisable — journal entry', () => {
  it('writes a journal entry with op mcp-disable', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['my-svc']);

    const curatorHome = join(tmpBase, 'curator');
    await mkdir(curatorHome, { recursive: true });
    const paths = makePaths({ curatorHome });

    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);
    await applyMcpDisable(paths, proposal);

    const journalPath = join(curatorHome, 'journal.jsonl');
    expect(existsSync(journalPath)).toBe(true);
    const lines = (await readFile(journalPath, 'utf8')).trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);

    expect(entry.op).toBe('mcp-disable');
    expect(entry.assetId).toBe('mcp-server:my-svc');
    expect(entry.archiveId).toMatch(/^mcp-disable-\d{8}-\d{6}-my-svc$/);
    expect(entry.detail).toContain('settings');
    expect(entry.ts).toBeTruthy();
  });
});

// ─── applyMcpDisable — consecutive applies ────────────────────────────────────

describe('applyMcpDisable — consecutive applies', () => {
  it('correctly accumulates entries across multiple apply calls', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['alpha', 'beta', 'gamma']);

    const curatorHome = join(tmpBase, 'curator');
    await mkdir(curatorHome, { recursive: true });
    const paths = makePaths({ curatorHome });

    const matrix = makeMatrix({});
    const proposals = await buildMcpDisableProposals(matrix, [projectDir]);
    expect(proposals).toHaveLength(3);

    // Apply one by one
    for (const proposal of proposals) {
      await applyMcpDisable(paths, proposal);
    }

    const settings = await readSettings(projectDir);
    const disabled = settings['disabledMcpjsonServers'] as string[];
    expect(disabled.sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('does not duplicate when the same server is applied twice', async () => {
    const projectDir = join(tmpBase, 'proj');
    await writeMcpJson(projectDir, ['srv']);

    const curatorHome = join(tmpBase, 'curator');
    await mkdir(curatorHome, { recursive: true });
    const paths = makePaths({ curatorHome });

    const matrix = makeMatrix({});
    const [proposal] = await buildMcpDisableProposals(matrix, [projectDir]);

    await applyMcpDisable(paths, proposal);
    await applyMcpDisable(paths, proposal); // apply twice

    const settings = await readSettings(projectDir);
    const disabled = settings['disabledMcpjsonServers'] as string[];
    expect(disabled.filter((x) => x === 'srv')).toHaveLength(1);
  });
});
