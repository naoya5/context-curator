// claudejson.ts — safe atomic JSON editing for mcp-server archive/restore (DESIGN.md §8.2)
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Remove a named mcp server entry from the JSON config file.
 * Steps (DESIGN.md §8.2 mcp-server 編集手順):
 *   1. Read + parse JSON — abort on parse failure
 *   2. Write full backup to backupDir/<basename>.<ISO-ts>.json
 *   3. Delete mcpServers[serverName] in memory
 *   4. Atomic write via tmp + rename
 */
export async function removeMcpServer(
  configPath: string,
  serverName: string,
  backupDir: string,
): Promise<unknown> {
  // 1. Read and parse — abort on failure
  const raw = await readFile(configPath, 'utf8');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `JSON parse failed for ${configPath}: ${(err as Error).message}. Aborting to avoid corrupting config.`,
    );
  }

  const mcpServers = obj['mcpServers'] as Record<string, unknown> | undefined;
  if (!mcpServers || !(serverName in mcpServers)) {
    throw new Error(`mcpServers.${serverName} not found in ${configPath}`);
  }
  const removedConfig = mcpServers[serverName];

  // 2. Backup
  await mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${basename(configPath)}.${ts}.json`;
  await copyFile(configPath, join(backupDir, backupName));

  // 3. Mutate in memory
  delete mcpServers[serverName];

  // 4. Atomic write: tmp + rename
  await atomicWrite(configPath, JSON.stringify(obj, null, 2));

  return removedConfig;
}

/**
 * Insert a named mcp server entry into the JSON config file.
 * Used by restore. Errors if the server name already exists.
 * Same backup + atomic write procedure as removeMcpServer.
 */
export async function insertMcpServer(
  configPath: string,
  serverName: string,
  config: unknown,
  backupDir: string,
): Promise<void> {
  // 1. Read and parse — abort on failure
  const raw = await readFile(configPath, 'utf8');
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `JSON parse failed for ${configPath}: ${(err as Error).message}. Aborting to avoid corrupting config.`,
    );
  }

  // Ensure mcpServers key exists
  if (!obj['mcpServers']) {
    obj['mcpServers'] = {};
  }
  const mcpServers = obj['mcpServers'] as Record<string, unknown>;

  if (serverName in mcpServers) {
    throw new Error(
      `Conflict: mcpServers.${serverName} already exists in ${configPath}. Restore aborted.`,
    );
  }

  // 2. Backup
  await mkdir(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `${basename(configPath)}.${ts}.json`;
  await copyFile(configPath, join(backupDir, backupName));

  // 3. Mutate in memory
  mcpServers[serverName] = config;

  // 4. Atomic write: tmp + rename
  await atomicWrite(configPath, JSON.stringify(obj, null, 2));
}

/** Write content to a tmp file in the same directory, then rename atomically */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  // tmp must be on same filesystem as target for rename to be atomic
  const dir = dirname(targetPath);
  const tmpName = join(dir, `.curator-tmp-${randomBytes(6).toString('hex')}.json`);
  await writeFile(tmpName, content, 'utf8');
  // rename is atomic on POSIX; if it fails the tmp file is left behind (orphan)
  // but no user data is lost — the original config is untouched because writeFile
  // only wrote to the tmp path. tmp cleanup is intentionally omitted here to
  // avoid any unlink call outside the single EXDEV fallback in archive.ts.
  const { rename: fsRename } = await import('node:fs/promises');
  await fsRename(tmpName, targetPath);
}
