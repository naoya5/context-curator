// inventory.ts — aggregate all scanners into an Inventory (DESIGN.md §4.1)
import type { Inventory } from '../types.js';
import type { ResolvedPaths } from '../paths.js';
import { scanSkills } from './assets/skills.js';
import { scanMcp } from './assets/mcp.js';
import { scanClaudeMd } from './assets/claudemd.js';
import { scanMemory } from './assets/memory.js';
import { scanCommands } from './assets/commands.js';
import { scanAgents } from './assets/agents.js';

export async function buildInventory(paths: ResolvedPaths): Promise<Inventory> {
  const warnings: string[] = [];

  const [skills, mcp, claudemd, memory, commands, agents] = await Promise.all([
    scanSkills(paths, warnings),
    scanMcp(paths, warnings),
    scanClaudeMd(paths, warnings),
    scanMemory(paths, warnings),
    scanCommands(paths, warnings),
    scanAgents(paths, warnings),
  ]);

  const assets = [...skills, ...mcp, ...claudemd, ...memory, ...commands, ...agents];

  return {
    assets,
    scannedAt: new Date().toISOString(),
    warnings,
  };
}
