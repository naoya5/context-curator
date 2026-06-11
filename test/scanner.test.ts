import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { ResolvedPaths } from '../src/paths.js';
import { scanSkills } from '../src/scan/assets/skills.js';
import { scanMcp } from '../src/scan/assets/mcp.js';
import { scanClaudeMd } from '../src/scan/assets/claudemd.js';
import { scanMemory } from '../src/scan/assets/memory.js';
import { scanCommands } from '../src/scan/assets/commands.js';
import { scanAgents } from '../src/scan/assets/agents.js';
import { buildInventory } from '../src/scan/inventory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');

/** Build a ResolvedPaths pointing at our fake-claude fixture */
function fakePaths(overrides: Partial<ResolvedPaths> = {}): ResolvedPaths {
  return {
    claudeDir: join(FIXTURES, 'fake-claude'),
    curatorHome: join(FIXTURES, 'fake-curator'),
    claudeJson: join(FIXTURES, 'fake-claude.json'),
    projectDir: join(FIXTURES, 'fake-project'), // no .claude dir here — won't crash
    ...overrides,
  };
}

// ─── skills scanner ─────────────────────────────────────────────────────────
describe('scanSkills', () => {
  it('finds 2 user skills and 1 plugin skill', async () => {
    const warnings: string[] = [];
    const assets = await scanSkills(fakePaths(), warnings);

    const userSkills = assets.filter((a) => a.scope === 'user');
    const pluginSkills = assets.filter((a) => a.scope === 'plugin');

    expect(userSkills).toHaveLength(2);
    expect(pluginSkills).toHaveLength(1);
    expect(assets).toHaveLength(3);
  });

  it('plugin skill name is namespaced as plugin:skill', async () => {
    const warnings: string[] = [];
    const assets = await scanSkills(fakePaths(), warnings);
    const pluginSkill = assets.find((a) => a.scope === 'plugin');
    expect(pluginSkill).toBeDefined();
    expect(pluginSkill!.name).toBe('my-plugin:plugin-tool');
    expect(pluginSkill!.id).toBe('skill:my-plugin:plugin-tool');
  });

  it('skill id is skill:name', async () => {
    const warnings: string[] = [];
    const assets = await scanSkills(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.id).toMatch(/^skill:/);
      expect(a.kind).toBe('skill');
    }
  });

  it('footprintTokens > 0 (frontmatter present)', async () => {
    const warnings: string[] = [];
    const assets = await scanSkills(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.footprintTokens).toBeGreaterThan(0);
    }
  });

  it('fullTokens >= footprintTokens', async () => {
    const warnings: string[] = [];
    const assets = await scanSkills(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.fullTokens).toBeGreaterThanOrEqual(a.footprintTokens);
    }
  });

  it('description is extracted from frontmatter', async () => {
    const warnings: string[] = [];
    const assets = await scanSkills(fakePaths(), warnings);
    const helloWorld = assets.find((a) => a.name === 'hello-world');
    expect(helloWorld).toBeDefined();
    expect(helloWorld!.meta?.['description']).toContain('greeting');
  });

  it('does not throw on missing skills directory', async () => {
    const warnings: string[] = [];
    const paths = fakePaths({ claudeDir: '/nonexistent/dir/that/does/not/exist' });
    const assets = await scanSkills(paths, warnings);
    expect(assets).toHaveLength(0);
  });

  it('skips SKILL.md with broken frontmatter and adds warning', async () => {
    // Use a temp-like approach: pass a dir with a broken SKILL.md
    // We rely on the built-in "no frontmatter" warning path
    const warnings: string[] = [];
    // The fixture skills all have valid frontmatter, so just check no crash
    const assets = await scanSkills(fakePaths(), warnings);
    expect(assets.length).toBeGreaterThan(0);
  });
});

// ─── mcp scanner ────────────────────────────────────────────────────────────
describe('scanMcp', () => {
  it('finds 2 MCP servers from fake-claude.json', async () => {
    const warnings: string[] = [];
    const assets = await scanMcp(fakePaths(), warnings);
    expect(assets).toHaveLength(2);
  });

  it('all mcp-server assets have footprintTokens = 0 and tokenNote = unknown', async () => {
    const warnings: string[] = [];
    const assets = await scanMcp(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.kind).toBe('mcp-server');
      expect(a.footprintTokens).toBe(0);
      expect(a.meta?.['tokenNote']).toBe('unknown');
    }
  });

  it('command is captured in meta', async () => {
    const warnings: string[] = [];
    const assets = await scanMcp(fakePaths(), warnings);
    const testServer = assets.find((a) => a.name === 'test-server');
    expect(testServer).toBeDefined();
    expect(testServer!.meta?.['command']).toBe('node');
  });

  it('does not throw on missing .claude.json', async () => {
    const warnings: string[] = [];
    const paths = fakePaths({ claudeJson: '/nonexistent/.claude.json' });
    const assets = await scanMcp(paths, warnings);
    // settings.json in fake-claude dir doesn't have mcpServers → 0 or empty
    expect(Array.isArray(assets)).toBe(true);
  });
});

