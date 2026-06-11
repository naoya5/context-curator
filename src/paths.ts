// paths.ts — path resolution with env var overrides (DESIGN.md §4)
// CURATOR_CLAUDE_DIR overrides ~/.claude
// CURATOR_HOME overrides ~/.curator
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ResolvedPaths {
  /** ~/.claude (or override) */
  claudeDir: string;
  /** ~/.curator (or override) */
  curatorHome: string;
  /** ~/.claude.json */
  claudeJson: string;
  /** cwd of the invoking process (for project-scoped assets) */
  projectDir: string;
}

export function resolvePaths(cwd: string = process.cwd()): ResolvedPaths {
  const home = homedir();

  const claudeDir = process.env['CURATOR_CLAUDE_DIR']
    ? resolve(process.env['CURATOR_CLAUDE_DIR'])
    : join(home, '.claude');

  const curatorHome = process.env['CURATOR_HOME']
    ? resolve(process.env['CURATOR_HOME'])
    : join(home, '.curator');

  // ~/.claude.json lives one level above ~/.claude
  const claudeJson = process.env['CURATOR_CLAUDE_JSON']
    ? resolve(process.env['CURATOR_CLAUDE_JSON'])
    : join(home, '.claude.json');

  return {
    claudeDir,
    curatorHome,
    claudeJson,
    projectDir: resolve(cwd),
  };
}
