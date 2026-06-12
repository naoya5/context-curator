// archive-move.ts — shared moveAsset helper for archive and restore (DESIGN.md §8.2)
// The EXDEV fallback (copy+verify+rm) is isolated here — the only place in the codebase
// that may call unlink/rm on user-owned files.
import { rename, copyFile, readFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Recursively copy a directory tree */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

/** Basic integrity check: dest must have at least as many entries as src */
async function verifyDirCopy(src: string, dest: string): Promise<void> {
  const srcEntries = (await readdir(src, { recursive: true })) as string[];
  const destEntries = (await readdir(dest, { recursive: true })) as string[];
  if (destEntries.length < srcEntries.length) {
    throw new Error(
      `Directory copy verification failed: src has ${srcEntries.length} entries, ` +
        `dest has ${destEntries.length}`,
    );
  }
}

/**
 * Move src to dest using rename.
 * Falls back to copy+verify+rm on EXDEV (cross-device) error.
 * This is the ONLY location in the codebase where unlink/rm is called.
 */
export async function moveAsset(src: string, dest: string): Promise<void> {
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;

    // EXDEV fallback: copy + verify + rm
    const s = await stat(src);
    if (s.isDirectory()) {
      await copyDirRecursive(src, dest);
      await verifyDirCopy(src, dest);
      // Allowed rm: remove original directory only after verified cross-device copy
      const { rm } = await import('node:fs/promises');
      await rm(src, { recursive: true, force: false });
    } else {
      await copyFile(src, dest);
      // Verify byte-for-byte equality
      const srcBuf = await readFile(src);
      const destBuf = await readFile(dest);
      if (!srcBuf.equals(destBuf)) {
        throw new Error(`File copy verification failed for "${src}" → "${dest}"`);
      }
      // Allowed rm: remove original file only after verified cross-device copy
      const { unlink } = await import('node:fs/promises');
      await unlink(src);
    }
  }
}
