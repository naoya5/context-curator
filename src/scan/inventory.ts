// inventory.ts — aggregate all scanners into an Inventory (DESIGN.md §4.1)
import { statSync } from 'node:fs';
import type { Asset, Inventory } from '../types.js';
import type { ResolvedPaths } from '../paths.js';
import { scanSkills } from './assets/skills.js';
import { scanMcp } from './assets/mcp.js';
import { scanClaudeMd } from './assets/claudemd.js';
import { scanMemory } from './assets/memory.js';
import { scanCommands } from './assets/commands.js';
import { scanAgents } from './assets/agents.js';

export interface BuildInventoryOptions {
  /**
   * When true, also scan each directory in projectDirs as a project-scoped
   * scan and merge resulting assets into the inventory.
   * Requires projectDirs to be provided (injected by CLI to avoid scan→usage dep).
   */
  allProjects?: boolean;
  /**
   * List of cwd paths to scan as project directories when allProjects is true.
   * Each path is used as paths.projectDir for project-scoped scanners.
   * Ignored when allProjects is false/omitted.
   */
  projectDirs?: string[];
}

export async function buildInventory(
  paths: ResolvedPaths,
  opts?: BuildInventoryOptions,
): Promise<Inventory> {
  const warnings: string[] = [];

  const [skills, mcp, claudemd, memory, commands, agents] = await Promise.all([
    scanSkills(paths, warnings),
    scanMcp(paths, warnings),
    scanClaudeMd(paths, warnings),
    scanMemory(paths, warnings),
    scanCommands(paths, warnings),
    scanAgents(paths, warnings),
  ]);

  const assets: Asset[] = [...skills, ...mcp, ...claudemd, ...memory, ...commands, ...agents];

  // ── allProjects: scan each known project dir for project-scoped assets ────
  if (opts?.allProjects && opts.projectDirs && opts.projectDirs.length > 0) {
    // Track existing ids to deduplicate (same convention as individual scanners)
    const existingIds = new Set(assets.map((a) => a.id));

    for (const projectDir of opts.projectDirs) {
      // Build a temporary paths object with this projectDir
      const projectPaths: ResolvedPaths = { ...paths, projectDir };

      // Only run project-scoped scanners (mcp covers .mcp.json and .claude/settings.json)
      // Other scanners (skills, claudemd, memory, commands, agents) scan claudeDir-level only
      // For project scope we run all scanners but only keep scope='project' results
      const projectWarnings: string[] = [];
      const [pMcp, pClaudemd, pSkills, pMemory, pCommands, pAgents] = await Promise.all([
        scanMcp(projectPaths, projectWarnings),
        scanClaudeMd(projectPaths, projectWarnings),
        scanSkills(projectPaths, projectWarnings),
        scanMemory(projectPaths, projectWarnings),
        scanCommands(projectPaths, projectWarnings),
        scanAgents(projectPaths, projectWarnings),
      ]);

      const projectAssets = [
        ...pMcp,
        ...pClaudemd,
        ...pSkills,
        ...pMemory,
        ...pCommands,
        ...pAgents,
      ].filter((a) => a.scope === 'project');

      for (const asset of projectAssets) {
        if (existingIds.has(asset.id)) {
          // Deduplicate: append path suffix to id (same convention as scanner dedup)
          asset.id = `${asset.id}:${projectDir}`;
        }
        if (!existingIds.has(asset.id)) {
          existingIds.add(asset.id);
          assets.push(asset);
        }
      }

      warnings.push(...projectWarnings);
    }
  }

  // 作成日(createdAt)を一括付与（スキャナ横断で 1 箇所に集約）。
  // birthtime が無効な FS では mtime にフォールバックし、stat 失敗時も落とさない。
  for (const a of assets) {
    a.createdAt = resolveCreatedAt(a);
  }

  return {
    assets,
    scannedAt: new Date().toISOString(),
    warnings,
  };
}

/** asset.path の作成日を返す。birthtime 優先・mtime フォールバック・例外時は modifiedAt。 */
function resolveCreatedAt(asset: Asset): string {
  try {
    const s = statSync(asset.path);
    const bt = s.birthtimeMs;
    if (bt && bt > 0 && bt <= s.mtimeMs) return s.birthtime.toISOString();
    return s.mtime.toISOString();
  } catch {
    return asset.modifiedAt;
  }
}
