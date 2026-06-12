// audit-regressions.test.ts — メインセッション監査で発見された問題の再発防止テスト
// (1) skill のアーカイブは SKILL.md 単体ではなくディレクトリ丸ごと（references/ を孤児にしない）
// (2) plugin scope の資産は archive 提案に含めない（プラグインを壊さない）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveAsset } from '../src/apply/archive.js';
import { restoreArchive } from '../src/apply/restore.js';
import { buildProposals, archiveSourcePath } from '../src/apply/proposals.js';
import type { ResolvedPaths } from '../src/paths.js';
import type { Asset, Finding, Proposal } from '../src/types.js';

let root: string;
let paths: ResolvedPaths;

function makeSkillAsset(skillDir: string, name: string): Asset {
  return {
    id: `skill:${name}`,
    kind: 'skill',
    name,
    path: join(skillDir, 'SKILL.md'),
    scope: 'user',
    sizeBytes: 100,
    footprintTokens: 30,
    fullTokens: 100,
    modifiedAt: '2026-01-01T00:00:00Z',
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'curator-audit-'));
  paths = {
    claudeDir: join(root, 'claude'),
    curatorHome: join(root, 'curator'),
    claudeJson: join(root, 'claude.json'),
    projectDir: join(root, 'project'),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skill archive moves the whole directory (audit finding #1)', () => {
  it('archives references/ alongside SKILL.md and restores them completely', async () => {
    const skillDir = join(paths.claudeDir, 'skills', 'big-skill');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: big-skill\n---\nbody', 'utf8');
    await writeFile(join(skillDir, 'references', 'ref.md'), 'reference content', 'utf8');

    const asset = makeSkillAsset(skillDir, 'big-skill');
    const proposal: Proposal = {
      assetId: asset.id, asset, action: 'archive',
      findingType: 'unused', reason: 'test',
    };

    const manifest = await archiveAsset(paths, proposal);

    // 元の場所から SKILL.md も references/ も消えている（孤児なし）
    expect(existsSync(skillDir)).toBe(false);
    // payload にディレクトリ丸ごと入っている
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.originalPath).toBe(skillDir);
    const archivedRef = join(manifest.entries[0]!.archivedPath, 'references', 'ref.md');
    expect(existsSync(archivedRef)).toBe(true);

    // restore で完全復帰
    await restoreArchive(paths, manifest.archiveId);
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toContain('big-skill');
    expect(await readFile(join(skillDir, 'references', 'ref.md'), 'utf8'))
      .toBe('reference content');
  });

  it('archiveSourcePath resolves skill SKILL.md to its directory', () => {
    const asset = makeSkillAsset('/x/skills/foo', 'foo');
    expect(archiveSourcePath(asset)).toBe('/x/skills/foo');
    const cmd: Asset = { ...asset, kind: 'command', path: '/x/commands/foo.md', id: 'command:foo' };
    expect(archiveSourcePath(cmd)).toBe('/x/commands/foo.md');
  });
});

describe('plugin-scoped assets are never proposed (audit finding #2)', () => {
  it('excludes plugin scope from proposals', () => {
    const pluginAsset: Asset = {
      ...makeSkillAsset('/x/plugins/p/skills/s', 's'),
      id: 'skill:p:s',
      scope: 'plugin',
    };
    const userAsset = makeSkillAsset('/x/skills/u', 'u');
    const findings: Finding[] = [
      { asset: pluginAsset, type: 'unused', reason: 'r', severity: 'warn', suggestion: 's' },
      { asset: userAsset, type: 'unused', reason: 'r', severity: 'warn', suggestion: 's' },
    ];
    const proposals = buildProposals(findings);
    expect(proposals.map((p) => p.assetId)).toEqual(['skill:u']);
  });
});
