// claudemd.ts — CLAUDE.md and rules scanner (DESIGN.md §4.1)
// Sources: ~/.claude/CLAUDE.md (user)
//          ~/.claude/rules/*.md (user)
//          <project>/CLAUDE.md (project)
// footprint = full (always loaded)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Asset } from '../../types.js';
import type { ResolvedPaths } from '../../paths.js';
import { estimateTokens } from '../../tokens.js';

function readMdFile(
  filePath: string,
  scope: 'user' | 'project',
  warnings: string[],
  existingIds: Set<string>,
): Asset | null {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    warnings.push(`claudemd: cannot read ${filePath}: ${e}`);
    return null;
  }

  const name = basename(filePath);
  const base = `claude-md:${name}`;
  let id = base;
  if (existingIds.has(id)) {
    id = `${base}:${scope}`;
  }
  existingIds.add(id);

  const tokens = estimateTokens(content);
  return {
    id,
    kind: 'claude-md',
    name,
    path: filePath,
    scope,
    sizeBytes: stat.size,
    footprintTokens: tokens, // footprint = full (always loaded)
    fullTokens: tokens,
    modifiedAt: stat.mtime.toISOString(),
  };
}

export async function scanClaudeMd(paths: ResolvedPaths, warnings: string[]): Promise<Asset[]> {
  const existingIds = new Set<string>();
  const assets: Asset[] = [];

  // 1. ~/.claude/CLAUDE.md
  const userClaudeMd = join(paths.claudeDir, 'CLAUDE.md');
  const userAsset = readMdFile(userClaudeMd, 'user', warnings, existingIds);
  if (userAsset) assets.push(userAsset);

  // 2. ~/.claude/rules/*.md
  const rulesDir = join(paths.claudeDir, 'rules');
  let ruleEntries: string[] = [];
  try {
    ruleEntries = readdirSync(rulesDir).filter((f) => f.endsWith('.md'));
  } catch {
    // no rules dir
  }
  for (const entry of ruleEntries) {
    const rulePath = join(rulesDir, entry);
    const asset = readMdFile(rulePath, 'user', warnings, existingIds);
    if (asset) assets.push(asset);
  }

  // 3. <project>/CLAUDE.md
  const projectClaudeMd = join(paths.projectDir, 'CLAUDE.md');
  const projectAsset = readMdFile(projectClaudeMd, 'project', warnings, existingIds);
  if (projectAsset) assets.push(projectAsset);

  return assets;
}
