// skills.ts — skill scanner (DESIGN.md §4.1)
// Scans: ~/.claude/skills/*/SKILL.md (user)
//        <project>/.claude/skills/*/SKILL.md (project)
//        ~/.claude/plugins/*/skills/*/SKILL.md (plugin)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Asset, AssetScope } from '../../types.js';
import type { ResolvedPaths } from '../../paths.js';
import { estimateTokens } from '../../tokens.js';

interface SkillFrontmatter {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/** Parse `---\n...\n---\n...` frontmatter. Returns {fm, body} or null on failure. */
function parseFrontmatter(content: string): { fm: string; body: string } | null {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = content.slice(3, end).trim();
  const body = content.slice(end + 4);
  return { fm, body };
}

function makeId(kind: 'skill', name: string, existing: Set<string>, path: string): string {
  const base = `${kind}:${name}`;
  if (!existing.has(base)) return base;
  // Disambiguate with path suffix
  return `${base}:${basename(path)}`;
}

function scanSkillDir(
  dir: string,
  scope: AssetScope,
  namePrefix: string,
  warnings: string[],
  existingIds: Set<string>,
): Asset[] {
  const assets: Asset[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return assets;
  }

  for (const entry of entries) {
    const skillDir = join(dir, entry);
    const skillMd = join(skillDir, 'SKILL.md');
    let stat;
    try {
      stat = statSync(skillMd);
    } catch {
      continue; // no SKILL.md
    }
    let content: string;
    try {
      content = readFileSync(skillMd, 'utf-8');
    } catch (e) {
      warnings.push(`skills: cannot read ${skillMd}: ${e}`);
      continue;
    }

    let name = namePrefix ? `${namePrefix}:${entry}` : entry;
    let description: string | undefined;
    let footprintTokens = 0;

    const parsed = parseFrontmatter(content);
    if (parsed) {
      try {
        const fm = parseYaml(parsed.fm) as SkillFrontmatter | null;
        if (fm && typeof fm === 'object') {
          if (typeof fm['name'] === 'string') {
            name = namePrefix ? `${namePrefix}:${fm['name']}` : fm['name'];
          }
          if (typeof fm['description'] === 'string') {
            description = fm['description'];
          }
        }
        // footprint = frontmatter block only (the `---\n...\n---` delimiters + content)
        const fmBlock = `---\n${parsed.fm}\n---`;
        footprintTokens = estimateTokens(fmBlock);
      } catch (e) {
        warnings.push(`skills: broken frontmatter in ${skillMd}: ${e}`);
        // Still use file, just skip frontmatter extraction
      }
    } else {
      warnings.push(`skills: no valid frontmatter in ${skillMd}, using filename as name`);
    }

    const fullTokens = estimateTokens(content);
    const id = makeId('skill', name, existingIds, skillMd);
    existingIds.add(id);

    assets.push({
      id,
      kind: 'skill',
      name,
      path: skillMd,
      scope,
      sizeBytes: stat.size,
      footprintTokens,
      fullTokens,
      modifiedAt: stat.mtime.toISOString(),
      meta: description !== undefined ? { description } : undefined,
    });
  }
  return assets;
}

export async function scanSkills(paths: ResolvedPaths, warnings: string[]): Promise<Asset[]> {
  const existingIds = new Set<string>();
  const assets: Asset[] = [];

  // 1. User skills: ~/.claude/skills/*/SKILL.md
  assets.push(...scanSkillDir(join(paths.claudeDir, 'skills'), 'user', '', warnings, existingIds));

  // 2. Project skills: <project>/.claude/skills/*/SKILL.md
  assets.push(
    ...scanSkillDir(
      join(paths.projectDir, '.claude', 'skills'),
      'project',
      '',
      warnings,
      existingIds,
    ),
  );

  // 3. Plugin skills: ~/.claude/plugins/*/skills/*/SKILL.md
  const pluginsDir = join(paths.claudeDir, 'plugins');
  let pluginEntries: string[];
  try {
    pluginEntries = readdirSync(pluginsDir);
  } catch {
    pluginEntries = [];
  }

  for (const plugin of pluginEntries) {
    const pluginSkillsDir = join(pluginsDir, plugin, 'skills');
    assets.push(
      ...scanSkillDir(pluginSkillsDir, 'plugin', plugin, warnings, existingIds),
    );
  }

  return assets;
}
