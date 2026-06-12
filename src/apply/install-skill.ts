// install-skill.ts — `curator install-skill [--force]` (DESIGN.md §9.1)
// Copies skill/SKILL.md → <claudeDir>/skills/curator/SKILL.md
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ResolvedPaths } from '../paths.js';
import { appendJournal } from './journal.js';

// ---------------------------------------------------------------------------
// Options / Result
// ---------------------------------------------------------------------------
export interface InstallSkillOptions {
  force?: boolean;
  /** Override skill source path (for testing only) */
  _skillSource?: string;
}

export interface InstallSkillResult {
  installedTo: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to skill/SKILL.md bundled with this package.
 *
 * Directory layout (both resolved from this file's location):
 *   src/apply/install-skill.ts  → ../../skill/SKILL.md  (dev/tsx)
 *   dist/apply/install-skill.js → ../../skill/SKILL.md  (compiled)
 *
 * We use import.meta.url so the path survives npm global install.
 */
export function resolveSkillSource(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const candidate = join(dirname(thisFile), '..', '..', 'skill', 'SKILL.md');
  return candidate;
}

// ---------------------------------------------------------------------------
// PATH check helper
// ---------------------------------------------------------------------------
function isCuratorInPath(): boolean {
  // Try `which` (POSIX) or `where` (Windows)
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, ['curator'], { encoding: 'utf8' });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function installSkill(
  paths: ResolvedPaths,
  opts: InstallSkillOptions = {},
): Promise<InstallSkillResult> {
  // 1. Resolve source
  const src = opts._skillSource ?? resolveSkillSource();
  if (!existsSync(src)) {
    throw new Error(
      `skill/SKILL.md が見つかりません: ${src}\n` +
        'パッケージが正しくインストールされているか確認してください。',
    );
  }

  // 2. Determine destination
  const destDir = join(paths.claudeDir, 'skills', 'curator');
  const dest = join(destDir, 'SKILL.md');

  // 3. Existing file check
  if (existsSync(dest) && !opts.force) {
    throw new Error(
      `既にインストール済みです: ${dest}\n` +
        '上書きするには --force オプションを指定してください。',
    );
  }

  // 4. Copy
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);

  // 5. Journal entry
  await appendJournal(paths.curatorHome, {
    ts: new Date().toISOString(),
    op: 'install-skill',
    archiveId: '',
    assetId: 'skill:curator',
    detail: `installed to ${dest}`,
  });

  // 6. PATH check — warn if curator not in PATH
  let warning: string | undefined;
  if (!isCuratorInPath()) {
    warning =
      '`curator` が PATH に見つかりません。\n' +
      'グローバルインストールしていない場合は以下を実行してください:\n' +
      '  npm install -g context-curator\n' +
      'または開発中は: npm link';
  }

  return { installedTo: dest, warning };
}
