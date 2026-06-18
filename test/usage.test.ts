// test/usage.test.ts — Usage Tracker tests (DESIGN.md §5)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import type { ResolvedPaths } from '../src/paths.js';
import { extractEventsFromLines } from '../src/usage/extract.js';
import { parseTranscript } from '../src/usage/transcript.js';
import { updateLedger, loadUsageStats, clearLedger } from '../src/usage/ledger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const TRANSCRIPTS = join(FIXTURES, 'transcripts');

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeLineFromRaw(raw: unknown, lineNumber = 1) {
  return { raw, lineNumber };
}

let tmpDir: string;

async function makeTempPaths(): Promise<ResolvedPaths> {
  tmpDir = await mkdtemp(join(tmpdir(), 'curator-test-'));
  const curatorHome = join(tmpDir, 'curator');
  await mkdir(curatorHome, { recursive: true });
  return {
    claudeDir: join(tmpDir, 'claude'),
    curatorHome,
    claudeJson: join(tmpDir, 'claude.json'),
    projectDir: join(tmpDir, 'project'),
  };
}

// ── extract.ts: tool name decomposition ──────────────────────────────────────

describe('extractEventsFromLines — tool name decomposition', () => {
  const BASE = {
    type: 'assistant',
    timestamp: '2026-06-01T10:00:00.000Z',
    sessionId: 'sess-001',
    cwd: '/home/user/project',
  } as const;

  function assistantLine(toolName: string, input: Record<string, unknown> = {}) {
    return fakeLineFromRaw({
      ...BASE,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: toolName, input }],
      },
    });
  }

  it('Skill → kind:skill, ref = input.skill', () => {
    const { events } = extractEventsFromLines([
      assistantLine('Skill', { skill: 'article-workflow' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('skill');
    expect(events[0].ref).toBe('article-workflow');
    expect(events[0].tool).toBeUndefined();
  });

  it('Skill with plugin namespace (superpowers:writing-plans)', () => {
    const { events } = extractEventsFromLines([
      assistantLine('Skill', { skill: 'superpowers:writing-plans' }),
    ]);
    expect(events[0].ref).toBe('superpowers:writing-plans');
  });

  it('mcp__a__b → server=a, tool=b', () => {
    const { events } = extractEventsFromLines([assistantLine('mcp__a__b')]);
    expect(events[0].kind).toBe('mcp-tool');
    expect(events[0].ref).toBe('a');
    expect(events[0].tool).toBe('b');
  });

  it('mcp__a__b__c → server=a, tool=b__c (parts[0]=server, rest joined)', () => {
    const { events } = extractEventsFromLines([assistantLine('mcp__a__b__c')]);
    expect(events[0].kind).toBe('mcp-tool');
    expect(events[0].ref).toBe('a');
    expect(events[0].tool).toBe('b__c');
  });

  it('mcp__plugin_context-mode_context-mode__ctx_search → correct split', () => {
    const { events } = extractEventsFromLines([
      assistantLine('mcp__plugin_context-mode_context-mode__ctx_search'),
    ]);
    expect(events[0].kind).toBe('mcp-tool');
    expect(events[0].ref).toBe('plugin_context-mode_context-mode');
    expect(events[0].tool).toBe('ctx_search');
  });

  it('mcp__claude_ai_Notion__notion-search → correct split', () => {
    const { events } = extractEventsFromLines([
      assistantLine('mcp__claude_ai_Notion__notion-search'),
    ]);
    expect(events[0].kind).toBe('mcp-tool');
    expect(events[0].ref).toBe('claude_ai_Notion');
    expect(events[0].tool).toBe('notion-search');
  });

  it('Agent → kind:agent, ref = subagent_type', () => {
    const { events } = extractEventsFromLines([
      assistantLine('Agent', { subagent_type: 'code-review' }),
    ]);
    expect(events[0].kind).toBe('agent');
    expect(events[0].ref).toBe('code-review');
  });

  it('Task → kind:agent, ref = subagent_type', () => {
    const { events } = extractEventsFromLines([
      assistantLine('Task', { subagent_type: 'planner' }),
    ]);
    expect(events[0].kind).toBe('agent');
    expect(events[0].ref).toBe('planner');
  });

  it('Agent without subagent_type → ref = general-purpose', () => {
    const { events } = extractEventsFromLines([assistantLine('Agent', {})]);
    expect(events[0].ref).toBe('general-purpose');
  });

  it('non-tracked tool (Bash) → not extracted, counted as skipped', () => {
    const { events, skippedToolUseCount } = extractEventsFromLines([
      assistantLine('Bash', { command: 'ls' }),
    ]);
    expect(events).toHaveLength(0);
    expect(skippedToolUseCount).toBe(1);
  });

  it('missing timestamp → event dropped', () => {
    const line = fakeLineFromRaw({
      type: 'assistant',
      sessionId: 'sess-001',
      cwd: '/home/user/project',
      // no timestamp
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'foo' } }],
      },
    });
    const { events } = extractEventsFromLines([line]);
    expect(events).toHaveLength(0);
  });

  it('missing sessionId → event dropped', () => {
    const line = fakeLineFromRaw({
      type: 'assistant',
      timestamp: '2026-06-01T10:00:00.000Z',
      cwd: '/home/user/project',
      // no sessionId
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'foo' } }],
      },
    });
    const { events } = extractEventsFromLines([line]);
    expect(events).toHaveLength(0);
  });

  it('missing cwd → event dropped', () => {
    const line = fakeLineFromRaw({
      type: 'assistant',
      timestamp: '2026-06-01T10:00:00.000Z',
      sessionId: 'sess-001',
      // no cwd
      message: {
        content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'foo' } }],
      },
    });
    const { events } = extractEventsFromLines([line]);
    expect(events).toHaveLength(0);
  });

  it('user type → ignored (not assistant)', () => {
    const line = fakeLineFromRaw({
      type: 'user',
      timestamp: '2026-06-01T10:00:00.000Z',
      sessionId: 'sess-001',
      cwd: '/home/user/project',
      message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'foo' } }] },
    });
    const { events } = extractEventsFromLines([line]);
    expect(events).toHaveLength(0);
  });
});

