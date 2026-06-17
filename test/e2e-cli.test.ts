// e2e-cli.test.ts — 実 CLI バイナリ越しの安全クリティカル経路の回帰テスト
//
// なぜ必要か:
//   archive / restore のモジュール単体は apply.test.ts でカバー済みだが、
//   「CLI のコマンド配線（引数解析 + 各 action の結線）まで含めて実際に動くか」は
//   v0.4 時点まで一度も自動検証されていなかった（手動 dry-run のみ）。
//   このツールの核心価値は「安全で可逆なアーカイブ」なので、その経路を
//   実 CLI 越しに固定する。spawn は tsx 経由でビルド不要。
//
// すべての I/O は os.tmpdir() のサンドボックスに限定し、実 ~/.claude には触れない。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSX_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'cli.ts');

let sandbox: string;
let claudeDir: string;
let curatorHome: string;
let skillDir: string;

const SKILL_BODY = `---
name: lonely-skill
description: A skill nobody has used in a long time, for round-trip testing.
---
# lonely-skill
This is the body. It should survive an archive/restore round-trip byte-for-byte.
`;
const REF_BODY = 'reference file that must not be orphaned when the skill dir is archived.\n';

/** 実 CLI を tsx 越しに起動し、サンドボックスへ env で向ける */
function runCli(args: string[]) {
  const res = spawnSync(TSX_BIN, [CLI_ENTRY, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      CURATOR_CLAUDE_DIR: claudeDir,
      CURATOR_HOME: curatorHome,
      CURATOR_CLAUDE_JSON: join(sandbox, 'claude.json'),
    },
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'curator-e2e-'));
  claudeDir = join(sandbox, 'claude');
  curatorHome = join(sandbox, 'curator');
  skillDir = join(claudeDir, 'skills', 'lonely-skill');
  await mkdir(join(skillDir, 'references'), { recursive: true });
  await mkdir(join(claudeDir, 'projects'), { recursive: true });
  await mkdir(curatorHome, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), SKILL_BODY, 'utf8');
  await writeFile(join(skillDir, 'references', 'notes.md'), REF_BODY, 'utf8');
  // unused 判定のため、猶予期間(14日)より十分古い mtime にする
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
  for (const p of [
    join(skillDir, 'SKILL.md'),
    join(skillDir, 'references', 'notes.md'),
    skillDir,
  ]) {
    await utimes(p, old, old);
  }
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe('CLI e2e: archive → restore round-trip (safety-critical)', () => {
  it('apply --yes archives the whole skill dir; restore brings it back byte-for-byte; double restore is refused', async () => {
    const before = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    const beforeRef = await readFile(join(skillDir, 'references', 'notes.md'), 'utf8');

    // 1. apply: unused スキルをアーカイブ
    const apply = runCli(['apply', '--yes', '--filter', 'unused']);
    expect(apply.status).toBe(0);
    // 元の場所からスキルディレクトリごと消えている（SKILL.md 単体ではない）
    expect(existsSync(skillDir)).toBe(false);

    // payload に付随ファイルごと退避されている
    const archiveRoot = join(curatorHome, 'archive');
    const archiveIds = await readdir(archiveRoot);
    expect(archiveIds).toHaveLength(1);
    const archiveId = archiveIds[0]!;
    const payloadSkill = join(archiveRoot, archiveId, 'payload', 'lonely-skill');
    expect(existsSync(join(payloadSkill, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(payloadSkill, 'references', 'notes.md'))).toBe(true);

    // journal に archive が記録されている
    const journal1 = await readFile(join(curatorHome, 'journal.jsonl'), 'utf8');
    expect(journal1).toContain('"op":"archive"');

    // 2. restore: 原状復帰
    const restore = runCli(['restore', archiveId]);
    expect(restore.status).toBe(0);
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillDir, 'references', 'notes.md'))).toBe(true);

    // バイト単位で一致
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toBe(before);
    expect(await readFile(join(skillDir, 'references', 'notes.md'), 'utf8')).toBe(beforeRef);

    // journal に restore も記録されている
    const journal2 = await readFile(join(curatorHome, 'journal.jsonl'), 'utf8');
    expect(journal2).toContain('"op":"restore"');

    // 3. 二重 restore: 復元先に既存があるので拒否し、生存ファイルは無傷
    const second = runCli(['restore', archiveId]);
    expect(second.status).not.toBe(0);
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toBe(before);
  }, 60_000);

  it('apply --dry-run writes nothing and proposes the whole skill dir', async () => {
    const dry = runCli(['apply', '--dry-run']);
    expect(dry.status).toBe(0);
    // dry-run はスキルディレクトリ（SKILL.md の親）を対象に出す
    expect(dry.stdout).toContain('skills/lonely-skill');
    expect(dry.stdout).not.toContain('skills/lonely-skill/SKILL.md');
    // 何も移動していない
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(curatorHome, 'archive'))).toBe(false);
  }, 60_000);
});
