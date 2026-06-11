// agents.ts — agent scanner (DESIGN.md §4.1)
// Sources: ~/.claude/agents/*.md (user)
//          <project>/.claude/agents/*.md (project)
// Note: directory may not exist on all installations → must skip silently
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Asset } from '../../types.js';
import type { ResolvedPaths } from '../../paths.js';
import { estimateTokens } from '../../tokens.js';

function scanAgentDir(
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
    // directory doesn't exist — silently skip (confirmed in DESIGN.md §4.1)
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
      warnings.push(`agents: cannot read ${filePath}: ${e}`);
      continue;
    }

    const name = basename(entry, '.md');
    const base = `agent:${name}`;
    let id = base;
    if (existingIds.has(id)) {
      id = `${base}:${scope}`;
    }
    existingIds.add(id);

    const tokens = estimateTokens(content);
    assets.push({
      id,
      kind: 'agent',
      name,
      path: filePath,
      scope,
      sizeBytes: stat.size,
      footprintTokens: 0, // agents loaded on invocation
      fullTokens: tokens,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return assets;
}

export async function scanAgents(paths: ResolvedPaths, warnings: string[]): Promise<Asset[]> {
  const existingIds = new Set<string>();
  const assets: Asset[] = [];

  // 1. ~/.claude/agents/*.md
  assets.push(...scanAgentDir(join(paths.claudeDir, 'agents'), 'user', warnings, existingIds));

  // 2. <project>/.claude/agents/*.md
  assets.push(
    ...scanAgentDir(
      join(paths.projectDir, '.claude', 'agents'),
      'project',
      warnings,
      existingIds,
    ),
  );

  return assets;
}