// ── transcript.ts: broken lines don't crash ───────────────────────────────────

describe('parseTranscript — broken lines', () => {
  it('parses valid lines and skips broken JSON without throwing', async () => {
    const result = await parseTranscript(join(TRANSCRIPTS, 'broken.jsonl'));
    expect(result.skippedCount).toBeGreaterThan(0);
    expect(result.lines.length).toBeGreaterThan(0);
    // Should have parsed at least some valid lines
  });

  it('basic.jsonl parses all 9 lines (one blank is skipped, no broken)', async () => {
    const result = await parseTranscript(join(TRANSCRIPTS, 'basic.jsonl'));
    expect(result.skippedCount).toBe(0);
    expect(result.lines.length).toBe(9);
  });

  it('startLine parameter skips early lines', async () => {
    const full = await parseTranscript(join(TRANSCRIPTS, 'basic.jsonl'));
    const partial = await parseTranscript(join(TRANSCRIPTS, 'basic.jsonl'), 5);
    expect(partial.lines.length).toBeLessThan(full.lines.length);
  });
});

// ── extract from fixture file: valid after broken ────────────────────────────

describe('extractEventsFromLines from broken.jsonl', () => {
  it('extracts valid events and ignores broken/missing-field lines, no crash', async () => {
    const result = await parseTranscript(join(TRANSCRIPTS, 'broken.jsonl'));
    const { events } = extractEventsFromLines(result.lines);
    // Should get events from the valid lines:
    //   line 1: deep-research (valid)
    //   line 3: mcp__playwright__speak (valid)
    //   lines 5,6,7: missing ts/cwd/sessionId → dropped
    //   line 8: Bash → skipped (non-tracked)
    //   line 9: system type → ignored
    //   line 10: valid-after-broken (valid)
    expect(events.length).toBeGreaterThanOrEqual(3);
    const skills = events.filter(e => e.kind === 'skill');
    expect(skills.some(s => s.ref === 'deep-research')).toBe(true);
    expect(skills.some(s => s.ref === 'valid-after-broken')).toBe(true);
  });
});

