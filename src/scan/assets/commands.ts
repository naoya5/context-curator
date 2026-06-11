// commands.ts — command scanner (DESIGN.md §4.1)
// Sources: ~/.claude/commands/*.md (user)
//          <project>/.claude/commands/*.md (project)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Asset } from '../../types.js';
import type { ResolvedPaths } from '../../paths.js';
import { estimateTokens } from '../../tokens.js';

function scanCommandDir(
  dir: string,
  scope: 'user' | 'project',
  warnings: string[],
  existingIds: Set<string>,
): Asset[] {
  const assets: Asset[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return assets;
  }

  for (const entry of entries) {
    const filePath = join(dir, entry);
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (e) {
      warnings.push(`commands: cannot read ${filePath}: ${e}`);
      continue;
    }

    const name = basename(entry, '.md');
    const base = `command:${name}`;
    let id = base;
    if (existingIds.has(id)) {
      id = `${base}:${scope}`;
    }
    existingIds.add(id);

    const tokens = estimateTokens(content);
    assets.push({
      id,
      kind: 'command',
      name,
      path: filePath,
      scope,
      sizeBytes: stat.size,
      footprintTokens: 0, // commands are loaded on invocation, not at startup
      fullTokens: tokens,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return assets;
}

export async function scanCommands(paths: ResolvedPaths, warnings: string[]): Promise<Asset[]> {
  const existingIds = new Set<string>();
  const assets: Asset[] = [];

  // 1. ~/.claude/commands/*.md
  assets.push(...scanCommandDir(join(paths.claudeDir, 'commands'), 'user', warnings, existingIds));

  // 2. <project>/.claude/commands/*.md
  assets.push(
    ...scanCommandDir(
      join(paths.projectDir, '.claude', 'commands'),
      'project',
      warnings,
      existingIds,
    ),
  );

  return assets;
}
