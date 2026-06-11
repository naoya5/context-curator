// memory.ts — memory file scanner (DESIGN.md §4.1)
// Source: ~/.claude/projects/*/memory/*.md
// MEMORY.md: footprint = full (always loaded)
// other *.md: footprint = 0 (recall-time only)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Asset } from '../../types.js';
import type { ResolvedPaths } from '../../paths.js';
import { estimateTokens } from '../../tokens.js';

export async function scanMemory(paths: ResolvedPaths, warnings: string[]): Promise<Asset[]> {
  const assets: Asset[] = [];
  const existingIds = new Set<string>();

  const projectsDir = join(paths.claudeDir, 'projects');
  let projectSlugs: string[];
  try {
    projectSlugs = readdirSync(projectsDir);
  } catch {
    return assets;
  }

  for (const slug of projectSlugs) {
    const memoryDir = join(projectsDir, slug, 'memory');
    let memFiles: string[];
    try {
      memFiles = readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }

    for (const file of memFiles) {
      const filePath = join(memoryDir, file);
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
        warnings.push(`memory: cannot read ${filePath}: ${e}`);
        continue;
      }

      const name = basename(file);
      const isMemoryMd = name === 'MEMORY.md';
      const fullTokens = estimateTokens(content);
      // MEMORY.md: footprint = full; individual memory files: footprint = 0
      const footprintTokens = isMemoryMd ? fullTokens : 0;

      const base = `memory:${slug}/${name}`;
      let id = base;
      if (existingIds.has(id)) {
        id = `${base}:${filePath}`;
      }
      existingIds.add(id);

      assets.push({
        id,
        kind: 'memory',
        name: `${slug}/${name}`,
        path: filePath,
        scope: 'user',
        sizeBytes: stat.size,
        footprintTokens,
        fullTokens,
        modifiedAt: stat.mtime.toISOString(),
        meta: { slug, isMemoryMd },
      });
    }
  }

  return assets;
}
