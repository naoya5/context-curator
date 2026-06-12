// archive.ts — archiveAsset implementation (DESIGN.md §8.2)
// Safety-critical: never deletes user data — all moves delegated to archive-move.ts
// where the single EXDEV fallback rm lives.
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { Proposal, ArchiveManifest } from '../types.js';
import type { ResolvedPaths } from '../paths.js';
import { appendJournal } from './journal.js';
import { removeMcpServer } from './claudejson.js';
import { moveAsset } from './archive-move.js';
import { archiveSourcePath } from './proposals.js';

// ─── archiveId generation ────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9\-_]/g, '-');
}

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function resolveArchiveId(archiveDir: string, base: string): Promise<string> {
  // archiveDir may not exist yet — ignore ENOENT
  let existing: string[] = [];
  try {
    existing = await readdir(archiveDir);
  } catch {
    // directory doesn't exist yet — fine
  }
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

// ─── manifest I/O ─────────────────────────────────────────────────────────────

async function writeManifest(archiveItemDir: string, manifest: ArchiveManifest): Promise<void> {
  await mkdir(archiveItemDir, { recursive: true });
  await writeFile(
    join(archiveItemDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

// ─── archiveAsset ─────────────────────────────────────────────────────────────

/**
 * Archive a single asset as described in DESIGN.md §8.2.
 *
 * Ordering for file/dir assets: move payload FIRST, then write manifest.
 * A failed move leaves no manifest (no orphan manifest without payload).
 * A failed manifest write after a successful move leaves the asset in payload/
 * without a manifest — harmless (no journal entry, invisible to listArchives).
 *
 * For mcp-server: manifest written AFTER JSON edit succeeds.
 */
export async function archiveAsset(
  paths: ResolvedPaths,
  proposal: Proposal,
): Promise<ArchiveManifest> {
  const { asset } = proposal;

  if (asset.kind === 'claude-md') {
    throw new Error(
      `asset kind "claude-md" cannot be archived (DESIGN.md §8.2). ` +
        `Only bloated claude-md shows a text suggestion.`,
    );
  }

  const archiveDir = join(paths.curatorHome, 'archive');
  const backupDir = join(paths.curatorHome, 'backups');
  const now = new Date().toISOString();

  // Build archiveId
  const baseId = sanitize(`${nowStamp()}-${asset.kind}-${asset.name}`);
  const archiveId = await resolveArchiveId(archiveDir, baseId);
  const archiveItemDir = join(archiveDir, archiveId);
  const payloadDir = join(archiveItemDir, 'payload');

  // ── mcp-server: JSON edit path ──────────────────────────────────────────────
  if (asset.kind === 'mcp-server') {
    const configPath = asset.path; // path field = config JSON path for mcp-server
    const serverName = asset.name;

    // removeMcpServer handles: parse-fail abort, backup write, atomic JSON edit
    const removedConfig = await removeMcpServer(configPath, serverName, backupDir);

    const manifest: ArchiveManifest = {
      archiveId,
      archivedAt: now,
      assetId: asset.id,
      kind: asset.kind,
      name: asset.name,
      findingType: proposal.findingType,
      reason: proposal.reason,
      entries: [], // no file movement for mcp-server
      mcpRestore: {
        configPath,
        serverName,
        serverConfig: removedConfig,
      },
    };

    await writeManifest(archiveItemDir, manifest);
    await appendJournal(paths.curatorHome, {
      ts: now,
      op: 'archive',
      archiveId,
      assetId: asset.id,
      detail: `mcp-server "${serverName}" removed from ${configPath}`,
    });

    return manifest;
  }

  // ── file/dir movement path (skill / command / agent / memory) ──────────────
  const originalPath = archiveSourcePath(asset);
  const destName = basename(originalPath);
  const archivedPath = join(payloadDir, destName);

  await mkdir(payloadDir, { recursive: true });

  const manifest: ArchiveManifest = {
    archiveId,
    archivedAt: now,
    assetId: asset.id,
    kind: asset.kind,
    name: asset.name,
    findingType: proposal.findingType,
    reason: proposal.reason,
    entries: [{ originalPath, archivedPath }],
  };

  // Move first, then persist manifest (no orphan manifest on move failure)
  await moveAsset(originalPath, archivedPath);
  await writeManifest(archiveItemDir, manifest);

  await appendJournal(paths.curatorHome, {
    ts: now,
    op: 'archive',
    archiveId,
    assetId: asset.id,
    detail: `${asset.kind} "${asset.name}" moved from ${originalPath}`,
  });

  return manifest;
}