// ── ledger.ts: incremental processing ────────────────────────────────────────

describe('updateLedger — incremental processing', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Pattern 1 (新規): first scan extracts events and creates state', async () => {
    const transcriptFile = join(TRANSCRIPTS, 'basic.jsonl');
    const result = await updateLedger(paths, [transcriptFile]);
    expect(result.scannedFiles).toBe(1);
    expect(result.skippedFiles).toBe(0);
    expect(result.newEvents).toBeGreaterThan(0);

    // State should be persisted
    const stateFile = join(paths.curatorHome, 'state.json');
    expect(existsSync(stateFile)).toBe(true);

    // Ledger should have events
    const ledgerFile = join(paths.curatorHome, 'ledger.jsonl');
    expect(existsSync(ledgerFile)).toBe(true);
  });

  it('Pattern 2 (不変): second scan with same file skips it', async () => {
    const transcriptFile = join(TRANSCRIPTS, 'basic.jsonl');

    const r1 = await updateLedger(paths, [transcriptFile]);
    expect(r1.scannedFiles).toBe(1);

    // Second run: same file, same mtime/size → skip
    const r2 = await updateLedger(paths, [transcriptFile]);
    expect(r2.skippedFiles).toBe(1);
    expect(r2.scannedFiles).toBe(0);
    expect(r2.newEvents).toBe(0);
  });

  it('Pattern 3 (縮小): file shrunk → full re-read', async () => {
    // Create a temp transcript with 2 events
    const tempFile = join(tmpDir, 'shrink-test.jsonl');
    const line1 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-01T10:00:00.000Z',
      sessionId: 'sess-s1',
      cwd: '/project',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'skill-a' } }] },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-06-01T10:01:00.000Z',
      sessionId: 'sess-s1',
      cwd: '/project',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Skill', input: { skill: 'skill-b' } }] },
    });

    await writeFile(tempFile, line1 + '\n' + line2 + '\n');

    const r1 = await updateLedger(paths, [tempFile]);
    expect(r1.newEvents).toBe(2);

    // Shrink: replace with only line1 (smaller file)
    // Use a slightly newer mtime by writing again
    await new Promise(r => setTimeout(r, 10)); // ensure different mtime
    await writeFile(tempFile, line1 + '\n');

    const r2 = await updateLedger(paths, [tempFile]);
    expect(r2.scannedFiles).toBe(1);
    // Full re-read: 1 event from line1
    expect(r2.newEvents).toBe(1);
  });

  it('Pattern: append → only new lines processed', async () => {
    const tempFile = join(tmpDir, 'append-test.jsonl');
    const makeLine = (skill: string, ts: string) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: ts,
        sessionId: 'sess-a1',
        cwd: '/project',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill } }],
        },
      });

    // Write initial 2 lines
    await writeFile(tempFile, makeLine('skill-x', '2026-06-01T10:00:00.000Z') + '\n' + makeLine('skill-y', '2026-06-01T10:01:00.000Z') + '\n');

    const r1 = await updateLedger(paths, [tempFile]);
    expect(r1.newEvents).toBe(2);

    // Append 1 more line (file grows)
    await new Promise(r => setTimeout(r, 10));
    const { appendFile: appendFileFs } = await import('node:fs/promises');
    await appendFileFs(tempFile, makeLine('skill-z', '2026-06-01T10:02:00.000Z') + '\n');

    const r2 = await updateLedger(paths, [tempFile]);
    expect(r2.scannedFiles).toBe(1);
    // Only 1 new event (the appended line)
    expect(r2.newEvents).toBe(1);
  });
});

