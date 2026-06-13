// memory-lint.test.ts — unit tests for policy/memory-lint.ts (DESIGN.md §10.4)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Asset } from '../src/types.js';
import type { PolicyConfig } from '../src/config.js';
import { lintMemories } from '../src/policy/memory-lint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const POLICY: PolicyConfig = {
  staleDays: 30,
  unusedGraceDays: 14,
  bloat: {
    claudeMdTokens: 3000,
    skillFullTokens: 8000,
    memoryFileTokens: 2000,
  },
  duplicateThreshold: 0.65,
  memoryLint: {
    oldDateDays: 180,
    duplicateThreshold: 0.7,
  },
};

function makeMemoryAsset(
  filePath: string,
  overrides: Partial<Asset> = {},
): Asset {
  const name = filePath.split('/').slice(-2).join('/'); // slug/filename
  return {
    id: `memory:${name}`,
    kind: 'memory',
    name,
    path: filePath,
    scope: 'user',
    sizeBytes: 100,
    footprintTokens: 0,
    fullTokens: 50,
    modifiedAt: '2026-01-01T00:00:00Z',
    meta: {},
    ...overrides,
  };
}

// Fixed "now" for reproducible old-date tests: 2026-06-13
const NOW = new Date('2026-06-13T00:00:00Z');