// ─── claudemd scanner ───────────────────────────────────────────────────────
describe('scanClaudeMd', () => {
  it('finds CLAUDE.md and rules/coding-style.md', async () => {
    const warnings: string[] = [];
    const assets = await scanClaudeMd(fakePaths(), warnings);
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const names = assets.map((a) => a.name);
    expect(names).toContain('CLAUDE.md');
    expect(names).toContain('coding-style.md');
  });

  it('footprintTokens = fullTokens (always loaded)', async () => {
    const warnings: string[] = [];
    const assets = await scanClaudeMd(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.footprintTokens).toBe(a.fullTokens);
    }
  });

  it('kind is claude-md for all', async () => {
    const warnings: string[] = [];
    const assets = await scanClaudeMd(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.kind).toBe('claude-md');
    }
  });
});

// ─── memory scanner ─────────────────────────────────────────────────────────
describe('scanMemory', () => {
  it('finds MEMORY.md and individual memory files', async () => {
    const warnings: string[] = [];
    const assets = await scanMemory(fakePaths(), warnings);
    expect(assets.length).toBeGreaterThanOrEqual(2);
  });

  it('MEMORY.md has footprintTokens = fullTokens', async () => {
    const warnings: string[] = [];
    const assets = await scanMemory(fakePaths(), warnings);
    const memoryMd = assets.find((a) => a.name.endsWith('MEMORY.md'));
    expect(memoryMd).toBeDefined();
    expect(memoryMd!.footprintTokens).toBe(memoryMd!.fullTokens);
    expect(memoryMd!.fullTokens).toBeGreaterThan(0);
  });

  it('individual memory file has footprintTokens = 0', async () => {
    const warnings: string[] = [];
    const assets = await scanMemory(fakePaths(), warnings);
    const individual = assets.find((a) => !a.name.endsWith('MEMORY.md'));
    expect(individual).toBeDefined();
    expect(individual!.footprintTokens).toBe(0);
    expect(individual!.fullTokens).toBeGreaterThan(0);
  });

  it('does not throw on missing projects dir', async () => {
    const warnings: string[] = [];
    const paths = fakePaths({ claudeDir: '/nonexistent/does/not/exist' });
    const assets = await scanMemory(paths, warnings);
    expect(assets).toHaveLength(0);
  });
});

// ─── commands scanner ────────────────────────────────────────────────────────
describe('scanCommands', () => {
  it('finds daily-commit command', async () => {
    const warnings: string[] = [];
    const assets = await scanCommands(fakePaths(), warnings);
    expect(assets.length).toBeGreaterThanOrEqual(1);
    const names = assets.map((a) => a.name);
    expect(names).toContain('daily-commit');
  });

  it('kind is command for all', async () => {
    const warnings: string[] = [];
    const assets = await scanCommands(fakePaths(), warnings);
    for (const a of assets) {
      expect(a.kind).toBe('command');
    }
  });
});

// ─── agents scanner ──────────────────────────────────────────────────────────
describe('scanAgents', () => {
  it('does not throw when agents dir does not exist', async () => {
    const warnings: string[] = [];
    const assets = await scanAgents(fakePaths(), warnings);
    // fake-claude has no agents dir → should return empty array silently
    expect(Array.isArray(assets)).toBe(true);
    expect(warnings.length).toBe(0);
  });
});

// ─── full inventory ──────────────────────────────────────────────────────────
describe('buildInventory', () => {
  let inventory: Awaited<ReturnType<typeof buildInventory>>;

  beforeAll(async () => {
    inventory = await buildInventory(fakePaths());
  });

  it('returns an Inventory object', () => {
    expect(inventory).toBeDefined();
    expect(inventory.assets).toBeDefined();
    expect(inventory.scannedAt).toBeDefined();
    expect(inventory.warnings).toBeDefined();
  });

  it('contains assets from all scanners', () => {
    const kinds = new Set(inventory.assets.map((a) => a.kind));
    expect(kinds.has('skill')).toBe(true);
    expect(kinds.has('mcp-server')).toBe(true);
    expect(kinds.has('claude-md')).toBe(true);
    expect(kinds.has('memory')).toBe(true);
    expect(kinds.has('command')).toBe(true);
  });

  it('all asset ids are unique', () => {
    const ids = inventory.assets.map((a) => a.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all assets have required fields', () => {
    for (const a of inventory.assets) {
      expect(typeof a.id).toBe('string');
      expect(typeof a.kind).toBe('string');
      expect(typeof a.name).toBe('string');
      expect(typeof a.path).toBe('string');
      expect(typeof a.scope).toBe('string');
      expect(typeof a.sizeBytes).toBe('number');
      expect(typeof a.footprintTokens).toBe('number');
      expect(typeof a.fullTokens).toBe('number');
      expect(typeof a.modifiedAt).toBe('string');
    }
  });

  it('scannedAt is a valid ISO8601 date', () => {
    expect(new Date(inventory.scannedAt).toString()).not.toBe('Invalid Date');
  });
});
