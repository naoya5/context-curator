// restore.ts — listArchives and restoreArchive (DESIGN.md §8.2)
import { readdir, readFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArchiveManifest } from '../types.js';
import type { ResolvedPaths } from '../paths.js';
import { appendJournal } from './journal.js';
import { insertMcpServer } from './claudejson.js';
import { moveAsset } from './archive-move.js';

// ─── listArchives ─────────────────────────────────────────────────────────────

export interface ListArchivesOptions {
  /** When true, include already-restored archives (default: false → only unrestore) */
  all?: boolean;
}

/**
 * Read all archive manifests from ~/.curator/archive/.
 * By default returns only archives that have NOT been restored.
 */
export async function listArchives(
  paths: ResolvedPaths,
  opts: ListArchivesOptions = {},
): Promise<ArchiveManifest[]> {
  const archiveDir = join(paths.curatorHome, 'archive');

  let entries: string[];
  try {
    entries = await readdir(archiveDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const manifests: ArchiveManifest[] = [];
  for (const entry of entries) {
    const manifestPath = join(archiveDir, entry, 'manifest.json');
    try {
      const raw = await readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw) as ArchiveManifest;
      if (opts.all || !manifest.restoredAt) {
        manifests.push(manifest);
      }
    } catch {
      // Skip directories without a valid manifest (orphaned payload/)
    }
  }

  // Sort by archivedAt ascending
  manifests.sort((a, b) => a.archivedAt.localeCompare(b.archivedAt));
  return manifests;
}

// ─── restoreArchive ───────────────────────────────────────────────────────────

/**
 * Restore an archived asset to its original location.
 * Rules (DESIGN.md §8.2 restore):
 * - If any restore destination already exists → error, nothing changed
 * - On success: write restoredAt to manifest, keep archive dir (history)
 * - mcp-server: insertMcpServer with same backup+atomic-write procedure
 */
export async function restoreArchive(paths: ResolvedPaths, archiveId: string): Promise<void> {
  const archiveDir = join(paths.curatorHome, 'archive');
  const backupDir = join(paths.curatorHome, 'backups');
  const archiveItemDir = join(archiveDir, archiveId);
  const manifestPath = join(archiveItemDir, 'manifest.json');

  // Load manifest
  let manifest: ArchiveManifest;
  try {
    const raw = await readFile(manifestPath, 'utf8');
    manifest = JSON.parse(raw) as ArchiveManifest;
  } catch (err) {
    throw new Error(`Cannot read manifest for archive "${archiveId}": ${(err as Error).message}`);
  }

  if (manifest.restoredAt) {
    throw new Error(`Archive "${archiveId}" has already been restored at ${manifest.restoredAt}`);
  }

  const now = new Date().toISOString();

  // ── mcp-server restore ──────────────────────────────────────────────────────
  if (manifest.kind === 'mcp-server') {
    if (!manifest.mcpRestore) {
      throw new Error(`Archive "${archiveId}" is mcp-server kind but has no mcpRestore metadata`);
    }
    const { configPath, serverName, serverConfig } = manifest.mcpRestore;
    // insertMcpServer errors if serverName already exists — satisfies collision check
    await insertMcpServer(configPath, serverName, serverConfig, backupDir);

    await updateManifestRestoredAt(manifestPath, manifest, now);
    await appendJournal(paths.curatorHome, {
      ts: now,
      op: 'restore',
      archiveId,
      assetId: manifest.assetId,
      detail: `mcp-server "${serverName}" re-inserted into ${configPath}`,
    });
    return;
  }

  // ── file/dir restore ────────────────────────────────────────────────────────
  // Pre-flight: check ALL destinations before touching anything
  for (const entry of manifest.entries) {
    try {
      await stat(entry.originalPath);
      // stat succeeded → path exists → collision
      throw new Error(
        `Restore conflict: "${entry.originalPath}" already exists. ` +
          `Archive "${archiveId}" was not restored.`,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Good — destination is free
        continue;
      }
      throw err; // Re-throw collision error or unexpected stat error
    }
  }

  // Ensure parent directories exist for all destinations
  for (const entry of manifest.entries) {
    const parentDir = entry.originalPath.replace(/\/[^/]+$/, '');
    await mkdir(parentDir, { recursive: true });
  }

  // Move each entry back
  for (const entry of manifest.entries) {
    await moveAsset(entry.archivedPath, entry.originalPath);
  }

  // Update manifest with restoredAt (archive dir stays)
  await updateManifestRestoredAt(manifestPath, manifest, now);

  await appendJournal(paths.curatorHome, {
    ts: now,
    op: 'restore',
    archiveId,
    assetId: manifest.assetId,
    detail: `${manifest.kind} "${manifest.name}" restored to original location`,
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────────

async function updateManifestRestoredAt(
  manifestPath: string,
  manifest: ArchiveManifest,
  restoredAt: string,
): Promise<void> {
  const updated: ArchiveManifest = { ...manifest, restoredAt };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(manifestPath, JSON.stringify(updated, null, 2), 'utf8');
}