// ---------------------------------------------------------------------------
// Test fixture setup (temp directory)
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `memory-lint-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// [old-date] rule
// ---------------------------------------------------------------------------

describe('[old-date] rule', () => {
  it('detects a file whose newest ISO date is > oldDateDays ago', async () => {
    // 2025-11-01 is ~224 days before 2026-06-13 → > 180 days
    const content = '# Memory\n\n- [x] done 2025-11-01\n- note about 2025-10-01';
    const filePath = join(tmpDir, 'MEMORY.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const findings = await lintMemories([asset], POLICY, NOW);
    const oldDate = findings.filter((f) => f.reason.startsWith('[old-date]'));
    expect(oldDate).toHaveLength(1);
    expect(oldDate[0]!.severity).toBe('info');
    expect(oldDate[0]!.reason).toContain('[old-date]');
    expect(oldDate[0]!.reason).toContain('2025-11-01');
  });

  it('does NOT flag a file whose newest ISO date is within oldDateDays', async () => {
    // 2026-05-01 is ~43 days before 2026-06-13 → < 180 days
    const content = '# Memory\n\n- updated 2026-05-01\n- earlier 2025-01-01';
    const filePath = join(tmpDir, 'recent.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const findings = await lintMemories([asset], POLICY, NOW);
    const oldDate = findings.filter((f) => f.reason.startsWith('[old-date]'));
    expect(oldDate).toHaveLength(0);
  });

  it('does NOT flag a file that contains no ISO dates', async () => {
    const content = '# Memory\n\n- no dates here at all\n- just text';
    const filePath = join(tmpDir, 'nodates.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const findings = await lintMemories([asset], POLICY, NOW);
    const oldDate = findings.filter((f) => f.reason.startsWith('[old-date]'));
    expect(oldDate).toHaveLength(0);
  });

  it('uses the MAXIMUM date when multiple dates are present', async () => {
    // Oldest is 2020-01-01 but newest is 2026-06-01 (12 days ago) → no flag
    const content = '# Memory\n\n- 2020-01-01 old\n- 2026-06-01 recent';
    const filePath = join(tmpDir, 'multi.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const findings = await lintMemories([asset], POLICY, NOW);
    const oldDate = findings.filter((f) => f.reason.startsWith('[old-date]'));
    expect(oldDate).toHaveLength(0);
  });

  it('respects custom oldDateDays threshold', async () => {
    // 2026-05-01 is ~43 days before 2026-06-13
    const content = '# Memory\n\n- 2026-05-01';
    const filePath = join(tmpDir, 'custom.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const strictPolicy: PolicyConfig = {
      ...POLICY,
      memoryLint: { ...POLICY.memoryLint, oldDateDays: 30 },
    };

    const findings = await lintMemories([asset], strictPolicy, NOW);
    const oldDate = findings.filter((f) => f.reason.startsWith('[old-date]'));
    expect(oldDate).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [broken-link] rule
// ---------------------------------------------------------------------------

describe('[broken-link] rule', () => {
  it('detects a [[wikilink]] that has no matching file in the same directory', async () => {
    const content = '# Memory\n\n- See [[missing-file]] for details';
    const filePath = join(tmpDir, 'MEMORY.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const findings = await lintMemories([asset], POLICY, NOW);
    const broken = findings.filter((f) => f.reason.startsWith('[broken-link]'));
    expect(broken).toHaveLength(1);
    expect(broken[0]!.severity).toBe('warn');
    expect(broken[0]!.reason).toContain('[[missing-file]]');
  });

  it('does NOT flag a [[wikilink]] whose target file exists', async () => {
    // Create both files in same directory
    const targetPath = join(tmpDir, 'existing-file.md');
    writeFileSync(targetPath, '# Existing', 'utf-8');

    const content = '# Memory\n\n- See [[existing-file]] for details';
    const filePath = join(tmpDir, 'MEMORY.md');
    writeFileSync(filePath, content, 'utf-8');

    const memoryAsset = makeMemoryAsset(filePath);
    const existingAsset = makeMemoryAsset(targetPath);

    const findings = await lintMemories([memoryAsset, existingAsset], POLICY, NOW);
    const broken = findings.filter((f) => f.reason.startsWith('[broken-link]'));
    expect(broken).toHaveLength(0);
  });

  it('accepts [[name|alias]] syntax and checks the name part only', async () => {
    const targetPath = join(tmpDir, 'target.md');
    writeFileSync(targetPath, '# Target', 'utf-8');

    const content = '# Memory\n\n- See [[target|Display Name]] for details';
    const filePath = join(tmpDir, 'MEMORY.md');
    writeFileSync(filePath, content, 'utf-8');

    const memoryAsset = makeMemoryAsset(filePath);
    const targetAsset = makeMemoryAsset(targetPath);

    const findings = await lintMemories([memoryAsset, targetAsset], POLICY, NOW);
    const broken = findings.filter((f) => f.reason.startsWith('[broken-link]'));
    expect(broken).toHaveLength(0);
  });

  it('resolves [[name]] against frontmatter name field', async () => {
    // Target has frontmatter name: 'custom-name'
    const targetContent = '---\nname: custom-name\n---\n# Target';
    const targetPath = join(tmpDir, 'target-file.md');
    writeFileSync(targetPath, targetContent, 'utf-8');

    const content = '# Memory\n\n- See [[custom-name]] for details';
    const filePath = join(tmpDir, 'MEMORY.md');
    writeFileSync(filePath, content, 'utf-8');

    const memoryAsset = makeMemoryAsset(filePath);
    const targetAsset = makeMemoryAsset(targetPath);

    const findings = await lintMemories([memoryAsset, targetAsset], POLICY, NOW);
    const broken = findings.filter((f) => f.reason.startsWith('[broken-link]'));
    expect(broken).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [index-mismatch] rule
// ---------------------------------------------------------------------------

describe('[index-mismatch] rule', () => {
  it('detects (file.md) link in MEMORY.md that does not exist on disk', async () => {
    const content = '# Index\n\n- [note](nonexistent.md)';
    const filePath = join(tmpDir, 'MEMORY.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath, { meta: { isMemoryMd: true } });

    const findings = await lintMemories([asset], POLICY, NOW);
    const mismatch = findings.filter((f) => f.reason.startsWith('[index-mismatch]'));
    expect(mismatch.some((f) => f.reason.includes('nonexistent.md'))).toBe(true);
    expect(mismatch[0]!.severity).toBe('warn');
  });

  it('detects a .md file in the directory that is not referenced by MEMORY.md', async () => {
    // MEMORY.md references only file-a.md; file-b.md is orphan
    const fileA = join(tmpDir, 'file-a.md');
    const fileB = join(tmpDir, 'file-b.md');
    writeFileSync(fileA, '# A', 'utf-8');
    writeFileSync(fileB, '# B', 'utf-8');

    const memoryContent = '# Index\n\n- [a](file-a.md)';
    const memoryPath = join(tmpDir, 'MEMORY.md');
    writeFileSync(memoryPath, memoryContent, 'utf-8');

    const memoryAsset = makeMemoryAsset(memoryPath, { meta: { isMemoryMd: true } });
    const assetA = makeMemoryAsset(fileA);
    const assetB = makeMemoryAsset(fileB);

    const findings = await lintMemories([memoryAsset, assetA, assetB], POLICY, NOW);
    const mismatch = findings.filter((f) => f.reason.startsWith('[index-mismatch]'));
    expect(mismatch.some((f) => f.reason.includes('file-b.md'))).toBe(true);
  });

  it('does NOT flag when all .md files are referenced and all links resolve', async () => {
    const fileA = join(tmpDir, 'file-a.md');
    writeFileSync(fileA, '# A', 'utf-8');

    const memoryContent = '# Index\n\n- [a](file-a.md)';
    const memoryPath = join(tmpDir, 'MEMORY.md');
    writeFileSync(memoryPath, memoryContent, 'utf-8');

    const memoryAsset = makeMemoryAsset(memoryPath, { meta: { isMemoryMd: true } });
    const assetA = makeMemoryAsset(fileA);

    const findings = await lintMemories([memoryAsset, assetA], POLICY, NOW);
    const mismatch = findings.filter((f) => f.reason.startsWith('[index-mismatch]'));
    expect(mismatch).toHaveLength(0);
  });

  it('only applies [index-mismatch] rule to MEMORY.md, not to other files', async () => {
    // other.md has a (link.md) pattern but it should not trigger index-mismatch
    const content = '# Other\n\n- see (nonexistent.md)';
    const filePath = join(tmpDir, 'other.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    const findings = await lintMemories([asset], POLICY, NOW);
    const mismatch = findings.filter((f) => f.reason.startsWith('[index-mismatch]'));
    expect(mismatch).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [near-duplicate] rule
// ---------------------------------------------------------------------------

describe('[near-duplicate] rule', () => {
  it('detects two files with high textual similarity', async () => {
    const sharedText =
      'This memory stores information about the project task workflow. ' +
      'Tasks are delegated to builder and reviewer agents. ' +
      'Commander orchestrates the overall workflow cycle.';

    const fileA = join(tmpDir, 'workflow-a.md');
    const fileB = join(tmpDir, 'workflow-b.md');
    // Nearly identical content
    writeFileSync(fileA, `# Workflow A\n\n${sharedText}`, 'utf-8');
    writeFileSync(fileB, `# Workflow B\n\n${sharedText} Minor difference here.`, 'utf-8');

    const assetA = makeMemoryAsset(fileA);
    const assetB = makeMemoryAsset(fileB);

    const findings = await lintMemories([assetA, assetB], POLICY, NOW);
    const dups = findings.filter((f) => f.reason.startsWith('[near-duplicate]'));
    expect(dups).toHaveLength(1);
    expect(dups[0]!.severity).toBe('info');
    expect(dups[0]!.reason).toContain('%');
    expect(dups[0]!.counterpartId).toBeDefined();
  });

  it('does NOT flag two files with low textual similarity', async () => {
    const fileA = join(tmpDir, 'alpha.md');
    const fileB = join(tmpDir, 'beta.md');
    writeFileSync(fileA, '# Alpha\n\nThis is about authentication and login systems.', 'utf-8');
    writeFileSync(fileB, '# Beta\n\nThis covers database migrations and schema changes.', 'utf-8');

    const assetA = makeMemoryAsset(fileA);
    const assetB = makeMemoryAsset(fileB);

    const findings = await lintMemories([assetA, assetB], POLICY, NOW);
    const dups = findings.filter((f) => f.reason.startsWith('[near-duplicate]'));
    expect(dups).toHaveLength(0);
  });

  it('respects custom duplicateThreshold', async () => {
    // Slightly similar content (~40-50% overlap)
    const fileA = join(tmpDir, 'mem-a.md');
    const fileB = join(tmpDir, 'mem-b.md');
    const shared = 'memory workflow task agent builder reviewer';
    writeFileSync(fileA, `# A\n\n${shared} extra specific content only in a`, 'utf-8');
    writeFileSync(fileB, `# B\n\n${shared} different specific content only in b`, 'utf-8');

    const assetA = makeMemoryAsset(fileA);
    const assetB = makeMemoryAsset(fileB);

    // With high threshold (0.95) → no detection
    const strictPolicy: PolicyConfig = {
      ...POLICY,
      memoryLint: { ...POLICY.memoryLint, duplicateThreshold: 0.95 },
    };
    const strictFindings = await lintMemories([assetA, assetB], strictPolicy, NOW);
    const strictDups = strictFindings.filter((f) => f.reason.startsWith('[near-duplicate]'));
    expect(strictDups).toHaveLength(0);

    // With low threshold (0.1) → detected
    const loosePolicy: PolicyConfig = {
      ...POLICY,
      memoryLint: { ...POLICY.memoryLint, duplicateThreshold: 0.1 },
    };
    const looseFindings = await lintMemories([assetA, assetB], loosePolicy, NOW);
    const looseDups = looseFindings.filter((f) => f.reason.startsWith('[near-duplicate]'));
    expect(looseDups).toHaveLength(1);
  });

  it('only compares files within the same directory', async () => {
    // Files in different directories should not be compared
    const dirA = join(tmpDir, 'proj-a');
    const dirB = join(tmpDir, 'proj-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const sharedText =
      'identical memory content about workflow tasks and agent orchestration patterns';
    const fileA = join(dirA, 'MEMORY.md');
    const fileB = join(dirB, 'MEMORY.md');
    writeFileSync(fileA, `# Memory\n\n${sharedText}`, 'utf-8');
    writeFileSync(fileB, `# Memory\n\n${sharedText}`, 'utf-8');

    const assetA = makeMemoryAsset(fileA);
    const assetB = makeMemoryAsset(fileB);

    const findings = await lintMemories([assetA, assetB], POLICY, NOW);
    const dups = findings.filter((f) => f.reason.startsWith('[near-duplicate]'));
    // Different directories → no cross-dir comparison
    expect(dups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Robustness: broken frontmatter must not crash
// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('does not crash when frontmatter is malformed', async () => {
    const content = '---\nbroken: [unclosed bracket\nno: close\n# Body\n\n- 2025-01-01';
    const filePath = join(tmpDir, 'broken-fm.md');
    writeFileSync(filePath, content, 'utf-8');
    const asset = makeMemoryAsset(filePath);

    // Should not throw
    await expect(lintMemories([asset], POLICY, NOW)).resolves.toBeDefined();
  });

  it('does not crash on empty file', async () => {
    const filePath = join(tmpDir, 'empty.md');
    writeFileSync(filePath, '', 'utf-8');
    const asset = makeMemoryAsset(filePath);

    await expect(lintMemories([asset], POLICY, NOW)).resolves.toBeDefined();
  });

  it('returns empty array when no memory assets are provided', async () => {
    const findings = await lintMemories([], POLICY, NOW);
    expect(findings).toEqual([]);
  });

  it('ignores non-memory assets', async () => {
    const nonMemory: Asset = {
      id: 'skill:test',
      kind: 'skill',
      name: 'test-skill',
      path: join(tmpDir, 'SKILL.md'),
      scope: 'user',
      sizeBytes: 100,
      footprintTokens: 0,
      fullTokens: 50,
      modifiedAt: '2020-01-01T00:00:00Z',
      meta: {},
    };

    const findings = await lintMemories([nonMemory], POLICY, NOW);
    expect(findings).toEqual([]);
  });

  it('skips unreadable files without throwing', async () => {
    // Asset pointing to a non-existent file
    const asset = makeMemoryAsset(join(tmpDir, 'ghost.md'));
    // File does NOT exist on disk → should be skipped
    await expect(lintMemories([asset], POLICY, NOW)).resolves.toBeDefined();
  });
});
