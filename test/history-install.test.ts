// history-install.test.ts — DESIGN.md §9.5 required tests
// All I/O is directed to os.tmpdir() — never touches real ~/.claude or ~/.curator
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedPaths } from '../src/paths.js';
import type { HistoryEntry } from '../src/report/cost.js';
import { buildHistoryReport, loadHistoryEntries } from '../src/report/history.js';
import { installSkill, resolveSkillSource } from '../src/apply/install-skill.js';

// ─── test helpers ─────────────────────────────────────────────────────────────

let tmpBase: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'curator-hist-test-'));
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

async function writeHistory(curatorHome: string, entries: HistoryEntry[]): Promise<void> {
  await mkdir(curatorHome, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(join(curatorHome, 'history.jsonl'), lines, 'utf8');
}

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    date: '2026-06-01',
    score: 80,
    totalTokens: 10000,
    staleTokens: 2000,
    findingCount: 3,
    ...overrides,
  };
}

// ─── history: empty ───────────────────────────────────────────────────────────

describe('buildHistoryReport: empty history', () => {
  it('returns guidance message when history.jsonl does not exist', () => {
    const paths = makePaths();
    const result = buildHistoryReport(paths.curatorHome);
    expect(result.text).toContain('curator cost');
    expect(result.text).toContain('履歴がありません');
    expect((result.json as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it('returns guidance message when history.jsonl is empty', async () => {
    const paths = makePaths();
    await mkdir(paths.curatorHome, { recursive: true });
    await writeFile(join(paths.curatorHome, 'history.jsonl'), '', 'utf8');
    const result = buildHistoryReport(paths.curatorHome);
    expect(result.text).toContain('履歴がありません');
  });
});

// ─── history: same-day dedup (last entry wins) ───────────────────────────────

describe('buildHistoryReport: same-day dedup', () => {
  it('keeps last entry when multiple entries share the same date', async () => {
    const paths = makePaths();
    const entries: HistoryEntry[] = [
      makeHistoryEntry({ date: '2026-06-01', score: 60, totalTokens: 5000, staleTokens: 2000 }),
      makeHistoryEntry({ date: '2026-06-01', score: 75, totalTokens: 5000, staleTokens: 1250 }), // same day — this should win
      makeHistoryEntry({ date: '2026-06-02', score: 90, totalTokens: 8000, staleTokens: 800 }),
    ];
    await writeHistory(paths.curatorHome, entries);

    const loaded = loadHistoryEntries(paths.curatorHome);
    expect(loaded).toHaveLength(2); // 2 unique dates
    const june1 = loaded.find((e) => e.date === '2026-06-01');
    expect(june1?.score).toBe(75); // last entry for that day wins
  });

  it('reflects last-entry score in text output', async () => {
    const paths = makePaths();
    await writeHistory(paths.curatorHome, [
      makeHistoryEntry({ date: '2026-06-01', score: 40 }),
      makeHistoryEntry({ date: '2026-06-01', score: 99 }), // overrides
    ]);
    const result = buildHistoryReport(paths.curatorHome);
    expect(result.text).toContain('99');
    expect(result.text).not.toContain('40');
  });
});

// ─── history: limit ───────────────────────────────────────────────────────────

describe('buildHistoryReport: limit', () => {
  it('respects default limit of 30 (keeps newest)', async () => {
    const paths = makePaths();
    // Write 35 entries on distinct days
    const entries: HistoryEntry[] = Array.from({ length: 35 }, (_, i) =>
      makeHistoryEntry({
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        score: 50 + i,
      }),
    );
    await writeHistory(paths.curatorHome, entries);

    const loaded = loadHistoryEntries(paths.curatorHome);
    expect(loaded).toHaveLength(30);
    // Should be the newest 30 (days 06 to 35)
    expect(loaded[0].date).toBe('2026-01-06');
    expect(loaded[29].date).toBe('2026-01-35');
  });

  it('respects custom limit', async () => {
    const paths = makePaths();
    const entries: HistoryEntry[] = Array.from({ length: 10 }, (_, i) =>
      makeHistoryEntry({ date: `2026-06-${String(i + 1).padStart(2, '0')}` }),
    );
    await writeHistory(paths.curatorHome, entries);

    const loaded = loadHistoryEntries(paths.curatorHome, 5);
    expect(loaded).toHaveLength(5);
    // Newest 5 (days 06 to 10)
    expect(loaded[0].date).toBe('2026-06-06');
    expect(loaded[4].date).toBe('2026-06-10');
  });

  it('returns all entries when count is under limit', async () => {
    const paths = makePaths();
    await writeHistory(paths.curatorHome, [
      makeHistoryEntry({ date: '2026-06-01' }),
      makeHistoryEntry({ date: '2026-06-02' }),
    ]);
    const loaded = loadHistoryEntries(paths.curatorHome, 30);
    expect(loaded).toHaveLength(2);
  });
});

// ─── history: text output includes sparkline ─────────────────────────────────

describe('buildHistoryReport: text output', () => {
  it('includes sparkline with block characters', async () => {
    const paths = makePaths();
    await writeHistory(paths.curatorHome, [
      makeHistoryEntry({ date: '2026-06-01', score: 0 }),
      makeHistoryEntry({ date: '2026-06-02', score: 100 }),
    ]);
    const result = buildHistoryReport(paths.curatorHome);
    expect(result.text).toContain('▁');
    expect(result.text).toContain('█');
  });

  it('includes table header with date / score / total / stale', async () => {
    const paths = makePaths();
    await writeHistory(paths.curatorHome, [makeHistoryEntry()]);
    const result = buildHistoryReport(paths.curatorHome);
    expect(result.text).toContain('日付');
    expect(result.text).toContain('score');
    expect(result.text).toContain('total');
    expect(result.text).toContain('stale');
  });

  it('skips malformed lines in history.jsonl', async () => {
    const paths = makePaths();
    await mkdir(paths.curatorHome, { recursive: true });
    const content =
      '{"date":"2026-06-01","score":80,"totalTokens":5000,"staleTokens":1000,"findingCount":2}\n' +
      'this is not json\n' +
      '{"date":"2026-06-02","score":90,"totalTokens":6000,"staleTokens":600,"findingCount":1}\n';
    await writeFile(join(paths.curatorHome, 'history.jsonl'), content, 'utf8');

    const loaded = loadHistoryEntries(paths.curatorHome);
    expect(loaded).toHaveLength(2);
  });
});

// ─── install-skill: copy success ─────────────────────────────────────────────

describe('installSkill: copy success', () => {
  it('copies SKILL.md to <claudeDir>/skills/curator/SKILL.md', async () => {
    const paths = makePaths();

    const result = await installSkill(paths);
    expect(result.installedTo).toBe(join(paths.claudeDir, 'skills', 'curator', 'SKILL.md'));
    expect(existsSync(result.installedTo)).toBe(true);
  });

  it('creates intermediate directories as needed', async () => {
    const paths = makePaths();
    // claudeDir does not exist yet
    expect(existsSync(paths.claudeDir)).toBe(false);

    await installSkill(paths);
    expect(existsSync(join(paths.claudeDir, 'skills', 'curator', 'SKILL.md'))).toBe(true);
  });

  it('writes a journal entry with op install-skill', async () => {
    const paths = makePaths();
    await installSkill(paths);

    const journalPath = join(paths.curatorHome, 'journal.jsonl');
    expect(existsSync(journalPath)).toBe(true);
    const line = JSON.parse(readFileSync(journalPath, 'utf8').trim());
    expect(line.op).toBe('install-skill');
    expect(line.assetId).toBe('skill:curator');
  });

  it('copied content matches source SKILL.md', async () => {
    const paths = makePaths();
    const result = await installSkill(paths);

    const src = resolveSkillSource();
    const srcContent = readFileSync(src, 'utf8');
    const dstContent = readFileSync(result.installedTo, 'utf8');
    expect(dstContent).toBe(srcContent);
  });
});

// ─── install-skill: existing file error ──────────────────────────────────────

describe('installSkill: existing file error', () => {
  it('throws when destination exists and force is not set', async () => {
    const paths = makePaths();
    // Install once
    await installSkill(paths);

    // Second install without --force should throw
    await expect(installSkill(paths)).rejects.toThrow();
  });

  it('error message mentions --force', async () => {
    const paths = makePaths();
    await installSkill(paths);

    let errorMsg = '';
    try {
      await installSkill(paths);
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    expect(errorMsg).toContain('--force');
  });
});

// ─── install-skill: --force overwrite ────────────────────────────────────────

describe('installSkill: --force overwrite', () => {
  it('overwrites existing file when force=true', async () => {
    const paths = makePaths();
    await installSkill(paths);

    const destPath = join(paths.claudeDir, 'skills', 'curator', 'SKILL.md');

    // Corrupt the file
    await writeFile(destPath, 'corrupted content', 'utf8');
    expect(readFileSync(destPath, 'utf8')).toBe('corrupted content');

    // Force overwrite
    const result = await installSkill(paths, { force: true });
    expect(result.installedTo).toBe(destPath);

    const src = resolveSkillSource();
    const srcContent = readFileSync(src, 'utf8');
    expect(readFileSync(destPath, 'utf8')).toBe(srcContent);
  });
});

// ─── install-skill: source not found error ────────────────────────────────────

describe('installSkill: source not found error', () => {
  it('throws a clear error when skill source does not exist', async () => {
    const paths = makePaths();

    // Use the _skillSource override to point to a non-existent file
    await expect(
      installSkill(paths, { _skillSource: '/nonexistent/path/SKILL.md' }),
    ).rejects.toThrow('skill/SKILL.md が見つかりません');
  });

  it('error message includes the bad path', async () => {
    const paths = makePaths();
    const badPath = '/nonexistent/path/SKILL.md';

    let errorMsg = '';
    try {
      await installSkill(paths, { _skillSource: badPath });
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    expect(errorMsg).toContain(badPath);
  });
});