// ── ledger.ts: UsageStats aggregation ────────────────────────────────────────

describe('loadUsageStats', () => {
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
    const stats = await loadUsageStats(paths);
    expect(stats).toEqual([]);
  });

  it('aggregates count, lastUsed, and projects correctly', async () => {
    await updateLedger(paths, [join(TRANSCRIPTS, 'multi-project.jsonl')]);
    const stats = await loadUsageStats(paths);

    // article-workflow appears in 3 different cwds
    const aw = stats.find(s => s.ref === 'article-workflow' && s.kind === 'skill');
    expect(aw).toBeDefined();
    expect(aw!.count).toBe(3);
    expect(aw!.projects).toHaveLength(3);
    expect(aw!.lastUsed).toBeTruthy();

    // mcp playwright: 2 calls from same project
    const playwright = stats.find(s => s.ref === 'playwright' && s.kind === 'mcp-tool');
    expect(playwright).toBeDefined();
    expect(playwright!.count).toBe(2);
    expect(playwright!.projects).toHaveLength(1); // same cwd

    // agent researcher: 1 call
    const researcher = stats.find(s => s.ref === 'researcher' && s.kind === 'agent');
    expect(researcher).toBeDefined();
    expect(researcher!.count).toBe(1);
  });

  it('days filter excludes old events', async () => {
    // Write a ledger with an old event (100 days ago) and a recent event
    await mkdir(paths.curatorHome, { recursive: true });
    const oldTs = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recentTs = new Date().toISOString();
    const events = [
      JSON.stringify({ ts: oldTs, kind: 'skill', ref: 'old-skill', sessionId: 's1', cwd: '/p' }),
      JSON.stringify({ ts: recentTs, kind: 'skill', ref: 'new-skill', sessionId: 's2', cwd: '/p' }),
    ].join('\n') + '\n';
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(paths.curatorHome, 'ledger.jsonl'), events);

    const all = await loadUsageStats(paths);
    expect(all.some(s => s.ref === 'old-skill')).toBe(true);
    expect(all.some(s => s.ref === 'new-skill')).toBe(true);

    const recent = await loadUsageStats(paths, { days: 30 });
    expect(recent.some(s => s.ref === 'old-skill')).toBe(false);
    expect(recent.some(s => s.ref === 'new-skill')).toBe(true);
  });

  it('broken ledger lines are skipped without crash', async () => {
    await mkdir(paths.curatorHome, { recursive: true });
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(
      join(paths.curatorHome, 'ledger.jsonl'),
      'not valid json\n' +
        JSON.stringify({ ts: '2026-06-01T00:00:00.000Z', kind: 'skill', ref: 'good-skill', sessionId: 's1', cwd: '/p' }) +
        '\n' +
        '{broken\n',
    );
    let stats: Awaited<ReturnType<typeof loadUsageStats>>;
    expect(() => {
      loadUsageStats(paths).then(s => (stats = s));
    }).not.toThrow();
    const result = await loadUsageStats(paths);
    expect(result.some(s => s.ref === 'good-skill')).toBe(true);
  });
});

// ── clearLedger ───────────────────────────────────────────────────────────────

describe('clearLedger', () => {
  let paths: ResolvedPaths;

  beforeEach(async () => {
    paths = await makeTempPaths();
  });

  afterEach(async () => {
    if (tmpDir && existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('clears ledger and state so next scan re-processes everything', async () => {
    const transcriptFile = join(TRANSCRIPTS, 'basic.jsonl');
    const r1 = await updateLedger(paths, [transcriptFile]);
    expect(r1.newEvents).toBeGreaterThan(0);

    // Clear
    await clearLedger(paths);
    const stats = await loadUsageStats(paths);
    expect(stats).toHaveLength(0);

    // Re-scan: should pick up all events again
    const r2 = await updateLedger(paths, [transcriptFile]);
    expect(r2.scannedFiles).toBe(1);
    expect(r2.newEvents).toBe(r1.newEvents);
  });
});
