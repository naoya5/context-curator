// mcp.ts — MCP server scanner (DESIGN.md §4.1)
// Sources: ~/.claude.json mcpServers
//          <project>/.mcp.json
//          ~/.claude/settings.json mcpServers
//          <project>/.claude/settings.json mcpServers
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Asset } from '../../types.js';
import type { ResolvedPaths } from '../../paths.js';

interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface McpServersMap {
  mcpServers?: Record<string, McpServerDef>;
}

function readJsonSafe(filePath: string): McpServersMap | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as McpServersMap;
  } catch {
    return null;
  }
}

function fileMtime(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function extractServers(
  sourceFile: string,
  data: McpServersMap | null,
  existingIds: Set<string>,
  warnings: string[],
): Asset[] {
  if (!data || !data.mcpServers || typeof data.mcpServers !== 'object') {
    return [];
  }
  const assets: Asset[] = [];
  const mtime = fileMtime(sourceFile);

  for (const [serverName, def] of Object.entries(data.mcpServers)) {
    if (typeof serverName !== 'string' || !serverName) continue;

    const base = `mcp-server:${serverName}`;
    let id = base;
    if (existingIds.has(id)) {
      // Deduplicate: same server name from multiple sources → keep first (user-level wins)
      warnings.push(`mcp: duplicate server name "${serverName}" in ${sourceFile}, skipping`);
      continue;
    }
    existingIds.add(id);

    const meta: Record<string, unknown> = {
      tokenNote: 'unknown',
    };
    if (def && typeof def === 'object') {
      if (typeof def['command'] === 'string') meta['command'] = def['command'];
      if (Array.isArray(def['args'])) meta['args'] = def['args'];
    }

    assets.push({
      id,
      kind: 'mcp-server',
      name: serverName,
      path: sourceFile,
      scope: 'user', // overridden by caller for project scope
      sizeBytes: 0, // size not meaningful for an entry in a JSON file
      footprintTokens: 0, // unknown — see DESIGN.md §4.1
      fullTokens: 0,
      modifiedAt: mtime,
      meta,
    });
  }
  return assets;
}

export async function scanMcp(paths: ResolvedPaths, warnings: string[]): Promise<Asset[]> {
  const existingIds = new Set<string>();
  const assets: Asset[] = [];

  // 1. ~/.claude.json
  const claudeJsonData = readJsonSafe(paths.claudeJson);
  assets.push(...extractServers(paths.claudeJson, claudeJsonData, existingIds, warnings));

  // 2. ~/.claude/settings.json
  const userSettings = join(paths.claudeDir, 'settings.json');
  const userSettingsData = readJsonSafe(userSettings);
  assets.push(...extractServers(userSettings, userSettingsData, existingIds, warnings));

  // 3. <project>/.mcp.json
  const projectMcp = join(paths.projectDir, '.mcp.json');
  const projectMcpData = readJsonSafe(projectMcp);
  const projectMcpAssets = extractServers(projectMcp, projectMcpData, existingIds, warnings);
  // Override scope to 'project'
  projectMcpAssets.forEach((a) => (a.scope = 'project'));
  assets.push(...projectMcpAssets);

  // 4. <project>/.claude/settings.json
  const projectSettings = join(paths.projectDir, '.claude', 'settings.json');
  const projectSettingsData = readJsonSafe(projectSettings);
  const projectSettingsAssets = extractServers(
    projectSettings,
    projectSettingsData,
    existingIds,
    warnings,
  );
  projectSettingsAssets.forEach((a) => (a.scope = 'project'));
  assets.push(...projectSettingsAssets);

  return assets;
}
